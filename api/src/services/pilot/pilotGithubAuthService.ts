import { AppError } from '../../utils/errors.js';
import { PilotSessionService, signPayload, verifyPayload } from './pilotSessionService.js';

type IdentityRepositoryLike = {
  ensureOrg(input: { slug: string; name: string }): Promise<{ id: string; slug: string; name: string }>;
  ensureUser(input: { email: string; displayName?: string | null }): Promise<{ id: string; email: string }>;
  ensureMembership(input: { orgId: string; userId: string; role: 'buyer' | 'seller' | 'admin' }): Promise<unknown>;
};

type SessionServiceLike = Pick<PilotSessionService, 'issueSession'>;

type GithubUser = {
  login: string;
  email: string | null;
  name: string | null;
};

type GithubEmail = {
  email: string;
  primary?: boolean;
  verified?: boolean;
};

type SignedOauthState = {
  returnTo: string | null;
  issuedAt: string;
  expiresAt: string;
};

export class PilotGithubAuthService {
  private readonly allowlistedLogins: Set<string>;
  private readonly allowlistedEmails: Set<string>;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly input: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    allowlistedLogins: string[];
    allowlistedEmails: string[];
    identityRepository: IdentityRepositoryLike;
    sessionService: SessionServiceLike;
    targetOrgSlug: string;
    targetOrgName: string;
    stateSecret: string;
    now?: () => Date;
    stateTtlSeconds?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.allowlistedLogins = new Set(input.allowlistedLogins.map(normalizeLogin));
    this.allowlistedEmails = new Set(input.allowlistedEmails.map(normalizeEmail));
    this.now = input.now ?? (() => new Date());
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  createOauthState(input: {
    returnTo?: string | null;
  }): string {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + (this.input.stateTtlSeconds ?? 60 * 10) * 1000);
    return signPayload(this.input.stateSecret, {
      returnTo: input.returnTo ?? null,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
  }

  buildAuthorizationUrl(input: {
    returnTo?: string | null;
  }): string {
    const state = this.createOauthState(input);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.input.clientId);
    url.searchParams.set('redirect_uri', this.input.callbackUrl);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async finishOauthCallback(input: {
    code: string;
    state: string;
  }): Promise<{
    sessionToken: string;
    session: {
      sessionKind: 'darryn_self';
      actorUserId: string;
      effectiveOrgId: string;
      githubLogin: string;
      userEmail: string;
    };
    returnTo: string | null;
  }> {
    const state = this.readOauthState(input.state);
    if (!state) {
      throw new AppError('invalid_request', 400, 'Invalid GitHub OAuth state');
    }

    const accessToken = await this.exchangeCodeForAccessToken(input.code);
    const githubUser = await this.fetchGithubUser(accessToken);
    const githubEmails = await this.fetchGithubEmails(accessToken);
    const verifiedPrimaryEmail = selectVerifiedPrimaryEmail(githubUser, githubEmails);
    const fallbackEmail = normalizeOptionalEmail(githubUser.email);

    if (!this.isAllowlisted(githubUser.login, verifiedPrimaryEmail)) {
      throw new AppError('forbidden', 403, 'GitHub user is not allowlisted for the pilot');
    }
    const sessionEmail = verifiedPrimaryEmail ?? fallbackEmail;
    if (!sessionEmail) {
      throw new AppError('forbidden', 403, 'GitHub user does not have a verified email for the pilot');
    }

    const org = await this.input.identityRepository.ensureOrg({
      slug: this.input.targetOrgSlug,
      name: this.input.targetOrgName
    });
    const user = await this.input.identityRepository.ensureUser({
      email: sessionEmail,
      displayName: githubUser.name ?? githubUser.login
    });
    await this.input.identityRepository.ensureMembership({
      orgId: org.id,
      userId: user.id,
      role: 'buyer'
    });

    const session = {
      sessionKind: 'darryn_self' as const,
      actorUserId: user.id,
      actorApiKeyId: null,
      actorOrgId: org.id,
      effectiveOrgId: org.id,
      effectiveOrgSlug: org.slug,
      effectiveOrgName: org.name,
      githubLogin: githubUser.login,
      userEmail: sessionEmail,
      impersonatedUserId: null
    };
    const sessionToken = this.input.sessionService.issueSession(session);

    return {
      sessionToken,
      session: {
        sessionKind: session.sessionKind,
        actorUserId: user.id,
        effectiveOrgId: org.id,
        githubLogin: githubUser.login,
        userEmail: sessionEmail
      },
      returnTo: state.returnTo
    };
  }

  private readOauthState(token: string): SignedOauthState | null {
    const payload = verifyPayload<SignedOauthState>(this.input.stateSecret, token);
    if (!payload) return null;
    if (new Date(payload.expiresAt).getTime() <= this.now().getTime()) {
      return null;
    }
    return payload;
  }

  private async exchangeCodeForAccessToken(code: string): Promise<string> {
    const response = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: this.input.clientId,
        client_secret: this.input.clientSecret,
        code,
        redirect_uri: this.input.callbackUrl
      })
    });
    if (!response.ok) {
      throw new AppError('upstream_error', 502, 'GitHub token exchange failed');
    }

    const payload = await response.json() as { access_token?: string };
    if (!payload.access_token) {
      throw new AppError('upstream_error', 502, 'GitHub token exchange returned no access token');
    }
    return payload.access_token;
  }

  private async fetchGithubUser(accessToken: string): Promise<GithubUser> {
    const response = await this.fetchImpl('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      throw new AppError('upstream_error', 502, 'GitHub user lookup failed');
    }
    return await response.json() as GithubUser;
  }

  private async fetchGithubEmails(accessToken: string): Promise<GithubEmail[]> {
    const response = await this.fetchImpl('https://api.github.com/user/emails', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      throw new AppError('upstream_error', 502, 'GitHub email lookup failed');
    }
    return await response.json() as GithubEmail[];
  }

  private isAllowlisted(login: string, email: string | null): boolean {
    if (this.allowlistedLogins.has(normalizeLogin(login))) {
      return true;
    }
    if (email && this.allowlistedEmails.has(normalizeEmail(email))) {
      return true;
    }
    return false;
  }
}

function selectVerifiedPrimaryEmail(user: GithubUser, emails: GithubEmail[]): string | null {
  const primaryVerified = emails.find((email) => email.primary && email.verified);
  if (primaryVerified?.email) {
    return primaryVerified.email;
  }
  return null;
}

function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalEmail(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
