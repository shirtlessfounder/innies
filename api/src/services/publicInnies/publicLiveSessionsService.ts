import type { SqlValue } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';
import { sha256Hex } from '../../utils/hash.js';
import { sanitizePublicText, stringifyPublicToolPayload } from './publicTextSanitizer.js';
import type {
  PublicLiveSession,
  PublicLiveSessionEntry,
  PublicLiveSessionsFeed,
  PublicLiveSessionsServiceDeps
} from './publicLiveSessionsTypes.js';

const PUBLIC_ORG_SLUG = 'innies';
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const TRANSCRIPT_HISTORY_WINDOW_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 24;
const MAX_SESSION_ENTRIES = 120;

type OrgRow = {
  id: string;
};

type SessionRow = {
  session_key: string;
  session_type: 'cli' | 'openclaw';
  started_at: string | Date;
  ended_at: string | Date;
  last_activity_at: string | Date;
  provider_set: string[];
  model_set: string[];
};

type AttemptRow = {
  session_key: string;
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  api_key_id: string | null;
  provider: string;
  model: string;
  started_at: string | Date;
  completed_at: string | Date | null;
  route_decision: Record<string, unknown> | null;
};

type MessageRow = {
  request_attempt_archive_id: string;
  side: 'request' | 'response';
  ordinal: number;
  role: string | null;
  normalized_payload: Record<string, unknown> | null;
};

type SessionAttempt = AttemptRow & {
  eventAtIso: string;
};

type NormalizedPayload = {
  role: string | null;
  content: unknown[];
};

export class PublicLiveSessionsService {
  constructor(private readonly deps: PublicLiveSessionsServiceDeps) {}

  async listFeed(): Promise<PublicLiveSessionsFeed> {
    const now = this.deps.now?.() ?? new Date();
    const generatedAt = now.toISOString();
    const orgId = await this.findOrgId(PUBLIC_ORG_SLUG);
    if (!orgId) {
      return {
        orgSlug: sanitizeString(PUBLIC_ORG_SLUG),
        generatedAt,
        sessions: []
      };
    }

    const excludedApiKeyIds = await this.resolveExcludedApiKeyIds();
    const activeSessions = await this.loadActiveSessions(orgId, now);
    if (activeSessions.length === 0) {
      return {
        orgSlug: sanitizeString(PUBLIC_ORG_SLUG),
        generatedAt,
        sessions: []
      };
    }

    const attempts = await this.loadRecentAttempts(
      activeSessions.map((session) => session.session_key),
      now
    );
    const includedAttempts = attempts.filter((attempt) => !excludedApiKeyIds.has(attempt.api_key_id ?? ''));
    const archiveIds = includedAttempts.map((attempt) => attempt.request_attempt_archive_id);
    const messageRows = archiveIds.length > 0
      ? await this.loadMessages(archiveIds)
      : [];

    const messagesByArchiveId = new Map<string, MessageRow[]>();
    for (const row of messageRows) {
      const existing = messagesByArchiveId.get(row.request_attempt_archive_id) ?? [];
      existing.push(row);
      messagesByArchiveId.set(row.request_attempt_archive_id, existing);
    }

    const attemptsBySession = new Map<string, SessionAttempt[]>();
    for (const attempt of includedAttempts) {
      const existing = attemptsBySession.get(attempt.session_key) ?? [];
      existing.push(attempt);
      attemptsBySession.set(attempt.session_key, existing);
    }

    const sessions: PublicLiveSession[] = [];
    for (const session of activeSessions) {
      const entries = this.buildSessionEntries(
        attemptsBySession.get(session.session_key) ?? [],
        messagesByArchiveId
      );
      if (entries.length === 0) {
        continue;
      }

      sessions.push({
        sessionKey: sanitizeString(session.session_key),
        sessionType: session.session_type,
        startedAt: toIso(session.started_at),
        endedAt: toIso(session.ended_at),
        lastActivityAt: toIso(session.last_activity_at),
        providerSet: sanitizeStringArray(session.provider_set),
        modelSet: sanitizeStringArray(session.model_set),
        entries
      });
    }

    return {
      orgSlug: sanitizeString(PUBLIC_ORG_SLUG),
      generatedAt,
      sessions: sessions.slice(0, MAX_SESSIONS)
    };
  }

