import type { RequestLogRepository, LiveLaneProjectorInput } from '../../repos/requestLogRepository.js';
import { LiveLaneAttemptRepository, type LiveLaneAttemptUpsertInput } from '../../repos/liveLaneAttemptRepository.js';
import { LiveLaneEventRepository, type LiveLaneEventUpsertInput } from '../../repos/liveLaneEventRepository.js';
import {
  LiveLaneProjectionOutboxRepository,
  type LiveLaneProjectionOutboxRow
} from '../../repos/liveLaneProjectionOutboxRepository.js';
import { LiveLaneRepository, type LiveLaneUpsertInput } from '../../repos/liveLaneRepository.js';
import type { SqlClient } from '../../repos/sqlClient.js';
import { extractRequestPreview, extractResponsePreview } from '../../utils/requestLogPreview.js';
import { classifyLiveLane } from './liveLaneClassifier.js';
import {
  LIVE_LANE_PROJECTION_VERSION,
  buildLiveLaneEventId
} from './liveLaneTypes.js';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BACKFILL_LIMIT = 100;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 60_000;

type LiveLaneProjectorServiceDeps = {
  db: SqlClient;
  requestLogRepo: Pick<RequestLogRepository, 'findLiveLaneProjectorInput'>;
  outboxRepo?: Pick<
    LiveLaneProjectionOutboxRepository,
    'backfillJoinedAttempts' | 'listDueForProjection' | 'markPendingRetry' | 'markNeedsOperatorCorrection'
  >;
  now?: () => Date;
  retryDelayMs?: number;
  maxRetries?: number;
  backfillLimit?: number;
};

export type LiveLaneProjectionDraft = {
  lane: LiveLaneUpsertInput;
  attempt: LiveLaneAttemptUpsertInput;
  events: LiveLaneEventUpsertInput[];
};

export type LiveLaneProjectionResult = {
  requestAttemptArchiveId: string;
  laneId: string;
  sessionKey: string;
  laneEventIds: string[];
  projectedEventCount: number;
};

export class LiveLaneProjectorService {
  private readonly now: () => Date;
  private readonly outboxRepo: Pick<
    LiveLaneProjectionOutboxRepository,
    'backfillJoinedAttempts' | 'listDueForProjection' | 'markPendingRetry' | 'markNeedsOperatorCorrection'
  >;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly backfillLimit: number;

  constructor(private readonly deps: LiveLaneProjectorServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.outboxRepo = deps.outboxRepo ?? new LiveLaneProjectionOutboxRepository(deps.db);
    this.retryDelayMs = Math.max(1, deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.maxRetries = Math.max(1, deps.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.backfillLimit = Math.max(1, deps.backfillLimit ?? DEFAULT_BACKFILL_LIMIT);
  }

  async projectRequestAttemptArchive(requestAttemptArchiveId: string): Promise<LiveLaneProjectionResult> {
    const projectorInput = await this.deps.requestLogRepo.findLiveLaneProjectorInput(requestAttemptArchiveId);
    if (!projectorInput) {
      throw new Error(`live lane projector input not found for request attempt archive ${requestAttemptArchiveId}`);
    }

    const draft = buildLiveLaneProjection(projectorInput);

    await this.deps.db.transaction(async (tx) => {
      const laneRepo = new LiveLaneRepository(tx);
      const attemptRepo = new LiveLaneAttemptRepository(tx);
      const eventRepo = new LiveLaneEventRepository(tx);
      const outboxRepo = new LiveLaneProjectionOutboxRepository(tx);

      await laneRepo.upsertLane(draft.lane);
      await attemptRepo.upsertAttempt(draft.attempt);
      for (const event of draft.events) {
        await eventRepo.upsertEvent(event);
      }
      await outboxRepo.markProjected({ requestAttemptArchiveId });
    });

    return {
      requestAttemptArchiveId,
      laneId: draft.lane.laneId,
      sessionKey: draft.lane.sessionKey,
      laneEventIds: draft.events.map((event) => event.laneEventId),
      projectedEventCount: draft.events.length
    };
  }

  async retryBacklog(input?: {
    limit?: number;
    backfillLimit?: number;
  }): Promise<{
    backfilled: number;
    processed: number;
    projected: number;
    failed: number;
  }> {
    const now = this.now();
    const limit = Math.max(1, input?.limit ?? DEFAULT_BATCH_SIZE);
    const dueRows = await this.outboxRepo.listDueForProjection({
      now,
      limit
    });
    const initialAttempt = await this.projectRows(dueRows);

    const remainingCapacity = Math.max(0, limit - dueRows.length);
    let backfilled = 0;
    let catchUpAttempt = { processed: 0, projected: 0, failed: 0 };

    if (remainingCapacity > 0) {
      const backfillRows = await this.outboxRepo.backfillJoinedAttempts({
        availableAt: now,
        limit: Math.min(
          remainingCapacity,
          Math.max(1, input?.backfillLimit ?? this.backfillLimit)
        )
      });
      backfilled = backfillRows.length;

      if (backfilled > 0) {
        const catchUpRows = await this.outboxRepo.listDueForProjection({
          now,
          limit: remainingCapacity
        });
        catchUpAttempt = await this.projectRows(catchUpRows);
      }
    }

    return {
      backfilled,
      processed: initialAttempt.processed + catchUpAttempt.processed,
      projected: initialAttempt.projected + catchUpAttempt.projected,
      failed: initialAttempt.failed + catchUpAttempt.failed
    };
  }

  private async projectRows(rows: LiveLaneProjectionOutboxRow[]): Promise<{
    processed: number;
    projected: number;
    failed: number;
  }> {
    let projected = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await this.projectRequestAttemptArchive(row.request_attempt_archive_id);
        projected += 1;
      } catch (error) {
        failed += 1;
        await this.handleProjectionFailure(row, error);
      }
    }

    return {
      processed: rows.length,
      projected,
      failed
    };
  }

