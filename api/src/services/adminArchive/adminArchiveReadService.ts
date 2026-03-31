import type { RequestAttemptMessageRow } from '../../repos/requestAttemptMessageRepository.js';
import type { RequestAttemptRawBlobRow } from '../../repos/requestAttemptRawBlobRepository.js';
import type { AdminSessionAttemptRepository } from '../../repos/adminSessionAttemptRepository.js';
import type { AdminSessionRow } from '../../repos/adminSessionRepository.js';
import type { MessageBlobRepository, MessageBlobRow } from '../../repos/messageBlobRepository.js';
import type { RawBlobRepository, RawBlobRow } from '../../repos/rawBlobRepository.js';
import type { RequestAttemptArchiveRepository, RequestAttemptArchiveRow } from '../../repos/requestAttemptArchiveRepository.js';
import type { RequestAttemptMessageRepository } from '../../repos/requestAttemptMessageRepository.js';
import type { RequestAttemptRawBlobRepository } from '../../repos/requestAttemptRawBlobRepository.js';
import type { SqlClient, SqlValue } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';

type AnalyticsWindow = '24h' | '7d' | '1m' | 'all';

type SessionListCursor = {
  lastActivityAt: string;
  sessionKey: string;
};

type EventListCursor = {
  eventTime: string;
  requestId: string;
  attemptNo: number;
  sortOrdinal: number;
};

type AdminArchiveSessionRow = AdminSessionRow;

type RouteDecisionRow = {
  route_decision: Record<string, unknown> | null;
};

type SessionEventRecord = {
  eventType: 'request_message' | 'response_message' | 'attempt_status';
  eventTime: string;
  requestId: string;
  attemptNo: number;
  ordinal: number;
  side: 'request' | 'response' | null;
  role: string | null;
  contentType: string | null;
  content: unknown;
  provider: string;
  model: string;
  streaming: boolean;
  status: string;
  upstreamStatus: number | null;
  sortOrdinal: number;
};

export class AdminArchiveReadService {
  constructor(private readonly deps: {
    sql: Pick<SqlClient, 'query'>;
    adminSessionAttempts: Pick<AdminSessionAttemptRepository, 'listAttemptsBySessionKey'>;
    requestAttemptArchives: Pick<RequestAttemptArchiveRepository, 'findByRequestAttempt' | 'listByIds'>;
    requestAttemptMessages: Pick<RequestAttemptMessageRepository, 'listByArchiveId'>;
    requestAttemptRawBlobs: Pick<RequestAttemptRawBlobRepository, 'listByArchiveId'>;
    messageBlobs: Pick<MessageBlobRepository, 'findByIds'>;
    rawBlobs: Pick<RawBlobRepository, 'findByIds'>;
  }) {}

  async listSessions(input: {
    window: AnalyticsWindow;
    sessionType?: 'cli' | 'openclaw';
    orgId?: string;
    provider?: string;
    model?: string;
    status?: 'success' | 'failed' | 'partial';
    limit: number;
    cursor?: string;
  }): Promise<{
    window: AnalyticsWindow;
    limit: number;
    sessions: ReturnType<typeof mapSessionRow>[];
    nextCursor: string | null;
  }> {
    const params: SqlValue[] = [];
    const where = [windowCondition(input.window)];

    if (input.sessionType) {
      params.push(input.sessionType);
      where.push(`session_type = $${params.length}`);
    }

    if (input.orgId) {
      params.push(input.orgId);
      where.push(`org_id = $${params.length}`);
    }

    if (input.provider) {
      params.push(input.provider);
      where.push(`$${params.length} = any(provider_set)`);
    }

    if (input.model) {
      params.push(input.model);
      where.push(`$${params.length} = any(model_set)`);
    }

    if (input.status) {
      params.push(input.status);
      where.push(`coalesce((status_summary ->> $${params.length})::int, 0) > 0`);
    }

    if (input.cursor) {
      const cursor = decodeSessionListCursor(input.cursor);
      params.push(cursor.lastActivityAt);
      const timeIndex = params.length;
      params.push(cursor.sessionKey);
      const keyIndex = params.length;
      where.push(`(
        last_activity_at < $${timeIndex}::timestamptz
        or (last_activity_at = $${timeIndex}::timestamptz and session_key < $${keyIndex})
      )`);
    }

    params.push(input.limit + 1);
    const sql = `
      select *
      from ${TABLES.adminSessions}
      where ${where.join(' and ')}
      order by last_activity_at desc, session_key desc
      limit $${params.length}
    `;
    const result = await this.deps.sql.query<AdminArchiveSessionRow>(sql, params);
    const pageRows = result.rows.slice(0, input.limit);
    const nextRow = result.rows[input.limit];

    return {
      window: input.window,
      limit: input.limit,
      sessions: pageRows.map(mapSessionRow),
      nextCursor: nextRow ? encodeSessionListCursor({
        lastActivityAt: new Date(nextRow.last_activity_at).toISOString(),
        sessionKey: nextRow.session_key
      }) : null
    };
  }

