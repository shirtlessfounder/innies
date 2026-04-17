import type { TransactionContext } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';
import type {
  AnalyticsRepository,
  MonitorArchiveAttemptRecord
} from '../../repos/analyticsRepository.js';
import { classifyLiveLane } from './liveLaneClassifier.js';

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const TRANSCRIPT_HISTORY_WINDOW_MS = 60 * 60 * 1000;
const MONITOR_ARCHIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 30;
const IDLE_TIMEOUT_SECONDS = ACTIVE_WINDOW_MS / 1000;
const HISTORY_WINDOW_SECONDS = TRANSCRIPT_HISTORY_WINDOW_MS / 1000;
const MAX_SESSIONS = 24;
const MAX_SESSION_ENTRIES = 120;
const MAX_MONITOR_ARCHIVE_ATTEMPTS = 36;
const MAX_MONITOR_ITEMS = 160;

export type PublicLiveSessionEntry = {
  entryId: string;
  kind: 'user' | 'assistant_final';
  at: string;
  text: string;
};

export type PublicLiveSession = {
  sessionKey: string;
  sessionType: string;
  displayTitle: string;
  startedAt: string;
  lastActivityAt: string;
  currentProvider: string | null;
  currentModel: string | null;
  entries: PublicLiveSessionEntry[];
};

export type PublicLiveSessionsFeed = {
  generatedAt: string;
  pollIntervalSeconds: number;
  idleTimeoutSeconds: number;
  historyWindowSeconds: number;
  sessions: PublicLiveSession[];
};

export type AdminMonitorLiveStatus = 'live' | 'stale' | 'degraded';
export type AdminMonitorStream = 'live_sessions' | 'latest_prompts' | 'archive_trail';
export type AdminMonitorItemKind =
  | 'session'
  | 'user'
  | 'assistant_final'
  | 'tool_call'
  | 'tool_result'
  | 'provider_switch'
  | 'request_message'
  | 'response_message'
  | 'attempt_status';

export type AdminMonitorItem = {
  id: string;
  stream: AdminMonitorStream;
  kind: AdminMonitorItemKind;
  occurredAt: string;
  title: string;
  detail: string | null;
  sessionKey: string | null;
  sessionType: 'cli' | 'openclaw' | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  href: string | null;
};

export type AdminMonitorPayload = {
  generatedAt: string;
  liveStatus: AdminMonitorLiveStatus;
  items: AdminMonitorItem[];
};

type LiveLaneReadServiceDeps = {
  db: Pick<TransactionContext, 'query'>;
  archiveReader?: Pick<AnalyticsRepository, 'getMonitorArchiveAttempts'>;
  now?: () => Date;
};

type LiveLaneRow = {
  lane_id: string;
  session_key: string;
  latest_provider: string | null;
  latest_model: string | null;
  first_event_at: string | Date | null;
  last_event_at: string | Date | null;
};

type LiveLaneEventRow = {
  lane_id: string;
  lane_event_id: string;
  event_time: string | Date;
  side: string;
  role: string | null;
  ordinal: number | null;
  render_text: string | null;
  render_summary: string | null;
};

type ArchiveSessionDraft = {
  sessionKey: string;
  sessionType: 'cli' | 'openclaw' | null;
  occurredAt: string;
  provider: string | null;
  model: string | null;
  status: string | null;
  detail: string | null;
};

export class LiveLaneReadService {
  private readonly now: () => Date;

