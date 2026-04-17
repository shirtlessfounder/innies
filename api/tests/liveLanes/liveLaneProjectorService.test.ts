import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveLaneProjectorJob } from '../../src/jobs/liveLaneProjectorJob.js';
import { RequestLogRepository, type LiveLaneProjectorInput } from '../../src/repos/requestLogRepository.js';
import { RoutingEventsRepository } from '../../src/repos/routingEventsRepository.js';
import {
  buildLiveLaneProjection,
  LiveLaneProjectorService
} from '../../src/services/liveLanes/liveLaneProjectorService.js';
import { encryptSecret } from '../../src/utils/crypto.js';
import { createLoggerSpy, MockSqlClient, SequenceSqlClient } from '../testHelpers.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

describe('buildLiveLaneProjection', () => {
  it('projects canonical lane and reference-first events from phase-1 request log content', () => {
    const draft = buildLiveLaneProjection(buildProjectorInput());

    expect(draft.lane).toMatchObject({
      laneId: 'lane:openclaw_session:oc_sess_1',
      sessionKey: 'cli:openclaw:oc_sess_1',
      laneSourceKind: 'openclaw_session',
      laneSourceId: 'oc_sess_1',
      latestRequestId: 'req_project_1',
      latestAttemptNo: 2,
      latestRequestAttemptArchiveId: '11111111-1111-4111-8111-111111111111'
    });
    expect(draft.lane.sessionKey).not.toMatch(/^cli:idle:/);
    expect(draft.attempt).toMatchObject({
      laneId: 'lane:openclaw_session:oc_sess_1',
      requestAttemptArchiveId: '11111111-1111-4111-8111-111111111111',
      requestSource: 'cli-codex'
    });
    expect(draft.events.map((event) => event.laneEventId)).toEqual([
      'laneevt:11111111-1111-4111-8111-111111111111:request:1',
      'laneevt:11111111-1111-4111-8111-111111111111:response:1',
      'laneevt:11111111-1111-4111-8111-111111111111:attempt_status'
    ]);
    expect(draft.events[0]).toMatchObject({
      side: 'request',
      role: 'user'
    });
    expect(draft.events[0]?.renderText).toContain('You are a helpful assistant.');
    expect(draft.events[0]?.renderText).toContain('say hello to Innies');
    expect(draft.events[1]).toMatchObject({
      side: 'response',
      role: 'assistant',
      status: 'completed',
      renderText: 'hello from Innies'
    });
    expect(draft.events[2]).toMatchObject({
      side: 'attempt',
      eventKind: 'attempt_status',
      status: 'completed',
      renderSummary: 'completed:200'
    });
    expect(draft.events[2].renderMeta).toMatchObject({
      requestSource: 'cli-codex',
      providerSelectionReason: 'cli_provider_pinned',
      openclawSessionId: 'oc_sess_1',
      openclawRunId: 'run_1',
      latencyMs: 812,
      ttfbMs: 144
    });
    expect(draft.events[0].renderMeta).not.toHaveProperty('fullPrompt');
    expect(draft.events[1].renderMeta).not.toHaveProperty('fullResponse');
  });

  it('keeps canonical lane_event_ids unique when attempts in one lane reuse ordinal 1', () => {
    const firstDraft = buildLiveLaneProjection(buildProjectorInput({
      requestAttemptArchiveId: '11111111-1111-4111-8111-111111111111',
      requestId: 'req_project_1'
    }));
    const secondDraft = buildLiveLaneProjection(buildProjectorInput({
      requestAttemptArchiveId: '22222222-2222-4222-8222-222222222222',
      requestId: 'req_project_2'
    }));

    const laneEventIds = new Set([
      ...firstDraft.events.map((event) => event.laneEventId),
      ...secondDraft.events.map((event) => event.laneEventId)
    ]);

    expect(firstDraft.lane.laneId).toBe(secondDraft.lane.laneId);
    expect(laneEventIds.size).toBe(6);
    expect([...laneEventIds]).toContain('laneevt:22222222-2222-4222-8222-222222222222:request:1');
  });
});