  async getSession(sessionKey: string): Promise<{
    session: ReturnType<typeof mapSessionRow> & {
      firstRequestRef: { requestId: string; attemptNo: number } | null;
      lastRequestRef: { requestId: string; attemptNo: number } | null;
    };
  } | null> {
    const sessionRow = await this.findSessionRow(sessionKey);
    if (!sessionRow) {
      return null;
    }

    const attempts = await this.deps.adminSessionAttempts.listAttemptsBySessionKey(sessionKey);
    return {
      session: {
        ...mapSessionRow(sessionRow),
        firstRequestRef: attempts[0]
          ? { requestId: attempts[0].request_id, attemptNo: attempts[0].attempt_no }
          : null,
        lastRequestRef: attempts.length > 0
          ? { requestId: attempts[attempts.length - 1]!.request_id, attemptNo: attempts[attempts.length - 1]!.attempt_no }
          : null
      }
    };
  }

  async listSessionEvents(input: {
    sessionKey: string;
    limit: number;
    cursor?: string;
  }): Promise<{
    sessionKey: string;
    events: Array<Omit<SessionEventRecord, 'sortOrdinal'>>;
    nextCursor: string | null;
  } | null> {
    const sessionRow = await this.findSessionRow(input.sessionKey);
    if (!sessionRow) {
      return null;
    }

    const attemptLinks = await this.deps.adminSessionAttempts.listAttemptsBySessionKey(input.sessionKey);
    const archives = await this.deps.requestAttemptArchives.listByIds(
      attemptLinks.map((attempt) => attempt.request_attempt_archive_id)
    );
    const archiveById = new Map(archives.map((archive) => [archive.id, archive]));

    const events: SessionEventRecord[] = [];
    for (const attemptLink of attemptLinks) {
      const archive = archiveById.get(attemptLink.request_attempt_archive_id);
      if (!archive) continue;

      const eventTime = normalizeIso(archive.completed_at ?? archive.started_at);
      events.push({
        eventType: 'attempt_status',
        eventTime,
        requestId: archive.request_id,
        attemptNo: archive.attempt_no,
        ordinal: -1,
        side: null,
        role: null,
        contentType: null,
        content: null,
        provider: archive.provider,
        model: archive.model,
        streaming: archive.streaming,
        status: archive.status,
        upstreamStatus: archive.upstream_status,
        sortOrdinal: -1
      });

      const messageRows = await this.deps.requestAttemptMessages.listByArchiveId(archive.id);
      const blobRows = await this.deps.messageBlobs.findByIds(messageRows.map((message) => message.message_blob_id));
      const blobById = new Map(blobRows.map((blob) => [blob.id, blob]));

      for (const message of messageRows) {
        const blob = blobById.get(message.message_blob_id);
        events.push({
          eventType: message.side === 'request' ? 'request_message' : 'response_message',
          eventTime,
          requestId: archive.request_id,
          attemptNo: archive.attempt_no,
          ordinal: message.ordinal,
          side: message.side,
          role: message.role,
          contentType: message.content_type,
          content: blob?.normalized_payload ?? null,
          provider: archive.provider,
          model: archive.model,
          streaming: archive.streaming,
          status: archive.status,
          upstreamStatus: archive.upstream_status,
          sortOrdinal: message.side === 'request' ? message.ordinal : 1_000_000 + message.ordinal
        });
      }
    }

    events.sort(compareEventRecords);

    const decodedCursor = input.cursor ? decodeEventCursorRecord(input.cursor) : null;
    const filtered = decodedCursor
      ? events.filter((event) => compareEventRecords(event, decodedCursor) > 0)
      : events;
    const pageEvents = filtered.slice(0, input.limit);
    const nextEvent = filtered[input.limit];

    return {
      sessionKey: input.sessionKey,
      events: pageEvents.map(stripSortOrdinal),
      nextCursor: nextEvent ? encodeEventCursor({
        eventTime: nextEvent.eventTime,
        requestId: nextEvent.requestId,
        attemptNo: nextEvent.attemptNo,
        sortOrdinal: nextEvent.sortOrdinal
      }) : null
    };
  }

