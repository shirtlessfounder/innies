import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PilotIdentityRepository } from '../repos/pilotIdentityRepository.js';
import { AppError } from '../utils/errors.js';

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_USER_AGENT = 'innies-pilot-auth';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_VIEWER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

export const PILOT_SESSION_COOKIE_NAME = 'innies_pilot_session';

export type PilotSessionMode = 'darryn' | 'admin';
export type PilotSessionContextKind = 'darryn_self' | 'admin_self' | 'admin_impersonation';
export type PilotSessionActorRole = 'buyer' | 'admin';

export type PilotSession = {
  contextKind: PilotSessionContextKind;
  actor: {
    userId: string;
    githubLogin: string;
    role: PilotSessionActorRole;
  };
  active: {
    userId: string;
    githubLogin: string;
    orgId: string;
    orgSlug?: string;
  };
  issuedAt: string;
  expiresAt: string;
};

export type PilotSessionIssueInput = {
  contextKind: PilotSessionContextKind;
  actor: PilotSession['actor'];
  active: PilotSession['active'];
};

export type GithubViewer = {
  githubUserId: string;
  githubLogin: string;
  email: string;
  displayName?: string | null;
};

export type GithubOauthClient = {
  exchangeCodeForViewer(input: {
    code: string;
    redirectUri?: string;
  }): Promise<GithubViewer>;
};

type PilotSessionDeps = {
  identities: Pick<PilotIdentityRepository, 'ensureOrg' | 'ensureUser' | 'ensureMembership' | 'findOrgBySlug' | 'upsertGithubIdentity' | 'findGithubIdentityByLogin'>;
  github: GithubOauthClient;
  sessionSecret: string;
  darrynGithubAllowlist: string[];
  adminGithubAllowlist: string[];
  sessionTtlMs?: number;
  now?: () => Date;
};

type PilotSessionTokenEnvelope = {
  version: 1;
  session: PilotSession;
};

export function createGithubOauthClientFromEnv(): GithubOauthClient {
  return {
    async exchangeCodeForViewer(input) {
      const clientId = process.env.PILOT_GITHUB_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.PILOT_GITHUB_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET;
      const redirectUri = input.redirectUri ?? process.env.PILOT_GITHUB_REDIRECT_URI ?? process.env.GITHUB_REDIRECT_URI;

      if (!clientId || !clientSecret) {
        throw new AppError('pilot_github_oauth_not_configured', 500, 'Pilot GitHub OAuth is not configured');
      }

      const tokenRequest = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code
      });
      if (redirectUri) {
        tokenRequest.set('redirect_uri', redirectUri);
      }

      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: tokenRequest
      });
      if (!tokenResponse.ok) {
        throw new AppError('github_oauth_exchange_failed', 502, 'GitHub OAuth exchange failed');
      }

      const tokenPayload = await tokenResponse.json() as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenPayload.access_token) {
        throw new AppError(
          'github_oauth_exchange_failed',
          502,
          tokenPayload.error_description ?? tokenPayload.error ?? 'GitHub OAuth exchange failed'
        );
      }

      const authHeaders = {
        accept: GITHUB_ACCEPT,
        authorization: `Bearer ${tokenPayload.access_token}`,
        'user-agent': GITHUB_USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION
      };

      const viewerResponse = await fetch(GITHUB_VIEWER_URL, { headers: authHeaders });
      if (!viewerResponse.ok) {
        throw new AppError('github_oauth_viewer_failed', 502, 'GitHub viewer lookup failed');
      }

      const viewer = await viewerResponse.json() as {
        id?: number | string;
        login?: string;
        email?: string | null;
        name?: string | null;
      };

      let email = viewer.email ?? null;
      if (!email) {
        const emailsResponse = await fetch(GITHUB_EMAILS_URL, { headers: authHeaders });
        if (emailsResponse.ok) {
          const emails = await emailsResponse.json() as Array<{
            email?: string;
            primary?: boolean;
            verified?: boolean;
          }>;
          const selected = emails.find((entry) => entry.primary && entry.verified)
            ?? emails.find((entry) => entry.verified)
            ?? emails[0];
          email = selected?.email ?? null;
        }
      }

      if (!viewer.id || !viewer.login || !email) {
        throw new AppError('github_identity_incomplete', 403, 'GitHub account must expose login and verified email');
      }

      return {
        githubUserId: String(viewer.id),
        githubLogin: normalizeGithubLogin(viewer.login),
        email,
        displayName: viewer.name ?? null
      };
    }
  };
}

