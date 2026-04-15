import { gunzipSync } from 'node:zlib';
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
const LEGACY_PUBLIC_ORG_SLUG = 'team-seller';
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const TRANSCRIPT_HISTORY_WINDOW_MS = 60 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 30;
const IDLE_TIMEOUT_SECONDS = ACTIVE_WINDOW_MS / 1000;
const HISTORY_WINDOW_SECONDS = TRANSCRIPT_HISTORY_WINDOW_MS / 1000;
const MAX_SESSIONS = 24;
const MAX_SESSION_ENTRIES = 120;
const MAX_DIRECT_ATTEMPTS = 400;
const MAX_DIRECT_SESSION_ATTEMPTS = 8;
const MAX_DIRECT_ROUTE_CANDIDATES = MAX_DIRECT_ATTEMPTS * 6;
const DEFAULT_EXCLUDED_BUYER_KEYS = [
  'REDACTED_EXCLUDED_BUYER_KEY'
];

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

type DirectAttemptRow = Omit<AttemptRow, 'session_key'> & {
  org_id: string;
};

type RawRequestBlobRow = {
  request_attempt_archive_id: string;
  encoding: 'gzip' | 'none';
  payload: Buffer;
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

type EntryDraft =
  {
    archiveId: string;
    kind: 'user' | 'assistant_final';
    at: string;
    text: string;
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
    const orgId = await this.findPublicOrgId();
    const emptyFeed = this.buildEmptyFeed(generatedAt);
    if (!orgId) {
      return emptyFeed;
    }

    const excludedApiKeyIds = await this.resolveExcludedApiKeyIds();
    const activeSessions = await this.loadActiveSessions(orgId, now);

    const attempts = await this.loadRecentAttempts(
      activeSessions.map((session) => session.session_key),
      now
    );
    const directAttempts = await this.loadRecentDirectAttempts(orgId, now);
    const includedAttempts = attempts.filter((attempt) => !excludedApiKeyIds.has(attempt.api_key_id ?? ''));
    const includedDirectAttempts = directAttempts.filter((attempt) => !excludedApiKeyIds.has(attempt.api_key_id ?? ''));
    const visibleDirectAttempts = selectVisibleDirectAttempts(includedDirectAttempts, now);
    const projectedArchiveIds = Array.from(new Set(includedAttempts.map((attempt) => attempt.request_attempt_archive_id)));
    const directArchiveIds = Array.from(new Set(visibleDirectAttempts.map((attempt) => attempt.request_attempt_archive_id)));
    const messageRows = [
      ...(projectedArchiveIds.length > 0 ? await this.loadMessages(projectedArchiveIds) : []),
      ...(directArchiveIds.length > 0 ? await this.loadDirectMessages(directArchiveIds) : [])
    ];

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
      const sessionAttempts = sortSessionAttempts(attemptsBySession.get(session.session_key) ?? []);
      const entries = this.buildSessionEntries(sessionAttempts, messagesByArchiveId);
      if (entries.length === 0) {
        continue;
      }

      sessions.push({
        sessionKey: sanitizeString(session.session_key),
        sessionType: session.session_type,
        displayTitle: buildDisplayTitle(session.session_type, session.session_key),
        startedAt: toIso(session.started_at),
        endedAt: toIso(session.ended_at),
        lastActivityAt: toIso(session.last_activity_at),
        currentProvider: findCurrentValue(sessionAttempts, 'provider'),
        currentModel: findCurrentValue(sessionAttempts, 'model'),
        providerSet: sanitizeStringArray(session.provider_set),
        modelSet: sanitizeStringArray(session.model_set),
        entries
      });
    }

    sessions.push(...this.buildDirectSessions({
      attempts: visibleDirectAttempts,
      messagesByArchiveId,
      now
    }));

    return {
      ...emptyFeed,
      sessions: sessions
        .sort((left, right) =>
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
          || right.sessionKey.localeCompare(left.sessionKey)
        )
        .slice(0, MAX_SESSIONS)
    };
  }

  private buildEmptyFeed(generatedAt: string): PublicLiveSessionsFeed {
    return {
      orgSlug: sanitizeString(PUBLIC_ORG_SLUG),
      generatedAt,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      historyWindowSeconds: HISTORY_WINDOW_SECONDS,
      sessions: []
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

  private async findPublicOrgId(): Promise<string | null> {
    const orgId = await this.findOrgId(PUBLIC_ORG_SLUG);
    if (orgId) {
      return orgId;
    }
    return this.findOrgId(LEGACY_PUBLIC_ORG_SLUG);
  }

  private async resolveExcludedApiKeyIds(): Promise<Set<string>> {
    const env = this.deps.env ?? process.env;
    const raw = env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS ?? '';
    const tokens = [...DEFAULT_EXCLUDED_BUYER_KEYS, ...raw.split(',')]
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

  private async loadRecentDirectAttempts(orgId: string, now: Date): Promise<SessionAttempt[]> {
    const historySince = new Date(now.getTime() - TRANSCRIPT_HISTORY_WINDOW_MS).toISOString();
    const sql = `
      with recent_direct_routing as materialized (
        select
          re.org_id,
          re.request_id,
          re.attempt_no,
          re.route_decision
        from ${TABLES.routingEvents} re
        where re.org_id = $1
          and re.created_at >= $2::timestamptz
          and nullif(re.route_decision->>'request_source', '') = 'direct'
        order by
          re.created_at desc,
          re.request_id desc,
          re.attempt_no desc
        limit $3
      )
      select
        a.id as request_attempt_archive_id,
        a.request_id,
        a.attempt_no,
        a.org_id,
        a.api_key_id,
        a.provider,
        a.model,
        a.started_at,
        a.completed_at,
        direct.route_decision
      from recent_direct_routing direct
      inner join ${TABLES.requestAttemptArchives} a
        on a.org_id = direct.org_id
        and a.request_id = direct.request_id
        and a.attempt_no = direct.attempt_no
      where not exists (
        select 1
        from ${TABLES.adminSessionAttempts} sa
        where sa.request_attempt_archive_id = a.id
      )
        and coalesce(a.completed_at, a.started_at) >= $4::timestamptz
      order by
        coalesce(a.completed_at, a.started_at) desc,
        a.request_id desc,
        a.attempt_no desc
      limit $5
    `;
    const result = await this.deps.sql.query<DirectAttemptRow>(sql, [
      orgId,
      historySince,
      MAX_DIRECT_ROUTE_CANDIDATES,
      historySince,
      MAX_DIRECT_ATTEMPTS
    ]);
    if (result.rows.length === 0) {
      return [];
    }

    const rawBlobsByArchiveId = await this.loadRawRequestBlobs(result.rows.map((row) => row.request_attempt_archive_id));
    const attempts: SessionAttempt[] = [];

    for (const row of result.rows.slice().reverse()) {
      const promptCacheKey = extractPromptCacheKey(rawBlobsByArchiveId.get(row.request_attempt_archive_id) ?? null);
      const sessionKey = promptCacheKey
        ? `cli:prompt-cache:${promptCacheKey}`
        : buildPinnedDirectRequestSessionKey(row);
      if (!sessionKey) {
        continue;
      }

      const eventAtIso = toIso(row.completed_at ?? row.started_at);
      if (Date.parse(eventAtIso) < Date.parse(historySince)) {
        continue;
      }

      attempts.push({
        ...row,
        session_key: sessionKey,
        eventAtIso
      });
    }

    return attempts;
  }

  private async loadRawRequestBlobs(archiveIds: string[]): Promise<Map<string, RawRequestBlobRow>> {
    if (archiveIds.length === 0) {
      return new Map();
    }

    const sql = `
      select
        rab.request_attempt_archive_id,
        rb.encoding,
        rb.payload
      from ${TABLES.requestAttemptRawBlobs} rab
      inner join ${TABLES.rawBlobs} rb
        on rb.id = rab.raw_blob_id
      where rab.request_attempt_archive_id = any($1::uuid[])
        and rab.blob_role = 'request'
      order by array_position($1::uuid[], rab.request_attempt_archive_id)
    `;
    const result = await this.deps.sql.query<RawRequestBlobRow>(sql, [archiveIds]);
    const rows = new Map<string, RawRequestBlobRow>();
    for (const row of result.rows) {
      if (!rows.has(row.request_attempt_archive_id)) {
        rows.set(row.request_attempt_archive_id, row);
      }
    }
    return rows;
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
      where ram.request_attempt_archive_id = any($1::uuid[])
      order by
        array_position($1::uuid[], ram.request_attempt_archive_id),
        case ram.side when 'request' then 0 when 'response' then 1 else 2 end asc,
        ram.ordinal asc
    `;
    const result = await this.deps.sql.query<MessageRow>(sql, [archiveIds]);
    return result.rows;
  }

  private async loadDirectMessages(archiveIds: string[]): Promise<MessageRow[]> {
    const sql = `
      with latest_user_request as (
        select distinct on (ram.request_attempt_archive_id)
          ram.request_attempt_archive_id,
          ram.side,
          ram.ordinal,
          ram.role,
          mb.normalized_payload
        from ${TABLES.requestAttemptMessages} ram
        inner join ${TABLES.messageBlobs} mb
          on mb.id = ram.message_blob_id
        where ram.request_attempt_archive_id = any($1::uuid[])
          and ram.side = 'request'
          and ram.role = 'user'
        order by
          ram.request_attempt_archive_id,
          ram.ordinal desc
      ),
      response_rows as (
        select
          ram.request_attempt_archive_id,
          ram.side,
          ram.ordinal,
          ram.role,
          mb.normalized_payload
        from ${TABLES.requestAttemptMessages} ram
        inner join ${TABLES.messageBlobs} mb
          on mb.id = ram.message_blob_id
        where ram.request_attempt_archive_id = any($1::uuid[])
          and ram.side = 'response'
      )
      select *
      from (
        select * from latest_user_request
        union all
        select * from response_rows
      ) rows
      order by
        array_position($1::uuid[], rows.request_attempt_archive_id),
        case rows.side when 'request' then 0 when 'response' then 1 else 2 end asc,
        rows.ordinal asc
    `;
    const result = await this.deps.sql.query<MessageRow>(sql, [archiveIds]);
    return result.rows;
  }

  private buildSessionEntries(
    attempts: SessionAttempt[],
    messagesByArchiveId: Map<string, MessageRow[]>
  ): PublicLiveSessionEntry[] {
    const entries: EntryDraft[] = [];

    for (const attempt of attempts) {
      const messageRows = messagesByArchiveId.get(attempt.request_attempt_archive_id) ?? [];
      for (const row of messageRows) {
        entries.push(...shapeMessageEntries({
          archiveId: attempt.request_attempt_archive_id,
          at: attempt.eventAtIso,
          row
        }));
      }
    }

    const visibleEntries = entries.length > MAX_SESSION_ENTRIES
      ? entries.slice(-MAX_SESSION_ENTRIES)
      : entries;

    return visibleEntries.map((entry, index) => finalizeEntry(entry, index));
  }

  private buildDirectSessions(input: {
    attempts: SessionAttempt[];
    messagesByArchiveId: Map<string, MessageRow[]>;
    now: Date;
  }): PublicLiveSession[] {
    const activeSince = input.now.getTime() - ACTIVE_WINDOW_MS;
    const attemptsBySession = new Map<string, SessionAttempt[]>();

    for (const attempt of input.attempts) {
      const existing = attemptsBySession.get(attempt.session_key) ?? [];
      existing.push(attempt);
      attemptsBySession.set(attempt.session_key, existing);
    }

    const sessions: PublicLiveSession[] = [];
    for (const [sessionKey, attempts] of attemptsBySession.entries()) {
      const sortedAttempts = sortSessionAttempts(attempts);
      const lastActivityAt = sortedAttempts.at(-1)?.eventAtIso;
      if (!lastActivityAt || Date.parse(lastActivityAt) < activeSince) {
        continue;
      }

      const entries = this.buildSessionEntries(sortedAttempts, input.messagesByArchiveId);
      if (entries.length === 0) {
        continue;
      }

      sessions.push({
        sessionKey: sanitizeString(sessionKey),
        sessionType: 'cli',
        displayTitle: buildDisplayTitle('cli', sessionKey),
        startedAt: toIso(sortedAttempts[0]?.started_at ?? lastActivityAt),
        endedAt: toIso(sortedAttempts.at(-1)?.completed_at ?? sortedAttempts.at(-1)?.started_at ?? lastActivityAt),
        lastActivityAt,
        currentProvider: findCurrentValue(sortedAttempts, 'provider'),
        currentModel: findCurrentValue(sortedAttempts, 'model'),
        providerSet: collectAttemptValues(sortedAttempts, 'provider'),
        modelSet: collectAttemptValues(sortedAttempts, 'model'),
        entries
      });
    }

    return sessions;
  }
}

function shapeMessageEntries(input: {
  archiveId: string;
  at: string;
  row: MessageRow;
}): EntryDraft[] {
  const payload = normalizePayload(input.row.normalized_payload, input.row.role);
  if (!payload || payload.role === 'system') {
    return [];
  }

  const entries: EntryDraft[] = [];
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
        archiveId: input.archiveId,
        kind: 'user',
        at: input.at,
        text
      });
      return;
    }

    if (payload.role === 'assistant') {
      entries.push({
        archiveId: input.archiveId,
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

function finalizeEntry(entry: EntryDraft, index: number): PublicLiveSessionEntry {
  const { archiveId, ...rest } = entry;
  return {
    ...rest,
    entryId: `${archiveId}:${index}:${entry.kind}`
  };
}

function buildDisplayTitle(sessionType: PublicLiveSession['sessionType'], sessionKey: string): string {
  return `${sessionType} ${shortSessionLabel(sessionKey)}`;
}

function shortSessionLabel(sessionKey: string): string {
  const lastSegment = sanitizeString(sessionKey.split(':').at(-1) ?? sessionKey);
  if (lastSegment.length <= 16) {
    return lastSegment;
  }
  return `${lastSegment.slice(0, 8)}...${lastSegment.slice(-4)}`;
}

function findCurrentValue(attempts: SessionAttempt[], field: 'provider' | 'model'): string | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const value = readString(attempts[index]?.[field]);
    if (value) {
      return sanitizeString(value);
    }
  }
  return null;
}

function collectAttemptValues(attempts: SessionAttempt[], field: 'provider' | 'model'): string[] {
  const values = new Set<string>();
  for (const attempt of attempts) {
    const value = readString(attempt[field]);
    if (value) {
      values.add(sanitizeString(value));
    }
  }
  return [...values];
}

function sortSessionAttempts(attempts: SessionAttempt[]): SessionAttempt[] {
  return [...attempts].sort((left, right) =>
    Date.parse(left.eventAtIso) - Date.parse(right.eventAtIso)
    || left.request_id.localeCompare(right.request_id)
    || left.attempt_no - right.attempt_no
  );
}

function selectVisibleDirectAttempts(attempts: SessionAttempt[], now: Date): SessionAttempt[] {
  const activeSince = now.getTime() - ACTIVE_WINDOW_MS;
  const attemptsBySession = new Map<string, SessionAttempt[]>();

  for (const attempt of attempts) {
    const existing = attemptsBySession.get(attempt.session_key) ?? [];
    existing.push(attempt);
    attemptsBySession.set(attempt.session_key, existing);
  }

  const visibleAttempts: SessionAttempt[] = [];
  for (const sessionAttempts of attemptsBySession.values()) {
    const sortedAttempts = sortSessionAttempts(sessionAttempts);
    const lastActivityAt = sortedAttempts.at(-1)?.eventAtIso;
    if (!lastActivityAt || Date.parse(lastActivityAt) < activeSince) {
      continue;
    }

    visibleAttempts.push(...sortedAttempts.slice(-MAX_DIRECT_SESSION_ATTEMPTS));
  }

  return visibleAttempts;
}

function extractPromptCacheKey(rawBlob: RawRequestBlobRow | null): string | null {
  if (!rawBlob) {
    return null;
  }

  try {
    const rawBuffer = rawBlob.encoding === 'gzip'
      ? gunzipSync(rawBlob.payload)
      : Buffer.from(rawBlob.payload);
    const parsed = JSON.parse(rawBuffer.toString('utf8'));
    if (!isRecord(parsed)) {
      return null;
    }
    return sanitizeNullableString(readString(parsed.prompt_cache_key));
  } catch {
    return null;
  }
}

function buildPinnedDirectRequestSessionKey(row: Pick<DirectAttemptRow, 'request_id' | 'route_decision'>): string | null {
  const routeDecision = isRecord(row.route_decision) ? row.route_decision : null;
  const selectionReason = readString(routeDecision?.provider_selection_reason);
  if (selectionReason !== 'cli_provider_pinned') {
    return null;
  }

  const requestId = sanitizeNullableString(readString(row.request_id));
  return requestId ? `cli:request:${requestId}` : null;
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function toMillis(value: string | Date): number {
  return new Date(value).getTime();
}