  private async findOrgId(slug: string): Promise<string | null> {
    const sql = `
      select id
      from ${TABLES.orgs}
      where slug = $1
      limit 1
    `;
    const result = await this.deps.sql.query<OrgRow>(sql, [slug]);
    return result.rows[0]?.id ?? null;
  }

  private async resolveExcludedApiKeyIds(): Promise<Set<string>> {
    const env = this.deps.env ?? process.env;
    const raw = env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS ?? '';
    const tokens = raw
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);

    const ids = new Set<string>();
    for (const token of tokens) {
      const id = await this.deps.apiKeys.findIdByHash(sha256Hex(token));
      if (id) {
        ids.add(id);
      }
    }
    return ids;
  }

  private async loadActiveSessions(orgId: string, now: Date): Promise<SessionRow[]> {
    const activeSince = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
    const params: SqlValue[] = [orgId, activeSince, MAX_SESSIONS];
    const sql = `
      select
        session_key,
        session_type,
        started_at,
        ended_at,
        last_activity_at,
        provider_set,
        model_set
      from ${TABLES.adminSessions}
      where org_id = $1
        and last_activity_at >= $2::timestamptz
      order by last_activity_at desc, session_key desc
      limit $3
    `;
    const result = await this.deps.sql.query<SessionRow>(sql, params);
    return result.rows
      .filter((row) => toMillis(row.last_activity_at) >= Date.parse(activeSince))
      .sort((left, right) =>
        toMillis(right.last_activity_at) - toMillis(left.last_activity_at)
        || String(right.session_key).localeCompare(String(left.session_key))
      )
      .slice(0, MAX_SESSIONS);
  }

  private async loadRecentAttempts(sessionKeys: string[], now: Date): Promise<SessionAttempt[]> {
    if (sessionKeys.length === 0) {
      return [];
    }

    const historySince = new Date(now.getTime() - TRANSCRIPT_HISTORY_WINDOW_MS).toISOString();
    const params: SqlValue[] = [sessionKeys, historySince];
    const sql = `
      select
        sa.session_key,
        sa.request_attempt_archive_id,
        a.request_id,
        a.attempt_no,
        a.api_key_id,
        a.provider,
        a.model,
        a.started_at,
        a.completed_at,
        re.route_decision
      from ${TABLES.adminSessionAttempts} sa
      inner join ${TABLES.requestAttemptArchives} a
        on a.id = sa.request_attempt_archive_id
      left join ${TABLES.routingEvents} re
        on re.org_id = a.org_id
        and re.request_id = a.request_id
        and re.attempt_no = a.attempt_no
      where sa.session_key::text = any($1::text[])
        and coalesce(a.completed_at, a.started_at) >= $2::timestamptz
      order by
        array_position($1::text[], sa.session_key::text),
        coalesce(a.completed_at, a.started_at) asc,
        a.request_id asc,
        a.attempt_no asc
    `;
    const result = await this.deps.sql.query<AttemptRow>(sql, params);
    return result.rows
      .map((row) => ({
        ...row,
        eventAtIso: toIso(row.completed_at ?? row.started_at)
      }))
      .filter((row) => Date.parse(row.eventAtIso) >= Date.parse(historySince));
  }

  private async loadMessages(archiveIds: string[]): Promise<MessageRow[]> {
    const sql = `
      select
        ram.request_attempt_archive_id,
        ram.side,
        ram.ordinal,
        ram.role,
        mb.normalized_payload
      from ${TABLES.requestAttemptMessages} ram
      inner join ${TABLES.messageBlobs} mb
        on mb.id = ram.message_blob_id
      where ram.request_attempt_archive_id::text = any($1::text[])
      order by
        array_position($1::text[], ram.request_attempt_archive_id::text),
        case ram.side when 'request' then 0 when 'response' then 1 else 2 end asc,
        ram.ordinal asc
    `;
    const result = await this.deps.sql.query<MessageRow>(sql, [archiveIds]);
    return result.rows;
  }

  private buildSessionEntries(
    attempts: SessionAttempt[],
    messagesByArchiveId: Map<string, MessageRow[]>
  ): PublicLiveSessionEntry[] {
    const entries: PublicLiveSessionEntry[] = [];
    let previousProvider: string | null = null;

    for (const attempt of attempts) {
      const currentProvider = readString(attempt.provider);
      if (previousProvider && currentProvider && previousProvider !== currentProvider) {
        const routeDecision = isRecord(attempt.route_decision) ? attempt.route_decision : null;
        entries.push({
          kind: 'provider_switch',
          at: attempt.eventAtIso,
          fromProvider: sanitizeNullableString(readString(routeDecision?.provider_fallback_from) ?? previousProvider),
          toProvider: sanitizeString(currentProvider),
          reason: sanitizeNullableString(readString(routeDecision?.provider_selection_reason))
        });
      }
      previousProvider = currentProvider ?? previousProvider;

      const messageRows = messagesByArchiveId.get(attempt.request_attempt_archive_id) ?? [];
      for (const row of messageRows) {
        entries.push(...shapeMessageEntries({
          at: attempt.eventAtIso,
          row
        }));
      }
    }

    return entries.length > MAX_SESSION_ENTRIES
      ? entries.slice(-MAX_SESSION_ENTRIES)
      : entries;
  }
}

