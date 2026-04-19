import { TABLES } from '../../repos/tableNames.js';
import type { SqlValue } from '../../repos/sqlClient.js';
import { sanitizePublicDeep } from '../publicInnies/publicTextSanitizer.js';
import {
  MY_LIVE_SESSIONS_DEFAULT_WINDOW_HOURS,
  MY_LIVE_SESSIONS_MAX_SESSIONS,
  MY_LIVE_SESSIONS_MAX_TURNS_PER_SESSION,
  MY_LIVE_SESSIONS_MAX_WINDOW_HOURS,
  MY_LIVE_SESSIONS_POLL_INTERVAL_SECONDS,
  type MyLiveSession,
  type MyLiveSessionTurn,
  type MyLiveSessionTurnMessage,
  type MyLiveSessionsFeed,
  type MyLiveSessionsListInput,
  type MyLiveSessionsServiceDeps
} from './myLiveSessionsTypes.js';

type ArchiveRow = {
  id: string;
  request_id: string;
  attempt_no: number;
  api_key_id: string;
  openclaw_session_id: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  upstream_status: number | null;
  started_at: string | Date;
  completed_at: string | Date | null;
};

type MessageRow = {
  request_attempt_archive_id: string;
  side: 'request' | 'response';
  ordinal: number;
  role: string | null;
  content_type: string;
  normalized_payload: Record<string, unknown>;
};

function clampWindowHours(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    return MY_LIVE_SESSIONS_DEFAULT_WINDOW_HOURS;
  }
  return Math.min(Math.max(1, Math.floor(requested)), MY_LIVE_SESSIONS_MAX_WINDOW_HOURS);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoNullable(value: string | Date | null): string | null {
  return value == null ? null : toIso(value);
}

function sessionKeyForArchive(row: ArchiveRow): string {
  return row.openclaw_session_id ? row.openclaw_session_id : `archive:${row.id}`;
}

// Strip content blocks the watch-me-work panel never renders:
//   - anthropic thinking / redacted_thinking (opaque, often huge)
//   - tool_use / tool_result (panel hides tool activity — SessionPanel.tsx)
// The archive normalizer either emits these at top level (`{type: "thinking"}`)
// or wraps them (`{type: "json", value: {type: "thinking"}}`), so handle both.
// Tool-use/result blocks are the dominant size driver — a single file-read
// tool_result can be hundreds of KB, and we were shipping thousands of them
// per session just for the browser to drop them on the floor.
const HIDDEN_PART_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result'
]);

function stripHiddenParts(payload: Record<string, unknown>): Record<string, unknown> {
  const content = payload.content;
  if (!Array.isArray(content)) return payload;

  const filtered = content.filter((part) => {
    if (!part || typeof part !== 'object') return true;
    const record = part as Record<string, unknown>;
    const type = record.type;
    if (typeof type === 'string' && HIDDEN_PART_TYPES.has(type)) return false;
    if (type === 'json') {
      const inner = record.value;
      if (inner && typeof inner === 'object') {
        const innerType = (inner as Record<string, unknown>).type;
        if (typeof innerType === 'string' && HIDDEN_PART_TYPES.has(innerType)) return false;
      }
    }
    return true;
  });

  if (filtered.length === content.length) return payload;
  return { ...payload, content: filtered };
}

export class MyLiveSessionsService {
  constructor(private readonly deps: MyLiveSessionsServiceDeps) {}