describe('RequestLogRepository', () => {
  const originalEncryptionKey = process.env.SELLER_SECRET_ENC_KEY_B64;

  beforeEach(() => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.SELLER_SECRET_ENC_KEY_B64;
      return;
    }
    process.env.SELLER_SECRET_ENC_KEY_B64 = originalEncryptionKey;
  });

  it('requeues a joined routed attempt into the live lane outbox when request log persistence succeeds', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{ id: '11111111-1111-4111-8111-111111111111' }],
        rowCount: 1
      },
      {
        rows: [{
          request_attempt_archive_id: '11111111-1111-4111-8111-111111111111'
        }],
        rowCount: 1
      }
    ]);
    const repo = new RequestLogRepository(db, () => '99999999-9999-4999-8999-999999999999');

    const archiveId = await repo.insert({
      requestId: 'req_enqueue_1',
      attemptNo: 1,
      orgId: '33333333-3333-4333-8333-333333333333',
      provider: 'openai',
      model: 'gpt-5.4',
      proxiedPath: '/v1/responses',
      requestContentType: 'application/json',
      responseContentType: 'application/json',
      promptPreview: 'prompt',
      responsePreview: 'response',
      fullPrompt: '{"input":"prompt"}',
      fullResponse: '{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"response"}]}]}'
    });

    expect(archiveId).toBe('11111111-1111-4111-8111-111111111111');
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1].sql).toContain('insert into in_live_lane_projection_outbox');
    expect(db.queries[1].sql).toContain('join in_routing_events');
    expect(db.queries[1].params?.slice(0, 3)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      'req_enqueue_1',
      1
    ]);
  });

  it('loads projector input by joining request log rows to routed attempt truth on org/request/attempt', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_attempt_archive_id: '11111111-1111-4111-8111-111111111111',
        request_id: 'req_project_1',
        attempt_no: 2,
        org_id: '33333333-3333-4333-8333-333333333333',
        proxied_path: '/v1/responses',
        request_content_type: 'application/json',
        response_content_type: 'text/event-stream; charset=utf-8',
        prompt_preview: 'say hello to Innies',
        response_preview: 'hello from Innies',
        full_prompt_encrypted: encryptSecret('{"instructions":"You are a helpful assistant.","input":[{"role":"user","content":"say hello to Innies"}]}'),
        full_response_encrypted: encryptSecret('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello from Innies"}],"status":"completed"}}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n'),
        request_logged_at: '2026-04-16T03:04:05.000Z',
        buyer_api_key_id: '44444444-4444-4444-8444-444444444444',
        seller_key_id: null,
        provider: 'openai',
        model: 'gpt-5.4',
        streaming: true,
        route_decision: JSON.stringify({
          request_source: 'cli-codex',
          provider_selection_reason: 'cli_provider_pinned',
          openclaw_session_id: 'oc_sess_1',
          openclaw_run_id: 'run_1'
        }),
        upstream_status: 200,
        error_code: null,
        latency_ms: 812,
        ttfb_ms: 144,
        routed_at: '2026-04-16T03:04:06.000Z'
      }],
      rowCount: 1
    });
    const repo = new RequestLogRepository(db);

    const projectorInput = await repo.findLiveLaneProjectorInput('11111111-1111-4111-8111-111111111111');

    expect(projectorInput).toEqual(buildProjectorInput());
    expect(db.queries[0].sql).toContain('join in_routing_events');
    expect(db.queries[0].sql).toContain('where rl.id = $1');
  });
});