function shapeMessageEntries(input: {
  at: string;
  row: MessageRow;
}): PublicLiveSessionEntry[] {
  const payload = normalizePayload(input.row.normalized_payload, input.row.role);
  if (!payload || payload.role === 'system') {
    return [];
  }

  const entries: PublicLiveSessionEntry[] = [];
  let textBuffer: string[] = [];

  const flushTextBuffer = (): void => {
    if (textBuffer.length === 0) {
      return;
    }
    const text = textBuffer.join('\n').trim();
    textBuffer = [];
    if (text.length === 0) {
      return;
    }

    if (payload.role === 'user') {
      entries.push({
        kind: 'user',
        at: input.at,
        text
      });
      return;
    }

    if (payload.role === 'assistant') {
      entries.push({
        kind: 'assistant_final',
        at: input.at,
        text
      });
    }
  };

  for (const part of payload.content) {
    if (!isRecord(part) || typeof part.type !== 'string') {
      continue;
    }

    if (part.type === 'text') {
      const shaped = shapePublicText(readString(part.text));
      if (shaped) {
        textBuffer.push(shaped);
      }
      continue;
    }

    flushTextBuffer();

    if (part.type === 'tool_call') {
      const payloadText = stringifyPublicToolPayload(part.arguments);
      if (payloadText.length === 0) {
        continue;
      }
      entries.push({
        kind: 'tool_call',
        at: input.at,
        toolCallId: sanitizeNullableString(readString(part.id)),
        toolName: sanitizeNullableString(readString(part.name)),
        payloadText
      });
      continue;
    }

    if (part.type === 'tool_result') {
      const payloadText = stringifyPublicToolPayload(part.content);
      if (payloadText.length === 0) {
        continue;
      }
      entries.push({
        kind: 'tool_result',
        at: input.at,
        toolUseId: sanitizeNullableString(readString(part.toolUseId)),
        payloadText
      });
    }
  }

  flushTextBuffer();
  return entries;
}

function normalizePayload(value: unknown, fallbackRole: string | null): NormalizedPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    role: readString(value.role) ?? fallbackRole,
    content: Array.isArray(value.content) ? value.content : []
  };
}

function shapePublicText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const strippedSse = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isSseNoiseLine(line))
    .join('\n')
    .trim();

  if (strippedSse.length === 0 || isJsonOnlyText(strippedSse)) {
    return null;
  }

  const sanitized = sanitizePublicText(strippedSse).trim();
  return sanitized.length > 0 ? sanitized : null;
}

function isJsonOnlyText(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function isSseNoiseLine(value: string): boolean {
  return value === '[DONE]'
    || value.startsWith(':')
    || value.startsWith('data:')
    || value.startsWith('event:')
    || value.startsWith('id:')
    || value.startsWith('retry:');
}

function sanitizeString(value: string): string {
  return sanitizePublicText(value).trim();
}

function sanitizeNullableString(value: string | null): string | null {
  return value == null ? null : sanitizeString(value);
}

function sanitizeStringArray(values: string[]): string[] {
  return values.map((value) => sanitizeString(value));
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function toMillis(value: string | Date): number {
  return new Date(value).getTime();
}