  async listFeed(input: MyLiveSessionsListInput): Promise<MyLiveSessionsFeed> {
    const now = input.now ?? new Date();
    const windowHours = clampWindowHours(input.windowHours);
    const generatedAt = now.toISOString();
    const apiKeyIds = Array.from(new Set(input.apiKeyIds.filter((id) => typeof id === 'string' && id.length > 0)));

    const emptyFeed: MyLiveSessionsFeed = {
      generatedAt,
      windowHours,
      pollIntervalSeconds: MY_LIVE_SESSIONS_POLL_INTERVAL_SECONDS,
      apiKeyIds,
      sessions: []
    };

    if (apiKeyIds.length === 0) {
      return emptyFeed;
    }

    const archives = await this.loadArchives(apiKeyIds, now, windowHours);
    if (archives.length === 0) {
      return emptyFeed;
    }

    const archiveIds = archives.map((row) => row.id);
    const messageRows = await this.loadMessages(archiveIds);
    const messagesByArchiveId = new Map<string, MessageRow[]>();
    for (const row of messageRows) {
      const existing = messagesByArchiveId.get(row.request_attempt_archive_id) ?? [];
      existing.push(row);
      messagesByArchiveId.set(row.request_attempt_archive_id, existing);
    }

    const sessionsByKey = new Map<string, MyLiveSession>();
    for (const row of archives) {
      const sessionKey = sessionKeyForArchive(row);
      const existing = sessionsByKey.get(sessionKey);
      const turn = this.buildTurn(row, messagesByArchiveId.get(row.id) ?? []);

      if (!existing) {
        sessionsByKey.set(sessionKey, {
          sessionKey,
          apiKeyId: row.api_key_id,
          startedAt: toIso(row.started_at),
          lastActivityAt: toIso(row.completed_at ?? row.started_at),
          turnCount: 1,
          providerSet: [row.provider],
          modelSet: [row.model],
          turns: [turn]
        });
        continue;
      }

      existing.turns.push(turn);
      existing.turnCount = existing.turns.length;
      existing.startedAt = earlier(existing.startedAt, toIso(row.started_at));
      existing.lastActivityAt = later(existing.lastActivityAt, toIso(row.completed_at ?? row.started_at));
      if (!existing.providerSet.includes(row.provider)) existing.providerSet.push(row.provider);
      if (!existing.modelSet.includes(row.model)) existing.modelSet.push(row.model);
    }

    // Sort turns within each session by startedAt ascending, then trim to cap.
    for (const session of sessionsByKey.values()) {
      session.turns.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
      if (session.turns.length > MY_LIVE_SESSIONS_MAX_TURNS_PER_SESSION) {
        session.turns = session.turns.slice(-MY_LIVE_SESSIONS_MAX_TURNS_PER_SESSION);
        session.turnCount = session.turns.length;
      }
    }

    const sessions = Array.from(sessionsByKey.values())
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt))
      .slice(0, MY_LIVE_SESSIONS_MAX_SESSIONS);

    return {
      ...emptyFeed,
      sessions
    };
  }

  private async loadArchives(apiKeyIds: string[], now: Date, windowHours: number): Promise<ArchiveRow[]> {
    const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    const sql = `
      select
        id,
        request_id,
        attempt_no,
        api_key_id,
        openclaw_session_id,
        provider,
        model,
        streaming,
        status,
        upstream_status,
        started_at,
        completed_at
      from ${TABLES.requestAttemptArchives}
      where api_key_id = any($1::uuid[])
        and started_at >= $2::timestamptz
      order by started_at asc
    `;
    const params: SqlValue[] = [apiKeyIds, cutoff];
    const result = await this.deps.sql.query<ArchiveRow>(sql, params);
    return result.rows;
  }

  private async loadMessages(archiveIds: string[]): Promise<MessageRow[]> {
    if (archiveIds.length === 0) return [];
    const sql = `
      select
        rm.request_attempt_archive_id,
        rm.side,
        rm.ordinal,
        rm.role,
        rm.content_type,
        mb.normalized_payload
      from ${TABLES.requestAttemptMessages} rm
      inner join ${TABLES.messageBlobs} mb
        on mb.id = rm.message_blob_id
      where rm.request_attempt_archive_id = any($1::uuid[])
      order by rm.request_attempt_archive_id asc,
               rm.side desc,
               rm.ordinal asc
    `;
    const params: SqlValue[] = [archiveIds];
    const result = await this.deps.sql.query<MessageRow>(sql, params);
    return result.rows;
  }

  private buildTurn(archive: ArchiveRow, messageRows: MessageRow[]): MyLiveSessionTurn {
    const messages: MyLiveSessionTurnMessage[] = messageRows
      .slice()
      .sort((left, right) => {
        if (left.side !== right.side) return left.side === 'request' ? -1 : 1;
        return left.ordinal - right.ordinal;
      })
      .map((row) => ({
        side: row.side,
        ordinal: row.ordinal,
        role: row.role,
        contentType: row.content_type,
        // The /v1/admin/me/live-sessions response is relayed to the
        // innies.work `watch-me-work.md` tab via a server-side proxy
        // route (`INNIES_ADMIN_API_KEY` is injected on the Next.js
        // side, so the browser-facing endpoint needs no auth). That
        // makes this payload publicly readable for anyone who hits
        // innies.work — so we scrub the same secret/credential/PII
        // patterns as the public landing feed before returning.
        normalizedPayload: stripHiddenParts(sanitizePublicDeep(row.normalized_payload ?? {}))
      }));

    return {
      archiveId: archive.id,
      requestId: archive.request_id,
      attemptNo: archive.attempt_no,
      provider: archive.provider,
      model: archive.model,
      streaming: archive.streaming,
      status: archive.status,
      upstreamStatus: archive.upstream_status ?? null,
      startedAt: toIso(archive.started_at),
      completedAt: toIsoNullable(archive.completed_at),
      messages
    };
  }
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