  constructor(private readonly deps: LiveLaneReadServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async listPublicLiveSessionsFeed(): Promise<PublicLiveSessionsFeed> {
    const now = this.now();
    const generatedAt = now.toISOString();
    const lanes = await this.loadActiveLanes(now);
    if (lanes.length === 0) {
      return this.buildEmptyFeed(generatedAt);
    }

    const historySince = new Date(now.getTime() - TRANSCRIPT_HISTORY_WINDOW_MS).toISOString();
    const events = await this.loadLaneEvents(lanes.map((lane) => lane.lane_id), historySince);
    const eventsByLaneId = new Map<string, LiveLaneEventRow[]>();

    for (const event of events) {
      const existing = eventsByLaneId.get(event.lane_id) ?? [];
      existing.push(event);
      eventsByLaneId.set(event.lane_id, existing);
    }

    return {
      ...this.buildEmptyFeed(generatedAt),
      sessions: lanes.map((lane) => this.buildSession(lane, eventsByLaneId.get(lane.lane_id) ?? []))
    };
  }

  async listAdminMonitorActivityFeed(): Promise<AdminMonitorPayload> {
    const now = this.now();
    const liveFeed = await this.listPublicLiveSessionsFeed();
    const archiveAttempts = this.deps.archiveReader
      ? await this.deps.archiveReader.getMonitorArchiveAttempts({
        since: new Date(now.getTime() - MONITOR_ARCHIVE_WINDOW_MS),
        limit: MAX_MONITOR_ARCHIVE_ATTEMPTS
      })
      : [];

    return {
      generatedAt: liveFeed.generatedAt,
      liveStatus: 'live',
      items: [...buildLiveMonitorItems(liveFeed), ...buildArchiveTrailItems(archiveAttempts)]
        .filter((item) => item.title.trim().length > 0)
        .sort((left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
          || right.id.localeCompare(left.id)
        )
        .slice(0, MAX_MONITOR_ITEMS)
    };
  }

  private buildEmptyFeed(generatedAt: string): PublicLiveSessionsFeed {
    return {
      generatedAt,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      historyWindowSeconds: HISTORY_WINDOW_SECONDS,
      sessions: []
    };
  }

  private async loadActiveLanes(now: Date): Promise<LiveLaneRow[]> {
    const activeSince = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
    const sql = `
      select
        lane_id,
        session_key,
        latest_provider,
        latest_model,
        first_event_at,
        last_event_at
      from ${TABLES.liveLanes}
      where last_event_at >= $1::timestamptz
        and session_key not like 'cli:idle:%'
      order by last_event_at desc, lane_id asc
      limit $2
    `;
    const result = await this.deps.db.query<LiveLaneRow>(sql, [activeSince, MAX_SESSIONS]);
    return result.rows.filter((row) => {
      const sessionKey = readText(row.session_key);
      const startedAt = toIso(row.first_event_at);
      const lastActivityAt = toIso(row.last_event_at);
      return Boolean(sessionKey && startedAt && lastActivityAt);
    });
  }

  private async loadLaneEvents(laneIds: string[], historySince: string): Promise<LiveLaneEventRow[]> {
    if (laneIds.length === 0) {
      return [];
    }

    const sql = `
      select
        lane_id,
        lane_event_id,
        event_time,
        side,
        role,
        ordinal,
        render_text,
        render_summary
      from ${TABLES.liveLaneEvents}
      where lane_id = any($1::text[])
        and event_kind = 'message'
        and event_time >= $2::timestamptz
      order by
        array_position($1::text[], lane_id),
        event_time asc,
        case side
          when 'request' then 1
          when 'response' then 2
          when 'system' then 3
          when 'attempt' then 4
          else 5
        end asc,
        ordinal asc nulls last,
        lane_event_id asc
    `;
    const result = await this.deps.db.query<LiveLaneEventRow>(sql, [laneIds, historySince]);
    return result.rows;
  }

  private buildSession(lane: LiveLaneRow, events: LiveLaneEventRow[]): PublicLiveSession {
    const sessionKey = readText(lane.session_key) ?? 'cli:request:unknown';
    const sessionType = deriveSessionType(sessionKey);

    return {
      sessionKey,
      sessionType,
      displayTitle: `${sessionType} ${shortSessionLabel(sessionKey)}`,
      startedAt: toIso(lane.first_event_at) ?? new Date(0).toISOString(),
      lastActivityAt: toIso(lane.last_event_at) ?? new Date(0).toISOString(),
      currentProvider: readText(lane.latest_provider),
      currentModel: readText(lane.latest_model),
      entries: buildEntries(events)
    };
  }
}

function buildLiveMonitorItems(feed: PublicLiveSessionsFeed): AdminMonitorItem[] {
  const items: AdminMonitorItem[] = [];

  for (const session of feed.sessions) {
    const provider = readText(session.currentProvider);
    const model = readText(session.currentModel);

    items.push({
      id: `live-session:${session.sessionKey}`,
      stream: 'live_sessions',
      kind: 'session',
      occurredAt: session.lastActivityAt,
      title: session.displayTitle,
      detail: describeProviderModel(provider, model),
      sessionKey: session.sessionKey,
      sessionType: normalizeMonitorSessionType(session.sessionType),
      provider,
      model,
      status: 'live',
      href: null
    });

    for (const entry of session.entries) {
      items.push({
        id: entry.entryId,
        stream: 'latest_prompts',
        kind: entry.kind,
        occurredAt: entry.at,
        title: compactText(entry.text) ?? `${session.sessionKey} ${entry.kind}`,
        detail: session.displayTitle,
        sessionKey: session.sessionKey,
        sessionType: normalizeMonitorSessionType(session.sessionType),
        provider,
        model,
        status: null,
        href: null
      });
    }
  }

  return items;
}

function buildArchiveTrailItems(attempts: MonitorArchiveAttemptRecord[]): AdminMonitorItem[] {
  const items: AdminMonitorItem[] = [];
  const sessions = new Map<string, ArchiveSessionDraft>();

  for (const attempt of attempts) {
    const classification = classifyLiveLane({
      requestId: attempt.requestId,
      routeDecision: attempt.routeDecision
    });
    const sessionKey = classification.sessionKey;
    const sessionType = deriveArchiveSessionType(sessionKey);
    const provider = readText(attempt.provider);
    const model = readText(attempt.model);
    const requestAt = toIso(attempt.requestLoggedAt);
    const completionAt = maxIso(attempt.requestLoggedAt, attempt.routedAt) ?? requestAt;
    const status = deriveArchiveAttemptStatus(attempt);
    const sessionDetail = compactText(
      readText(attempt.promptPreview)
      ?? readText(attempt.responsePreview)
      ?? describeProviderModel(provider, model)
    );

    if (completionAt) {
      const current = sessions.get(sessionKey);
      if (!current || Date.parse(completionAt) >= Date.parse(current.occurredAt)) {
        sessions.set(sessionKey, {
          sessionKey,
          sessionType,
          occurredAt: completionAt,
          provider,
          model,
          status,
          detail: sessionDetail
        });
      }
    }

    if (requestAt) {
      items.push({
        id: `archive-request:${attempt.requestAttemptArchiveId}`,
        stream: 'archive_trail',
        kind: 'request_message',
        occurredAt: requestAt,
        title: compactText(readText(attempt.promptPreview)) ?? `${sessionKey} request_message`,
        detail: describeProviderModel(provider, model),
        sessionKey,
        sessionType,
        provider,
        model,
        status: null,
        href: null
      });
    }

    if (completionAt && readText(attempt.responsePreview)) {
      items.push({
        id: `archive-response:${attempt.requestAttemptArchiveId}`,
        stream: 'archive_trail',
        kind: 'response_message',
        occurredAt: completionAt,
        title: compactText(readText(attempt.responsePreview)) ?? `${sessionKey} response_message`,
        detail: describeProviderModel(provider, model),
        sessionKey,
        sessionType,
        provider,
        model,
        status: null,
        href: null
      });
    }

    if (completionAt) {
      items.push({
        id: `archive-attempt:${attempt.requestAttemptArchiveId}`,
        stream: 'archive_trail',
        kind: 'attempt_status',
        occurredAt: completionAt,
        title: compactText(`Attempt ${status}`) ?? 'Attempt update',
        detail: describeProviderModel(provider, model),
        sessionKey,
        sessionType,
        provider,
        model,
        status,
        href: null
      });
    }
  }

  for (const session of sessions.values()) {
    items.push({
      id: `archive-session:${session.sessionKey}`,
      stream: 'archive_trail',
      kind: 'session',
      occurredAt: session.occurredAt,
      title: session.sessionKey,
      detail: session.detail,
      sessionKey: session.sessionKey,
      sessionType: session.sessionType,
      provider: session.provider,
      model: session.model,
      status: session.status,
      href: null
    });
  }

  return items;
}

function buildEntries(events: LiveLaneEventRow[]): PublicLiveSessionEntry[] {
  const entries = events.flatMap((event) => {
    const text = readText(event.render_text) ?? readText(event.render_summary);
    const at = toIso(event.event_time);
    if (!text || !at) {
      return [];
    }

    if (event.side === 'request' && isUserRole(event.role)) {
      return [{
        entryId: event.lane_event_id,
        kind: 'user' as const,
        at,
        text
      }];
    }

    if (event.side === 'response' && isAssistantRole(event.role)) {
      return [{
        entryId: event.lane_event_id,
        kind: 'assistant_final' as const,
        at,
        text
      }];
    }

    return [];
  });

  return entries.length > MAX_SESSION_ENTRIES
    ? entries.slice(-MAX_SESSION_ENTRIES)
    : entries;
}

function isUserRole(role: string | null): boolean {
  return role == null || role === 'user';
}

function isAssistantRole(role: string | null): boolean {
  return role == null || role === 'assistant';
}

function deriveSessionType(sessionKey: string): string {
  const [sessionType] = sessionKey.split(':');
  return readText(sessionType) ?? 'cli';
}

function deriveArchiveSessionType(sessionKey: string): 'cli' | 'openclaw' | null {
  if (sessionKey.startsWith('cli:openclaw:')) {
    return 'openclaw';
  }
  if (sessionKey.startsWith('cli:')) {
    return 'cli';
  }
  return null;
}

function normalizeMonitorSessionType(sessionType: string): 'cli' | 'openclaw' | null {
  return sessionType === 'openclaw' || sessionType === 'cli'
    ? sessionType
    : null;
}

function shortSessionLabel(sessionKey: string): string {
  const lastSegment = sessionKey.split(':').at(-1) ?? sessionKey;
  if (lastSegment.length <= 16) {
    return lastSegment;
  }
  return `${lastSegment.slice(0, 8)}...${lastSegment.slice(-4)}`;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function maxIso(left: string | Date | null, right: string | Date | null): string | null {
  const leftIso = toIso(left);
  const rightIso = toIso(right);
  if (!leftIso) return rightIso;
  if (!rightIso) return leftIso;
  return Date.parse(leftIso) >= Date.parse(rightIso) ? leftIso : rightIso;
}

function compactText(value: string | null, maxLength = 240): string | null {
  if (!value) {
    return null;
  }

  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length === 0) {
    return null;
  }

  return compacted.length <= maxLength
    ? compacted
    : `${compacted.slice(0, maxLength - 3)}...`;
}

function describeProviderModel(provider: string | null, model: string | null): string | null {
  const parts = [provider, model].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' / ') : null;
}

function deriveArchiveAttemptStatus(attempt: MonitorArchiveAttemptRecord): string {
  if (typeof attempt.upstreamStatus === 'number') {
    return attempt.upstreamStatus >= 200 && attempt.upstreamStatus < 300 ? 'completed' : 'failed';
  }
  if (readText(attempt.errorCode)) {
    return 'failed';
  }
  return 'unknown';
}