  async getAttempt(input: {
    requestId: string;
    attemptNo: number;
  }): Promise<{
    attempt: Record<string, unknown>;
    request: Array<Record<string, unknown>>;
    response: Array<Record<string, unknown>>;
    raw: Array<Record<string, unknown>>;
  } | null> {
    const archive = await this.deps.requestAttemptArchives.findByRequestAttempt(input.requestId, input.attemptNo);
    if (!archive) {
      return null;
    }

    const routeDecision = await this.findRouteDecision(archive);
    const requestMessages = await this.loadMessages(archive.id, 'request');
    const responseMessages = await this.loadMessages(archive.id, 'response');
    const rawLinks = await this.deps.requestAttemptRawBlobs.listByArchiveId(archive.id);
    const rawBlobs = await this.deps.rawBlobs.findByIds(rawLinks.map((link) => link.raw_blob_id));
    const rawBlobById = new Map(rawBlobs.map((blob) => [blob.id, blob]));

    return {
      attempt: {
        requestId: archive.request_id,
        attemptNo: archive.attempt_no,
        orgId: archive.org_id,
        apiKeyId: archive.api_key_id,
        routeKind: archive.route_kind,
        sellerKeyId: archive.seller_key_id,
        tokenCredentialId: archive.token_credential_id,
        provider: archive.provider,
        model: archive.model,
        streaming: archive.streaming,
        status: archive.status,
        upstreamStatus: archive.upstream_status,
        errorCode: archive.error_code,
        startedAt: normalizeIso(archive.started_at),
        completedAt: archive.completed_at ? normalizeIso(archive.completed_at) : null,
        openclawRunId: archive.openclaw_run_id,
        openclawSessionId: archive.openclaw_session_id,
        requestSource: readRouteDecisionString(routeDecision, 'request_source'),
        providerSelectionReason: readRouteDecisionString(routeDecision, 'provider_selection_reason')
      },
      request: requestMessages,
      response: responseMessages,
      raw: rawLinks.map((link) => mapRawLink(link, rawBlobById.get(link.raw_blob_id) ?? null))
    };
  }

  private async findSessionRow(sessionKey: string): Promise<AdminArchiveSessionRow | null> {
    const result = await this.deps.sql.query<AdminArchiveSessionRow>(`
      select *
      from ${TABLES.adminSessions}
      where session_key = $1
      limit 1
    `, [sessionKey]);
    return result.rows[0] ?? null;
  }

  private async loadMessages(
    archiveId: string,
    side: 'request' | 'response'
  ): Promise<Array<Record<string, unknown>>> {
    const messageRows = await this.deps.requestAttemptMessages.listByArchiveId(archiveId, side);
    const blobs = await this.deps.messageBlobs.findByIds(messageRows.map((message) => message.message_blob_id));
    const blobById = new Map(blobs.map((blob) => [blob.id, blob]));

    return messageRows.map((message) => mapMessageRecord(message, blobById.get(message.message_blob_id) ?? null));
  }