export class PilotSessionService {
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;
  private readonly darrynAllowlist: Set<string>;
  private readonly adminAllowlist: Set<string>;

  constructor(private readonly deps: PilotSessionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.darrynAllowlist = new Set(deps.darrynGithubAllowlist.map(normalizeGithubLogin));
    this.adminAllowlist = new Set(deps.adminGithubAllowlist.map(normalizeGithubLogin));
  }

  issueToken(input: PilotSessionIssueInput): string {
    const issuedAt = this.now();
    const session: PilotSession = {
      contextKind: input.contextKind,
      actor: {
        userId: input.actor.userId,
        githubLogin: normalizeGithubLogin(input.actor.githubLogin),
        role: input.actor.role
      },
      active: {
        userId: input.active.userId,
        githubLogin: normalizeGithubLogin(input.active.githubLogin),
        orgId: input.active.orgId,
        orgSlug: input.active.orgSlug
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.sessionTtlMs).toISOString()
    };
    return this.encodeSession(session);
  }

  readFromToken(token: string): PilotSession {
    const [payloadSegment, signatureSegment, extra] = token.split('.');
    if (!payloadSegment || !signatureSegment || extra) {
      throw new AppError('unauthorized', 401, 'Invalid pilot session');
    }

    const actualSignature = this.decodeBase64Url(signatureSegment);
    const expectedSignature = this.sign(payloadSegment);
    if (actualSignature.length !== expectedSignature.length
      || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new AppError('unauthorized', 401, 'Invalid pilot session');
    }

    const envelope = JSON.parse(this.decodeBase64Url(payloadSegment).toString('utf8')) as PilotSessionTokenEnvelope;
    if (envelope.version !== 1) {
      throw new AppError('unauthorized', 401, 'Invalid pilot session');
    }
    if (new Date(envelope.session.expiresAt).getTime() <= this.now().getTime()) {
      throw new AppError('unauthorized', 401, 'Pilot session expired');
    }

    return envelope.session;
  }

  readFromRequest(req: Request): PilotSession {
    const session = this.readFromToken(this.readTokenFromRequest(req));
    req.pilotSession = session;
    return session;
  }

