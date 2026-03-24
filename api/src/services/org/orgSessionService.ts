import { signPayload, verifyPayload } from '../pilot/pilotSessionService.js';

export type OrgWebSession = {
  actorUserId: string;
  githubLogin: string;
  issuedAt: string;
  expiresAt: string;
};

export type IssueOrgWebSessionInput = {
  actorUserId: string;
  githubLogin: string;
};

export class OrgSessionService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(input?: {
    secret?: string;
    ttlSeconds?: number;
    now?: () => Date;
  }) {
    this.secret = input?.secret ?? process.env.ORG_SESSION_SECRET ?? 'dev-insecure-org-session-secret';
    this.ttlSeconds = input?.ttlSeconds ?? 60 * 60 * 12;
    this.now = input?.now ?? (() => new Date());
  }

  issueSession(input: IssueOrgWebSessionInput): string {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlSeconds * 1000);
    return signPayload(this.secret, {
      actorUserId: input.actorUserId,
      githubLogin: input.githubLogin,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
  }

  readSession(token: string): OrgWebSession | null {
    const payload = verifyPayload<OrgWebSession>(this.secret, token);
    if (!payload) return null;
    if (new Date(payload.expiresAt).getTime() <= this.now().getTime()) {
      return null;
    }
    return payload;
  }
}