  private async findRouteDecision(archive: RequestAttemptArchiveRow): Promise<Record<string, unknown> | null> {
    const sql = `
      select route_decision
      from ${TABLES.routingEvents}
      where org_id = $1
        and request_id = $2
        and attempt_no = $3
      limit 1
    `;
    const result = await this.deps.sql.query<RouteDecisionRow>(sql, [
      archive.org_id,
      archive.request_id,
      archive.attempt_no
    ]);
    return result.rows[0]?.route_decision ?? null;
  }
}

function mapSessionRow(row: AdminArchiveSessionRow) {
  const startedAt = normalizeIso(row.started_at);
  const endedAt = normalizeIso(row.ended_at);
  return {
    sessionKey: row.session_key,
    sessionType: row.session_type,
    groupingBasis: row.grouping_basis,
    sourceSessionId: row.source_session_id,
    sourceRunId: row.source_run_id,
    orgId: row.org_id,
    startedAt,
    endedAt,
    durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
    requestCount: row.request_count,
    attemptCount: row.attempt_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    providerSet: row.provider_set,
    modelSet: row.model_set,
    statusSummary: row.status_summary,
    previewSample: row.preview_sample
  };
}

function mapMessageRecord(message: RequestAttemptMessageRow, blob: MessageBlobRow | null): Record<string, unknown> {
  return {
    side: message.side,
    ordinal: message.ordinal,
    role: message.role,
    contentType: message.content_type,
    content: blob?.normalized_payload ?? null
  };
}

function mapRawLink(link: RequestAttemptRawBlobRow, blob: RawBlobRow | null): Record<string, unknown> {
  return {
    blobRole: link.blob_role,
    rawBlobId: link.raw_blob_id,
    blobKind: blob?.blob_kind ?? null,
    contentHash: blob?.content_hash ?? null,
    encoding: blob?.encoding ?? null,
    bytesCompressed: blob?.bytes_compressed ?? null,
    bytesUncompressed: blob?.bytes_uncompressed ?? null
  };
}

function stripSortOrdinal(event: SessionEventRecord): Omit<SessionEventRecord, 'sortOrdinal'> {
  const { sortOrdinal, ...rest } = event;
  return rest;
}

function compareEventRecords(left: SessionEventRecord, right: Pick<SessionEventRecord, 'eventTime' | 'requestId' | 'attemptNo' | 'sortOrdinal'>): number {
  return new Date(left.eventTime).getTime() - new Date(right.eventTime).getTime()
    || left.requestId.localeCompare(right.requestId)
    || left.attemptNo - right.attemptNo
    || left.sortOrdinal - right.sortOrdinal;
}

function decodeSessionListCursor(cursor: string): SessionListCursor {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  return JSON.parse(decoded) as SessionListCursor;
}

function encodeSessionListCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeEventCursor(cursor: string): EventListCursor {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  return JSON.parse(decoded) as EventListCursor;
}

function decodeEventCursorRecord(cursor: string): SessionEventRecord {
  const decoded = decodeEventCursor(cursor);
  return {
    eventType: 'attempt_status',
    eventTime: decoded.eventTime,
    requestId: decoded.requestId,
    attemptNo: decoded.attemptNo,
    ordinal: decoded.sortOrdinal,
    side: null,
    role: null,
    contentType: null,
    content: null,
    provider: '',
    model: '',
    streaming: false,
    status: 'success',
    upstreamStatus: null,
    sortOrdinal: decoded.sortOrdinal
  };
}

function encodeEventCursor(cursor: EventListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function normalizeIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function readRouteDecisionString(routeDecision: Record<string, unknown> | null, key: string): string | null {
  const value = routeDecision?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function windowCondition(window: AnalyticsWindow): string {
  switch (window) {
    case '24h':
      return "last_activity_at >= now() - interval '24 hours'";
    case '7d':
      return "last_activity_at >= now() - interval '7 days'";
    case '1m':
      return "last_activity_at >= now() - interval '30 days'";
    case 'all':
      return '1=1';
    default:
      return '1=1';
  }
}
