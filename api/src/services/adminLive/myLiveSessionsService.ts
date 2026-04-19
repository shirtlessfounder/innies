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

    // Group archives by session and sort each bucket by started_at asc up
    // front. Session-level metadata (startedAt, lastActivityAt, providerSet,
    // modelSet) is computed from the full bucket so long-running sessions
    // still show their true start time and full provider/model footprint.
    const archivesBySessionKey = new Map<string, ArchiveRow[]>();
    for (const row of archives) {
      const key = sessionKeyForArchive(row);
      const bucket = archivesBySessionKey.get(key) ?? [];
      bucket.push(row);
      archivesBySessionKey.set(key, bucket);
    }
    for (const bucket of archivesBySessionKey.values()) {
      bucket.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    }

    // Slice each bucket to the last N archives BEFORE calling loadMessages.
    // The SQL dedup in loadMessages attributes each logical (side, ordinal)
    // pair to the earliest archive that carried it. For long-running sessions
    // where the first 100+ archives already cover every ordinal, slicing to
    // the last 20 turns after-the-fact leaves the visible archives owning
    // nothing — the UI renders "no transcript rows yet" even though the
    // session is actively producing messages. Slicing first guarantees dedup
    // happens within the displayed window, and shrinks the message query to
    // boot.
    const visibleArchiveIds: string[] = [];
    const visibleBySessionKey = new Map<string, ArchiveRow[]>();
    for (const [key, bucket] of archivesBySessionKey) {
      const visible =
        bucket.length > MY_LIVE_SESSIONS_MAX_TURNS_PER_SESSION
          ? bucket.slice(-MY_LIVE_SESSIONS_MAX_TURNS_PER_SESSION)
          : bucket;
      visibleBySessionKey.set(key, visible);
      for (const row of visible) visibleArchiveIds.push(row.id);
    }

    const messageRows = await this.loadMessages(visibleArchiveIds);
    const messagesByArchiveId = new Map<string, MessageRow[]>();
    for (const row of messageRows) {
      const existing = messagesByArchiveId.get(row.request_attempt_archive_id) ?? [];
      existing.push(row);
      messagesByArchiveId.set(row.request_attempt_archive_id, existing);
    }

    const sessionsByKey = new Map<string, MyLiveSession>();
    for (const [sessionKey, fullBucket] of archivesBySessionKey) {
      const visibleBucket = visibleBySessionKey.get(sessionKey) ?? fullBucket;
      const first = fullBucket[0];
      let startedAtMs = Infinity;
      let lastActivityMs = -Infinity;
      const providerSet: string[] = [];
      const modelSet: string[] = [];
      for (const row of fullBucket) {
        const startMs = new Date(row.started_at).getTime();
        const endMs = new Date(row.completed_at ?? row.started_at).getTime();
        if (startMs < startedAtMs) startedAtMs = startMs;
        if (endMs > lastActivityMs) lastActivityMs = endMs;
        if (!providerSet.includes(row.provider)) providerSet.push(row.provider);
        if (!modelSet.includes(row.model)) modelSet.push(row.model);
      }

      const turns = visibleBucket.map((row) =>
        this.buildTurn(row, messagesByArchiveId.get(row.id) ?? [])
      );

      // Claude/Codex archive turns are cumulative: turn N's messages include
      // every prior turn's messages re-sent as context. SessionPanel.tsx's
      // flattenSession already strips these client-side by tracking max
      // (side, ordinal) — mirror that here so the wire payload matches what
      // the UI actually renders. Belt-and-suspenders for rows that slip past
      // the SQL-side DISTINCT ON.
      dedupCumulativeMessages(turns);

      sessionsByKey.set(sessionKey, {
        sessionKey,
        apiKeyId: first.api_key_id,
        startedAt: new Date(startedAtMs).toISOString(),
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        turnCount: turns.length,
        providerSet,
        modelSet,
        turns
      });
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
    // Two read-side optimizations happen at the SQL boundary so the rows
    // never have to cross the DB → app network:
    //
    // 1) DEDUP. Claude/Codex turns are cumulative — turn N re-ships every
    //    prior turn's messages as context. `DISTINCT ON (session, side,
    //    ordinal)` keeps only the earliest archive's copy of each logical
    //    message. For heavy sessions this is where most of the savings
    //    come from (we measured ~14× on payload size already when doing
    //    it in JS; moving it here saves the supabase → VM transfer too).
    //
    // 2) CONTENT-BLOCK STRIP. The watch-me-work panel hides thinking /
    //    redacted_thinking / tool_use / tool_result parts (SessionPanel.tsx),
    //    yet a single tool_result can be hundreds of KB. Rebuilding the
    //    content array with `jsonb_agg` over only the visible parts lets
    //    Postgres drop the big blobs before serializing to the wire.
    //
    // The app still runs `dedupCumulativeMessages` and `stripHiddenParts`
    // after the query — belt-and-suspenders for rows that predate this
    // optimization or edge cases the SQL doesn't cover.
    const sql = `
      with deduped as (
        select distinct on (
          coalesce(ar.openclaw_session_id::text, ar.id::text),
          rm.side,
          rm.ordinal
        )
          rm.request_attempt_archive_id,
          rm.side,
          rm.ordinal,
          rm.role,
          rm.content_type,
          mb.normalized_payload
        from ${TABLES.requestAttemptMessages} rm
        inner join ${TABLES.messageBlobs} mb
          on mb.id = rm.message_blob_id
        inner join ${TABLES.requestAttemptArchives} ar
          on ar.id = rm.request_attempt_archive_id
        where rm.request_attempt_archive_id = any($1::uuid[])
        order by
          coalesce(ar.openclaw_session_id::text, ar.id::text),
          rm.side,
          rm.ordinal,
          ar.started_at asc
      )
      select
        request_attempt_archive_id,
        side,
        ordinal,
        role,
        content_type,
        case
          when jsonb_typeof(normalized_payload->'content') = 'array' then
            jsonb_set(
              normalized_payload,
              '{content}',
              coalesce(
                (
                  select jsonb_agg(part order by idx)
                  from jsonb_array_elements(normalized_payload->'content')
                    with ordinality as t(part, idx)
                  where not (
                    part->>'type' in (
                      'thinking','redacted_thinking','tool_use','tool_result'
                    )
                    or (
                      part->>'type' = 'json'
                      and part->'value'->>'type' in (
                        'thinking','redacted_thinking','tool_use','tool_result'
                      )
                    )
                  )
                ),
                '[]'::jsonb
              )
            )
          else normalized_payload
        end as normalized_payload
      from deduped
      order by request_attempt_archive_id asc,
               side desc,
               ordinal asc
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

function dedupCumulativeMessages(turns: MyLiveSessionTurn[]): void {
  let priorMaxRequest = -1;
  let priorMaxResponse = -1;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (i > 0) {
      turn.messages = turn.messages.filter((m) => {
        const priorMax = m.side === 'request' ? priorMaxRequest : priorMaxResponse;
        return m.ordinal > priorMax;
      });
    }
    for (const m of turn.messages) {
      if (m.side === 'request') {
        if (m.ordinal > priorMaxRequest) priorMaxRequest = m.ordinal;
      } else if (m.ordinal > priorMaxResponse) {
        priorMaxResponse = m.ordinal;
      }
    }
  }
}
