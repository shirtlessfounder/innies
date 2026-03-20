import { createHmac, timingSafeEqual } from 'node:crypto';

export type PilotSessionKind = 'darryn_self' | 'admin_self' | 'admin_impersonation';

export type PilotSession = {
  sessionKind: PilotSessionKind;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  actorOrgId: string | null;
  effectiveOrgId: string;
  effectiveOrgSlug: string | null;
  effectiveOrgName: string | null;
  githubLogin: string | null;
  userEmail: string | null;
  impersonatedUserId: string | null;
  issuedAt: string;
  expiresAt: string;
};

export class PilotSessionService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(input: {
    secret: string;
    ttlSeconds?: number;
    now?: () => Date;
  }) {
    this.secret = input.secret;
    this.ttlSeconds = input.ttlSeconds ?? 60 * 60 * 12;
    this.now = input.now ?? (() => new Date());
  }

  issueSession(input: Omit<PilotSession, 'issuedAt' | 'expiresAt'>): string {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlSeconds * 1000);
    return signPayload(this.secret, {
      ...input,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
  }

  readSession(token: string): PilotSession | null {
    const payload = verifyPayload<PilotSession>(this.secret, token);
    if (!payload) return null;
    if (new Date(payload.expiresAt).getTime() <= this.now().getTime()) {
      return null;
    }
    return payload;
  }

  readTokenFromRequest(req: {
    header(name: string): string | undefined;
  }): string | null {
    const auth = req.header('authorization');
    if (auth) {
      const match = auth.match(/^\s*bearer\s+(.+)\s*$/i);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    const cookieHeader = req.header('cookie');
    if (!cookieHeader) return null;
    for (const entry of cookieHeader.split(';')) {
      const [rawName, ...rawValue] = entry.trim().split('=');
      if (rawName === 'innies_pilot_session') {
        return rawValue.join('=').trim() || null;
      }
    }
    return null;
  }
}

export function signPayload(secret: string, payload: Record<string, unknown>): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signMessage(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyPayload<T>(secret: string, token: string): T | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expectedSignature = signMessage(secret, encodedPayload);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    return JSON.parse(base64UrlDecode(encodedPayload)) as T;
  } catch {
    return null;
  }
}

function signMessage(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}