describe('RoutingEventsRepository', () => {
  it('requeues a joined request log archive into the live lane outbox when routing truth persists', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 1 },
      {
        rows: [{
          request_attempt_archive_id: '11111111-1111-4111-8111-111111111111'
        }],
        rowCount: 1
      }
    ]);
    const repo = new RoutingEventsRepository(db, () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    await repo.insert({
      requestId: 'req_enqueue_2',
      attemptNo: 1,
      orgId: '33333333-3333-4333-8333-333333333333',
      apiKeyId: '44444444-4444-4444-8444-444444444444',
      provider: 'openai',
      model: 'gpt-5.4',
      streaming: true,
      routeDecision: {
        request_source: 'cli-codex',
        provider_selection_reason: 'cli_provider_pinned',
        openclaw_session_id: 'oc_sess_1'
      },
      upstreamStatus: 200,
      latencyMs: 300,
      ttfbMs: 50
    });

    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].sql).toContain('insert into in_routing_events');
    expect(db.queries[1].sql).toContain('insert into in_live_lane_projection_outbox');
    expect(db.queries[1].params?.slice(0, 3)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      'req_enqueue_2',
      1
    ]);
  });
});

describe('LiveLaneProjectorService', () => {
  it('upserts lane, lane attempt, lane events, and marks the outbox projected', async () => {
    const db = new SequenceSqlClient([
      { rows: [{ lane_id: 'lane:openclaw_session:oc_sess_1' }], rowCount: 1 },
      { rows: [{ request_attempt_archive_id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 },
      { rows: [{ lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:request:1' }], rowCount: 1 },
      { rows: [{ lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:response:1' }], rowCount: 1 },
      { rows: [{ lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:attempt_status' }], rowCount: 1 },
      { rows: [{ request_attempt_archive_id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 }
    ]);
    const requestLogRepo = {
      findLiveLaneProjectorInput: vi.fn().mockResolvedValue(buildProjectorInput())
    };
    const service = new LiveLaneProjectorService({
      db,
      requestLogRepo
    });

    const result = await service.projectRequestAttemptArchive('11111111-1111-4111-8111-111111111111');

    expect(result).toEqual({
      requestAttemptArchiveId: '11111111-1111-4111-8111-111111111111',
      laneId: 'lane:openclaw_session:oc_sess_1',
      sessionKey: 'cli:openclaw:oc_sess_1',
      laneEventIds: [
        'laneevt:11111111-1111-4111-8111-111111111111:request:1',
        'laneevt:11111111-1111-4111-8111-111111111111:response:1',
        'laneevt:11111111-1111-4111-8111-111111111111:attempt_status'
      ],
      projectedEventCount: 3
    });
    expect(db.queries).toHaveLength(6);
    expect(db.queries[0].sql).toContain('insert into in_live_lanes');
    expect(db.queries[1].sql).toContain('insert into in_live_lane_attempts');
    expect(db.queries[2].sql).toContain('insert into in_live_lane_events');
    expect(db.queries[5].sql).toContain('update in_live_lane_projection_outbox');
  });

  it('backfills missing joined rows and marks failed projections for retry', async () => {
    const backfillJoinedAttempts = vi.fn().mockResolvedValue([]);
    const listDueForProjection = vi.fn().mockResolvedValue([
      {
        request_attempt_archive_id: '11111111-1111-4111-8111-111111111111',
        request_id: 'req_missing',
        attempt_no: 1,
        state: 'pending_projection',
        retry_count: 0,
        available_at: '2026-04-16T03:04:05.000Z',
        last_attempt_at: null,
        next_retry_at: null,
        projected_at: null,
        last_error_code: null,
        last_error_message: null,
        projection_version: 1,
        created_at: '2026-04-16T03:04:05.000Z',
        updated_at: '2026-04-16T03:04:05.000Z'
      }
    ]);
    const markPendingRetry = vi.fn().mockResolvedValue(undefined);
    const markNeedsOperatorCorrection = vi.fn().mockResolvedValue(undefined);
    const service = new LiveLaneProjectorService({
      db: new MockSqlClient(),
      requestLogRepo: {
        findLiveLaneProjectorInput: vi.fn().mockResolvedValue(null)
      },
      outboxRepo: {
        backfillJoinedAttempts,
        listDueForProjection,
        markPendingRetry,
        markNeedsOperatorCorrection
      },
      now: () => new Date('2026-04-16T03:05:00.000Z'),
      retryDelayMs: 30_000,
      maxRetries: 3
    });

    const result = await service.retryBacklog({ limit: 10, backfillLimit: 20 });

    expect(result).toEqual({
      backfilled: 0,
      processed: 1,
      projected: 0,
      failed: 1
    });
    expect(backfillJoinedAttempts).toHaveBeenCalledWith({
      availableAt: new Date('2026-04-16T03:05:00.000Z'),
      limit: 20
    });
    expect(markPendingRetry).toHaveBeenCalledWith({
      requestAttemptArchiveId: '11111111-1111-4111-8111-111111111111',
      retryCount: 1,
      lastAttemptAt: new Date('2026-04-16T03:05:00.000Z'),
      nextRetryAt: new Date('2026-04-16T03:05:30.000Z'),
      lastErrorCode: 'live_lane_projection_failed',
      lastErrorMessage: 'live lane projector input not found for request attempt archive 11111111-1111-4111-8111-111111111111'
    });
    expect(markNeedsOperatorCorrection).not.toHaveBeenCalled();
  });
});

describe('createLiveLaneProjectorJob', () => {
  it('runs the projector backlog batch on start and logs the batch summary', async () => {
    const { logger, infoCalls } = createLoggerSpy();
    const retryBacklog = vi.fn().mockResolvedValue({
      backfilled: 2,
      processed: 3,
      projected: 3,
      failed: 0
    });
    const job = createLiveLaneProjectorJob({
      retryBacklog
    } as unknown as LiveLaneProjectorService);

    expect(job.runOnStart).toBe(true);

    await job.run({
      now: new Date('2026-04-16T03:05:00.000Z'),
      logger
    });

    expect(retryBacklog).toHaveBeenCalledWith({
      limit: 25,
      backfillLimit: 100
    });
    expect(infoCalls).toEqual([{
      message: 'live lane projector batch processed',
      fields: {
        backfilled: 2,
        processed: 3,
        projected: 3,
        failed: 0,
        asOf: '2026-04-16T03:05:00.000Z'
      }
    }]);
  });
});

function buildProjectorInput(overrides: Partial<LiveLaneProjectorInput> = {}): LiveLaneProjectorInput {
  return {
    requestAttemptArchiveId: '11111111-1111-4111-8111-111111111111',
    requestId: 'req_project_1',
    attemptNo: 2,
    orgId: '33333333-3333-4333-8333-333333333333',
    proxiedPath: '/v1/responses',
    requestContentType: 'application/json',
    responseContentType: 'text/event-stream; charset=utf-8',
    promptPreview: 'say hello to Innies',
    responsePreview: 'hello from Innies',
    fullPrompt: '{"instructions":"You are a helpful assistant.","input":[{"role":"user","content":"say hello to Innies"}]}',
    fullResponse: 'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello from Innies"}],"status":"completed"}}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
    requestLoggedAt: new Date('2026-04-16T03:04:05.000Z'),
    buyerApiKeyId: '44444444-4444-4444-8444-444444444444',
    sellerKeyId: null,
    provider: 'openai',
    model: 'gpt-5.4',
    streaming: true,
    routeDecision: {
      request_source: 'cli-codex',
      provider_selection_reason: 'cli_provider_pinned',
      openclaw_session_id: 'oc_sess_1',
      openclaw_run_id: 'run_1'
    },
    upstreamStatus: 200,
    errorCode: null,
    latencyMs: 812,
    ttfbMs: 144,
    routedAt: new Date('2026-04-16T03:04:06.000Z'),
    ...overrides
  };
}