  private async handleProjectionFailure(
    row: LiveLaneProjectionOutboxRow,
    error: unknown
  ): Promise<void> {
    const retryCount = row.retry_count + 1;
    const message = error instanceof Error ? error.message : 'unknown live lane projector failure';
    const lastAttemptAt = this.now();

    if (retryCount >= this.maxRetries) {
      await this.outboxRepo.markNeedsOperatorCorrection({
        requestAttemptArchiveId: row.request_attempt_archive_id,
        retryCount,
        lastAttemptAt,
        nextRetryAt: null,
        lastErrorCode: 'live_lane_projection_failed',
        lastErrorMessage: message
      });
      return;
    }

    await this.outboxRepo.markPendingRetry({
      requestAttemptArchiveId: row.request_attempt_archive_id,
      retryCount,
      lastAttemptAt,
      nextRetryAt: new Date(lastAttemptAt.getTime() + this.retryDelayMs),
      lastErrorCode: 'live_lane_projection_failed',
      lastErrorMessage: message
    });
  }
}

export function buildLiveLaneProjection(input: LiveLaneProjectorInput): LiveLaneProjectionDraft {
  const routeDecision = input.routeDecision ?? {};
  const requestSource = readRouteDecisionString(routeDecision, 'request_source');
  const openclawSessionId = readRouteDecisionString(routeDecision, 'openclaw_session_id');
  const openclawRunId = readRouteDecisionString(routeDecision, 'openclaw_run_id');
  const providerSelectionReason = readRouteDecisionString(routeDecision, 'provider_selection_reason');
  const classification = classifyLiveLane({
    requestId: input.requestId,
    requestSource,
    openclawSessionId,
    openclawRunId,
    routeDecision
  });
  const requestEventTime = input.requestLoggedAt;
  const completionEventTime = new Date(Math.max(
    input.requestLoggedAt.getTime(),
    input.routedAt.getTime()
  ));
  const requestText = deriveRequestRenderText(input);
  const responseText = deriveResponseRenderText(input);
  const status = deriveAttemptStatus(input);
  const requestEvent = requestText
    ? {
      laneEventId: buildLiveLaneEventId({
        requestAttemptArchiveId: input.requestAttemptArchiveId,
        eventKind: 'message',
        side: 'request',
        ordinal: 1
      }),
      laneId: classification.laneId,
      requestAttemptArchiveId: input.requestAttemptArchiveId,
      requestId: input.requestId,
      attemptNo: input.attemptNo,
      side: 'request',
      ordinal: 1,
      eventKind: 'message',
      eventTime: requestEventTime,
      role: 'user',
      provider: input.provider,
      model: input.model,
      renderText: requestText,
      renderSummary: input.promptPreview ?? requestText,
      renderMeta: {
        proxiedPath: input.proxiedPath,
        contentType: input.requestContentType,
        source: input.fullPrompt ? 'full_prompt' : 'prompt_preview'
      },
      projectionVersion: LIVE_LANE_PROJECTION_VERSION
    } satisfies LiveLaneEventUpsertInput
    : null;
  const responseEvent = responseText
    ? {
      laneEventId: buildLiveLaneEventId({
        requestAttemptArchiveId: input.requestAttemptArchiveId,
        eventKind: 'message',
        side: 'response',
        ordinal: 1
      }),
      laneId: classification.laneId,
      requestAttemptArchiveId: input.requestAttemptArchiveId,
      requestId: input.requestId,
      attemptNo: input.attemptNo,
      side: 'response',
      ordinal: 1,
      eventKind: 'message',
      eventTime: completionEventTime,
      role: 'assistant',
      provider: input.provider,
      model: input.model,
      status,
      renderText: responseText,
      renderSummary: input.responsePreview ?? responseText,
      renderMeta: {
        proxiedPath: input.proxiedPath,
        contentType: input.responseContentType,
        upstreamStatus: input.upstreamStatus,
        errorCode: input.errorCode,
        source: input.fullResponse ? 'full_response' : 'response_preview'
      },
      projectionVersion: LIVE_LANE_PROJECTION_VERSION
    } satisfies LiveLaneEventUpsertInput
    : null;
  const attemptStatusEvent = {
    laneEventId: buildLiveLaneEventId({
      requestAttemptArchiveId: input.requestAttemptArchiveId,
      eventKind: 'attempt_status'
    }),
    laneId: classification.laneId,
    requestAttemptArchiveId: input.requestAttemptArchiveId,
    requestId: input.requestId,
    attemptNo: input.attemptNo,
    side: 'attempt',
    eventKind: 'attempt_status',
    eventTime: completionEventTime,
    provider: input.provider,
    model: input.model,
    status,
    renderSummary: buildAttemptStatusSummary(input, status),
    renderMeta: {
      requestSource,
      providerSelectionReason,
      openclawSessionId,
      openclawRunId,
      buyerApiKeyId: input.buyerApiKeyId,
      sellerKeyId: input.sellerKeyId,
      streaming: input.streaming,
      upstreamStatus: input.upstreamStatus,
      errorCode: input.errorCode,
      latencyMs: input.latencyMs,
      ttfbMs: input.ttfbMs
    },
    projectionVersion: LIVE_LANE_PROJECTION_VERSION
  } satisfies LiveLaneEventUpsertInput;
  const events = [requestEvent, responseEvent, attemptStatusEvent].filter(isPresent);
  const eventTimes = events.map((event) => event.eventTime.getTime());
  const firstEventAt = eventTimes.length > 0
    ? new Date(Math.min(...eventTimes))
    : completionEventTime;
  const lastEventAt = eventTimes.length > 0
    ? new Date(Math.max(...eventTimes))
    : completionEventTime;

  return {
    lane: {
      ...classification,
      buyerApiKeyId: input.buyerApiKeyId,
      latestRequestId: input.requestId,
      latestAttemptNo: input.attemptNo,
      latestRequestAttemptArchiveId: input.requestAttemptArchiveId,
      latestProvider: input.provider,
      latestModel: input.model,
      firstEventAt,
      lastEventAt
    },
    attempt: {
      laneId: classification.laneId,
      requestAttemptArchiveId: input.requestAttemptArchiveId,
      requestId: input.requestId,
      attemptNo: input.attemptNo,
      buyerApiKeyId: input.buyerApiKeyId,
      provider: input.provider,
      model: input.model,
      requestSource,
      eventTime: completionEventTime,
      projectionVersion: LIVE_LANE_PROJECTION_VERSION
    },
    events
  };
}

