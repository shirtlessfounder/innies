import { AppError } from '../../utils/errors.js';
import { signPayload, verifyPayload } from '../pilot/pilotSessionService.js';
import type { OrgAuthResolution } from '../../repos/orgAccessRepository.js';
import type { OrgSessionService } from './orgSessionService.js';

type IdentityRepositoryLike = {
  ensureUser(input: { email: string; displayName?: string | null }): Promise<{ id: string; email: string }>;
};

type OrgAccessRepositoryLike = {
  upsertGithubLogin(userId: string, githubLogin: string): Promise<void>;
  findAuthResolutionBySlugAndGithubLogin(input: {
    orgSlug: string;
    githubLogin: string;
  }): Promise<OrgAuthResolution>;
};

type SessionServiceLike = Pick<OrgSessionService, 'issueSession'>;

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

function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

function selectVerifiedEmail(emails: GithubEmail[]): string | null {
  const primaryVerified = emails.find((entry) => entry.primary && entry.verified);
  if (primaryVerified?.email) {
    return primaryVerified.email;
  }
  const anyVerified = emails.find((entry) => entry.verified);
  return anyVerified?.email ?? null;
}

function readOrgSlugFromReturnTo(returnTo: string | null): string | null {
  if (!returnTo) return null;
  const match = returnTo.match(/^\/([^/?#]+)$/);
  return match?.[1] ? match[1].trim().toLowerCase() : null;
}

export class OrgGithubAuthService {
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly input: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    stateSecret: string;
    identityRepository: IdentityRepositoryLike;
    orgAccessRepository: OrgAccessRepositoryLike;
    sessionService: SessionServiceLike;
    now?: () => Date;
    stateTtlSeconds?: number;
    fetchImpl?: typeof fetch;
  }) {
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
      actorUserId: string;
      githubLogin: string;
    };
    authResolution: OrgAuthResolution | null;
    returnTo: string | null;
  }> {
    const state = this.readOauthState(input.state);
    if (!state) {
      throw new AppError('invalid_request', 400, 'Invalid GitHub OAuth state');
    }

    const accessToken = await this.exchangeCodeForAccessToken(input.code);
    const githubUser = await this.fetchGithubUser(accessToken);
    const githubEmails = await this.fetchGithubEmails(accessToken);
    const verifiedEmail = selectVerifiedEmail(githubEmails);

    if (!verifiedEmail) {
      throw new AppError('forbidden', 403, 'GitHub user does not have a verified email for org auth');
    }

    const normalizedGithubLogin = normalizeGithubLogin(githubUser.login);
    const user = await this.input.identityRepository.ensureUser({
      email: verifiedEmail,
      displayName: githubUser.name ?? githubUser.login
    });

    await this.input.orgAccessRepository.upsertGithubLogin(user.id, normalizedGithubLogin);

    const requestedOrgSlug = readOrgSlugFromReturnTo(state.returnTo);
    const authResolution = requestedOrgSlug
      ? await this.input.orgAccessRepository.findAuthResolutionBySlugAndGithubLogin({
        orgSlug: requestedOrgSlug,
        githubLogin: normalizedGithubLogin
      })
      : null;

    const session = {
      actorUserId: user.id,
      githubLogin: normalizedGithubLogin
    };
    const sessionToken = this.input.sessionService.issueSession(session);

    return {
      sessionToken,
      session,
      authResolution,
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
}