  buildSessionCookie(token: string): string {
    const parts = [
      `${PILOT_SESSION_COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`
    ];
    if (process.env.NODE_ENV === 'production') {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  async createSessionFromGithubCallback(input: {
    mode: PilotSessionMode;
    code: string;
    redirectUri?: string;
  }): Promise<{
    token: string;
    session: PilotSession;
  }> {
    const viewer = await this.deps.github.exchangeCodeForViewer({
      code: input.code,
      redirectUri: input.redirectUri
    });

    const githubLogin = normalizeGithubLogin(viewer.githubLogin);
    if (input.mode === 'darryn') {
      if (!this.darrynAllowlist.has(githubLogin)) {
        throw new AppError('forbidden', 403, 'GitHub login is not allowlisted for Darryn pilot access');
      }

      const org = await this.deps.identities.ensureOrg({
        slug: 'fnf',
        name: 'Friends & Family'
      });
      const user = await this.deps.identities.ensureUser({
        email: viewer.email,
        displayName: viewer.displayName ?? githubLogin
      });
      await this.deps.identities.ensureMembership({
        orgId: org.id,
        userId: user.id,
        role: 'buyer'
      });
      await this.deps.identities.upsertGithubIdentity({
        userId: user.id,
        githubUserId: viewer.githubUserId,
        githubLogin,
        githubEmail: viewer.email
      });

      const token = this.issueToken({
        contextKind: 'darryn_self',
        actor: {
          userId: user.id,
          githubLogin,
          role: 'buyer'
        },
        active: {
          userId: user.id,
          githubLogin,
          orgId: org.id,
          orgSlug: org.slug
        }
      });

      return { token, session: this.readFromToken(token) };
    }

    if (!this.adminAllowlist.has(githubLogin)) {
      throw new AppError('forbidden', 403, 'GitHub login is not allowlisted for admin pilot access');
    }

    const inniesOrg = await this.deps.identities.findOrgBySlug('innies');
    if (!inniesOrg) {
      throw new AppError('pilot_admin_org_missing', 409, 'Innies org is missing for pilot admin sessions');
    }

    const user = await this.deps.identities.ensureUser({
      email: viewer.email,
      displayName: viewer.displayName ?? githubLogin
    });
    await this.deps.identities.ensureMembership({
      orgId: inniesOrg.id,
      userId: user.id,
      role: 'admin'
    });
    await this.deps.identities.upsertGithubIdentity({
      userId: user.id,
      githubUserId: viewer.githubUserId,
      githubLogin,
      githubEmail: viewer.email
    });

    const token = this.issueToken({
      contextKind: 'admin_self',
      actor: {
        userId: user.id,
        githubLogin,
        role: 'admin'
      },
      active: {
        userId: user.id,
        githubLogin,
        orgId: inniesOrg.id,
        orgSlug: inniesOrg.slug
      }
    });

    return { token, session: this.readFromToken(token) };
  }

  async impersonateByGithubLogin(sessionToken: string, githubLogin: string): Promise<{
    token: string;
    session: PilotSession;
  }> {
    const current = this.readFromToken(sessionToken);
    if (current.actor.role !== 'admin') {
      throw new AppError('forbidden', 403, 'Only admins can impersonate Darryn');
    }

    const normalizedLogin = normalizeGithubLogin(githubLogin);
    if (!this.darrynAllowlist.has(normalizedLogin)) {
      throw new AppError('forbidden', 403, 'Admins can only impersonate allowlisted Darryn pilot users');
    }

    const identity = await this.deps.identities.findGithubIdentityByLogin(normalizedLogin);
    if (!identity) {
      throw new AppError('not_found', 404, 'Pilot GitHub identity not found for impersonation');
    }

    const fnfOrg = await this.deps.identities.ensureOrg({
      slug: 'fnf',
      name: 'Friends & Family'
    });

    const token = this.issueToken({
      contextKind: 'admin_impersonation',
      actor: current.actor,
      active: {
        userId: identity.user_id,
        githubLogin: identity.github_login,
        orgId: fnfOrg.id,
        orgSlug: fnfOrg.slug
      }
    });

    return { token, session: this.readFromToken(token) };
  }

  async impersonateFromRequest(req: Request, githubLogin: string): Promise<{
    token: string;
    session: PilotSession;
  }> {
    return this.impersonateByGithubLogin(this.readTokenFromRequest(req), githubLogin);
  }

  async clearImpersonation(sessionToken: string): Promise<{
    token: string;
    session: PilotSession;
  }> {
    const current = this.readFromToken(sessionToken);
    if (current.actor.role !== 'admin') {
      throw new AppError('forbidden', 403, 'Only admins can clear pilot impersonation');
    }
    if (current.contextKind !== 'admin_impersonation') {
      return { token: sessionToken, session: current };
    }

    const inniesOrg = await this.deps.identities.findOrgBySlug('innies');
    if (!inniesOrg) {
      throw new AppError('pilot_admin_org_missing', 409, 'Innies org is missing for pilot admin sessions');
    }

    const token = this.issueToken({
      contextKind: 'admin_self',
      actor: current.actor,
      active: {
        userId: current.actor.userId,
        githubLogin: current.actor.githubLogin,
        orgId: inniesOrg.id,
        orgSlug: inniesOrg.slug
      }
    });

    return { token, session: this.readFromToken(token) };
  }

  async clearImpersonationFromRequest(req: Request): Promise<{
    token: string;
    session: PilotSession;
  }> {
    return this.clearImpersonation(this.readTokenFromRequest(req));
  }

  private encodeSession(session: PilotSession): string {
    const envelope: PilotSessionTokenEnvelope = {
      version: 1,
      session
    };
    const payloadSegment = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
    const signatureSegment = this.sign(payloadSegment).toString('base64url');
    return `${payloadSegment}.${signatureSegment}`;
  }

  private readTokenFromRequest(req: Request): string {
    const cookieToken = readCookie(req.header('cookie'), PILOT_SESSION_COOKIE_NAME);
    if (cookieToken) {
      return cookieToken;
    }

    const authorization = req.header('authorization');
    if (authorization) {
      const match = authorization.match(/^\s*bearer\s+(.+)\s*$/i);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    throw new AppError('unauthorized', 401, 'Missing pilot session');
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.deps.sessionSecret).update(payload).digest();
  }

  private decodeBase64Url(value: string): Buffer {
    try {
      return Buffer.from(value, 'base64url');
    } catch {
      throw new AppError('unauthorized', 401, 'Invalid pilot session');
    }
  }
}

function normalizeGithubLogin(input: string): string {
  return input.trim().toLowerCase();
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const rawEntry of cookieHeader.split(';')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1).trim();
    if (key === name) {
      return value;
    }
  }
  return null;
}
