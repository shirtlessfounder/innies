export type SessionIdentitySource =
  | 'x-innies-session-id'
  | 'x-openclaw-session-id'
  | 'openclaw-session-id'
  | 'x-session-id'
  | 'metadata.openclaw_session_id'
  | 'payload.metadata.openclaw_session_id';

export type SessionIdentity = {
  sessionId: string | null;
  source: SessionIdentitySource | null;
};

type RequestLike = {
  header: (name: string) => string | undefined;
  body?: unknown;
};

const MAX_SESSION_ID_LENGTH = 256;

function normalizeSessionCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SESSION_ID_LENGTH) return null;
  return trimmed;
}

function readHeader(req: RequestLike, ...names: string[]): string | undefined {
  for (const name of names) {
    const raw = req.header(name);
    if (typeof raw !== 'string') continue;
    return raw;
  }
  return undefined;
}

function readBody(req: RequestLike): Record<string, unknown> | undefined {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return undefined;
  }
  return req.body as Record<string, unknown>;
}

function readMetadataSession(body: Record<string, unknown> | undefined, source: SessionIdentitySource): unknown {
  const metadata = source === 'metadata.openclaw_session_id'
    ? body?.metadata
    : (body?.payload as Record<string, unknown> | undefined)?.metadata;

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  return (metadata as Record<string, unknown>).openclaw_session_id;
}

function resolveFromCandidates(candidates: ReadonlyArray<readonly [SessionIdentitySource, unknown]>): SessionIdentity {
  for (const [source, candidate] of candidates) {
    const sessionId = normalizeSessionCandidate(candidate);
    if (sessionId) {
      return { sessionId, source };
    }
  }

  return { sessionId: null, source: null };
}

export function resolveSessionIdentity(req: RequestLike): SessionIdentity {
  const body = readBody(req);
  return resolveFromCandidates([
    ['x-innies-session-id', readHeader(req, 'x-innies-session-id')],
    ['x-openclaw-session-id', readHeader(req, 'x-openclaw-session-id')],
    ['openclaw-session-id', readHeader(req, 'openclaw-session-id')],
    ['x-session-id', readHeader(req, 'x-session-id')],
    ['metadata.openclaw_session_id', readMetadataSession(body, 'metadata.openclaw_session_id')],
    ['payload.metadata.openclaw_session_id', readMetadataSession(body, 'payload.metadata.openclaw_session_id')]
  ]);
}

export function resolveOpenClawSessionIdentity(req: RequestLike): SessionIdentity {
  const body = readBody(req);
  return resolveFromCandidates([
    ['x-openclaw-session-id', readHeader(req, 'x-openclaw-session-id')],
    ['openclaw-session-id', readHeader(req, 'openclaw-session-id')],
    ['x-session-id', readHeader(req, 'x-session-id')],
    ['metadata.openclaw_session_id', readMetadataSession(body, 'metadata.openclaw_session_id')],
    ['payload.metadata.openclaw_session_id', readMetadataSession(body, 'payload.metadata.openclaw_session_id')]
  ]);
}