function deriveRequestRenderText(input: LiveLaneProjectorInput): string | null {
  const parsed = parseSerializedBody(input.fullPrompt);
  if (parsed !== null) {
    return extractRequestPreview(parsed, input.proxiedPath ?? '') ?? input.promptPreview;
  }
  return input.promptPreview;
}

function deriveResponseRenderText(input: LiveLaneProjectorInput): string | null {
  const parsed = parseSerializedBody(input.fullResponse);
  if (parsed !== null) {
    return extractResponsePreview(parsed) ?? input.responsePreview;
  }
  return input.responsePreview;
}

function deriveAttemptStatus(input: LiveLaneProjectorInput): string {
  if (typeof input.upstreamStatus === 'number') {
    return input.upstreamStatus >= 200 && input.upstreamStatus < 300 ? 'completed' : 'failed';
  }
  if (input.errorCode) {
    return 'failed';
  }
  return 'unknown';
}

function buildAttemptStatusSummary(input: LiveLaneProjectorInput, status: string): string {
  const statusCode = typeof input.upstreamStatus === 'number' ? String(input.upstreamStatus) : 'unknown';
  if (input.errorCode) {
    return `${status}:${statusCode}:${input.errorCode}`;
  }
  return `${status}:${statusCode}`;
}

function parseSerializedBody(body: string | null): unknown {
  if (body === null) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function readRouteDecisionString(
  routeDecision: Record<string, unknown>,
  key: string
): string | null {
  const value = routeDecision[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
