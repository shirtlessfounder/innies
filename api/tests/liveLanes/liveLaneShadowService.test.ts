import { describe, expect, it } from 'vitest';
import {
  KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID,
  LiveLaneShadowService
} from '../../src/services/liveLanes/liveLaneShadowService.js';
import { SequenceSqlClient } from '../testHelpers.js';

describe('LiveLaneShadowService', () => {
  it('reports explicit machine-countable mismatch buckets against source truth and canonical tables', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [
          buildSourceTruthRow({
            request_attempt_archive_id: '11111111-1111-4111-8111-111111111111',
            request_id: 'req_membership_latest',
            route_decision: buildRouteDecision({ openclaw_session_id: 'oc_membership' }),
            request_logged_at: '2026-04-16T10:05:00.000Z',
            routed_at: '2026-04-16T10:05:01.000Z'
          }),
          buildSourceTruthRow({
            request_attempt_archive_id: '22222222-2222-4222-8222-222222222222',
            request_id: 'req_membership_old',
            route_decision: buildRouteDecision({ openclaw_session_id: 'oc_membership' }),
            request_logged_at: '2026-04-16T10:00:00.000Z',
            routed_at: '2026-04-16T10:00:01.000Z'
          }),
          buildSourceTruthRow({
            request_attempt_archive_id: '33333333-3333-4333-8333-333333333333',
            request_id: 'req_source_only',
            prompt_preview: 'only source prompt',
            response_preview: null,
            route_decision: buildRouteDecision({
              request_source: 'api',
              openclaw_session_id: null,
              provider_selection_reason: 'buyer_preference'
            }),
            request_logged_at: '2026-04-16T10:10:00.000Z',
            routed_at: '2026-04-16T10:10:01.000Z'
          }),
          buildSourceTruthRow({
            request_attempt_archive_id: '44444444-4444-4444-8444-444444444444',
            request_id: 'req_event_count',
            prompt_preview: null,
            response_preview: null,
            route_decision: buildRouteDecision({ openclaw_session_id: 'oc_event_count' }),
            request_logged_at: '2026-04-16T10:20:00.000Z',
            routed_at: '2026-04-16T10:20:01.000Z'
          }),
          buildSourceTruthRow({
            request_attempt_archive_id: '55555555-5555-4555-8555-555555555555',
            request_id: 'req_time_mismatch',
            route_decision: buildRouteDecision({ openclaw_session_id: 'oc_time' }),
            request_logged_at: '2026-04-16T10:30:00.000Z',
            routed_at: '2026-04-16T10:30:01.000Z'
          })
        ],
        rowCount: 5
      },
      {
        rows: [
          buildCanonicalLaneRow({
            lane_id: 'lane:openclaw_session:oc_canonical_only',
            session_key: 'cli:openclaw:oc_canonical_only',
            lane_source_kind: 'openclaw_session',
            lane_source_id: 'oc_canonical_only',
            buyer_api_key_id: '44444444-4444-4444-8444-444444444444',
            last_event_at: '2026-04-16T10:40:01.000Z'
          }),
          buildCanonicalLaneRow({
            lane_id: 'lane:openclaw_session:oc_event_count',
            session_key: 'cli:openclaw:oc_event_count',
            lane_source_kind: 'openclaw_session',
            lane_source_id: 'oc_event_count',
            buyer_api_key_id: '44444444-4444-4444-8444-444444444444',
            last_event_at: '2026-04-16T10:20:01.000Z'
          }),
          buildCanonicalLaneRow({
            lane_id: 'lane:openclaw_session:oc_membership',
            session_key: 'cli:openclaw:oc_membership',
            lane_source_kind: 'openclaw_session',
            lane_source_id: 'oc_membership',
            buyer_api_key_id: '44444444-4444-4444-8444-444444444444',
            last_event_at: '2026-04-16T10:05:01.000Z'
          }),
          buildCanonicalLaneRow({
            lane_id: 'lane:openclaw_session:oc_time',
            session_key: 'cli:openclaw:oc_time',
            lane_source_kind: 'openclaw_session',
            lane_source_id: 'oc_time',
            buyer_api_key_id: '44444444-4444-4444-8444-444444444444',
            last_event_at: '2026-04-16T10:29:59.000Z'
          }),
          buildCanonicalLaneRow({
            lane_id: 'lane:request:req_orphan',
            session_key: 'cli:request:req_orphan',
            lane_source_kind: 'request',
            lane_source_id: 'req_orphan',
            buyer_api_key_id: null,
            last_event_at: null
          })
        ],
        rowCount: 5
      },
      {
        rows: [
          buildCanonicalAttemptRow({
            lane_id: 'lane:openclaw_session:oc_canonical_only',
            request_attempt_archive_id: '66666666-6666-4666-8666-666666666666'
          }),
          buildCanonicalAttemptRow({
            lane_id: 'lane:openclaw_session:oc_event_count',
            request_attempt_archive_id: '44444444-4444-4444-8444-444444444444'
          }),
          buildCanonicalAttemptRow({
            lane_id: 'lane:openclaw_session:oc_membership',
            request_attempt_archive_id: '11111111-1111-4111-8111-111111111111'
          }),
          buildCanonicalAttemptRow({
            lane_id: 'lane:openclaw_session:oc_time',
            request_attempt_archive_id: '55555555-5555-4555-8555-555555555555'
          })
        ],
        rowCount: 4
      },
      {
        rows: [
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_canonical_only',
            lane_event_id: 'laneevt:66666666-6666-4666-8666-666666666666:request:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_canonical_only',
            lane_event_id: 'laneevt:66666666-6666-4666-8666-666666666666:response:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_canonical_only',
            lane_event_id: 'laneevt:66666666-6666-4666-8666-666666666666:attempt_status'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_event_count',
            lane_event_id: 'laneevt:44444444-4444-4444-8444-444444444444:request:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_event_count',
            lane_event_id: 'laneevt:44444444-4444-4444-8444-444444444444:attempt_status'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_membership',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:request:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_membership',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:response:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_membership',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:attempt_status'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_time',
            lane_event_id: 'laneevt:55555555-5555-4555-8555-555555555555:request:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_time',
            lane_event_id: 'laneevt:55555555-5555-4555-8555-555555555555:response:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:openclaw_session:oc_time',
            lane_event_id: 'laneevt:55555555-5555-4555-8555-555555555555:attempt_status'
          })
        ],
        rowCount: 11
      }
    ]);
    const service = new LiveLaneShadowService({ db });

    const report = await service.diff();

    expect(report.scope).toEqual({ buyerApiKeyId: null });
    expect(report.totals).toEqual({
      sourceLaneCount: 4,
      canonicalLaneCount: 5,
      sourceAttemptCount: 5,
      canonicalAttemptCount: 4,
      sourceEventCount: 12,
      canonicalEventCount: 11
    });
    expect(report.laneCount).toEqual({
      source: 4,
      canonical: 5,
      matches: false
    });
    expect(report.mismatchCounts).toEqual({
      sourceOnlyLaneCount: 1,
      canonicalOnlyLaneCount: 2,
      membershipMismatchCount: 1,
      eventCountMismatchCount: 2,
      latestActivityMismatchCount: 1
    });
    expect(report.mismatches.sourceOnlyLanes).toEqual([
      {
        laneId: 'lane:request:req_source_only',
        sessionKey: 'cli:request:req_source_only',
        laneSourceKind: 'request',
        laneSourceId: 'req_source_only',
        buyerApiKeyId: '44444444-4444-4444-8444-444444444444',
        attemptIds: ['33333333-3333-4333-8333-333333333333'],
        attemptCount: 1,
        eventCount: 2,
        latestActivityAt: '2026-04-16T10:10:01.000Z'
      }
    ]);
    expect(report.mismatches.canonicalOnlyLanes).toEqual([
      {
        laneId: 'lane:openclaw_session:oc_canonical_only',
        sessionKey: 'cli:openclaw:oc_canonical_only',
        laneSourceKind: 'openclaw_session',
        laneSourceId: 'oc_canonical_only',
        buyerApiKeyId: '44444444-4444-4444-8444-444444444444',
        attemptIds: ['66666666-6666-4666-8666-666666666666'],
        attemptCount: 1,
        eventCount: 3,
        latestActivityAt: '2026-04-16T10:40:01.000Z'
      },
      {
        laneId: 'lane:request:req_orphan',
        sessionKey: 'cli:request:req_orphan',
        laneSourceKind: 'request',
        laneSourceId: 'req_orphan',
        buyerApiKeyId: null,
        attemptIds: [],
        attemptCount: 0,
        eventCount: 0,
        latestActivityAt: null
      }
    ]);
    expect(report.mismatches.membershipMismatches).toEqual([
      {
        laneId: 'lane:openclaw_session:oc_membership',
        sessionKey: 'cli:openclaw:oc_membership',
        sourceAttemptIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222'
        ],
        canonicalAttemptIds: ['11111111-1111-4111-8111-111111111111'],
        missingFromCanonicalAttemptIds: ['22222222-2222-4222-8222-222222222222'],
        unexpectedCanonicalAttemptIds: []
      }
    ]);
    expect(report.mismatches.eventCountMismatches).toEqual([
      {
        laneId: 'lane:openclaw_session:oc_event_count',
        sessionKey: 'cli:openclaw:oc_event_count',
        sourceEventCount: 1,
        canonicalEventCount: 2
      },
      {
        laneId: 'lane:openclaw_session:oc_membership',
        sessionKey: 'cli:openclaw:oc_membership',
        sourceEventCount: 6,
        canonicalEventCount: 3
      }
    ]);
    expect(report.mismatches.latestActivityMismatches).toEqual([
      {
        laneId: 'lane:openclaw_session:oc_time',
        sessionKey: 'cli:openclaw:oc_time',
        sourceLatestActivityAt: '2026-04-16T10:30:01.000Z',
        canonicalLatestActivityAt: '2026-04-16T10:29:59.000Z'
      }
    ]);
    expect(report.isClean).toBe(false);

    expect(db.queries).toHaveLength(4);
    expect(db.queries[0]?.sql).toContain('from in_request_log rl');
    expect(db.queries[0]?.sql).toContain('join in_routing_events re');
    expect(db.queries[1]?.sql).toContain('from in_live_lanes');
    expect(db.queries[2]?.sql).toContain('from in_live_lane_attempts');
    expect(db.queries[3]?.sql).toContain('from in_live_lane_events e');
    expect(db.queries.map((query) => query.sql).join('\n')).not.toMatch(/in_admin_|admin_session|adminarchive/i);
  });

  it('supports buyer-key scoped diffs for the known OpenClaw or Codex affected path', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [
          buildSourceTruthRow({
            request_attempt_archive_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            request_id: 'req_known_a',
            buyer_api_key_id: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID,
            route_decision: buildRouteDecision({ openclaw_session_id: 'oc_known_a' }),
            request_logged_at: '2026-04-16T11:00:00.000Z',
            routed_at: '2026-04-16T11:00:01.000Z'
          }),
          buildSourceTruthRow({
            request_attempt_archive_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            request_id: 'req_known_b',
            buyer_api_key_id: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID,
            route_decision: buildRouteDecision({ openclaw_session_id: 'oc_known_b' }),
            request_logged_at: '2026-04-16T11:05:00.000Z',
            routed_at: '2026-04-16T11:05:01.000Z'
          })
        ],
        rowCount: 2
      },
      {
        rows: [
          buildCanonicalLaneRow({
            lane_id: 'lane:request:req_collapsed_known',
            session_key: 'cli:request:req_collapsed_known',
            lane_source_kind: 'request',
            lane_source_id: 'req_collapsed_known',
            buyer_api_key_id: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID,
            last_event_at: '2026-04-16T11:05:01.000Z'
          })
        ],
        rowCount: 1
      },
      {
        rows: [
          buildCanonicalAttemptRow({
            lane_id: 'lane:request:req_collapsed_known',
            request_attempt_archive_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            buyer_api_key_id: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID
          }),
          buildCanonicalAttemptRow({
            lane_id: 'lane:request:req_collapsed_known',
            request_attempt_archive_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            buyer_api_key_id: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID
          })
        ],
        rowCount: 2
      },
      {
        rows: [
          buildCanonicalEventRow({
            lane_id: 'lane:request:req_collapsed_known',
            lane_event_id: 'laneevt:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:request:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:request:req_collapsed_known',
            lane_event_id: 'laneevt:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:response:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:request:req_collapsed_known',
            lane_event_id: 'laneevt:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:attempt_status'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:request:req_collapsed_known',
            lane_event_id: 'laneevt:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:request:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:request:req_collapsed_known',
            lane_event_id: 'laneevt:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:response:1'
          }),
          buildCanonicalEventRow({
            lane_id: 'lane:request:req_collapsed_known',
            lane_event_id: 'laneevt:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:attempt_status'
          })
        ],
        rowCount: 6
      }
    ]);
    const service = new LiveLaneShadowService({ db });

    const report = await service.diffKnownAffectedBuyerKey();

    expect(report.scope).toEqual({
      buyerApiKeyId: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID
    });
    expect(report.totals).toEqual({
      sourceLaneCount: 2,
      canonicalLaneCount: 1,
      sourceAttemptCount: 2,
      canonicalAttemptCount: 2,
      sourceEventCount: 6,
      canonicalEventCount: 6
    });
    expect(report.laneCount).toEqual({
      source: 2,
      canonical: 1,
      matches: false
    });
    expect(report.mismatchCounts).toEqual({
      sourceOnlyLaneCount: 2,
      canonicalOnlyLaneCount: 1,
      membershipMismatchCount: 0,
      eventCountMismatchCount: 0,
      latestActivityMismatchCount: 0
    });
    expect(report.mismatches.sourceOnlyLanes.map((lane) => lane.laneId)).toEqual([
      'lane:openclaw_session:oc_known_a',
      'lane:openclaw_session:oc_known_b'
    ]);
    expect(report.mismatches.canonicalOnlyLanes.map((lane) => lane.laneId)).toEqual([
      'lane:request:req_collapsed_known'
    ]);
    expect(report.isClean).toBe(false);

    expect(db.queries).toHaveLength(4);
    expect(db.queries[0]?.sql).toContain('where re.api_key_id = $1');
    expect(db.queries[1]?.sql).toContain('exists');
    expect(db.queries[2]?.sql).toContain('where buyer_api_key_id = $1');
    expect(db.queries[3]?.sql).toContain('join in_live_lane_attempts a');
    expect(db.queries[3]?.sql).toContain('where a.buyer_api_key_id = $1');
    expect(db.queries[0]?.params).toEqual([KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID]);
    expect(db.queries[1]?.params).toEqual([KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID]);
    expect(db.queries[2]?.params).toEqual([KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID]);
    expect(db.queries[3]?.params).toEqual([KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID]);
  });
});

function buildSourceTruthRow(
  overrides: Partial<{
    request_attempt_archive_id: string;
    request_id: string;
    attempt_no: number;
    org_id: string;
    proxied_path: string | null;
    request_content_type: string | null;
    response_content_type: string | null;
    prompt_preview: string | null;
    response_preview: string | null;
    full_prompt_encrypted: Buffer | string | null;
    full_response_encrypted: Buffer | string | null;
    request_logged_at: string | Date;
    buyer_api_key_id: string | null;
    seller_key_id: string | null;
    provider: string;
    model: string;
    streaming: boolean;
    route_decision: string;
    upstream_status: number | null;
    error_code: string | null;
    latency_ms: number;
    ttfb_ms: number | null;
    routed_at: string | Date;
  }> = {}
) {
  return {
    request_attempt_archive_id: overrides.request_attempt_archive_id ?? '99999999-9999-4999-8999-999999999999',
    request_id: overrides.request_id ?? 'req_default',
    attempt_no: overrides.attempt_no ?? 1,
    org_id: overrides.org_id ?? '33333333-3333-4333-8333-333333333333',
    proxied_path: overrides.proxied_path !== undefined ? overrides.proxied_path : '/v1/responses',
    request_content_type:
      overrides.request_content_type !== undefined ? overrides.request_content_type : 'application/json',
    response_content_type:
      overrides.response_content_type !== undefined ? overrides.response_content_type : 'application/json',
    prompt_preview: overrides.prompt_preview !== undefined ? overrides.prompt_preview : 'prompt preview',
    response_preview: overrides.response_preview !== undefined ? overrides.response_preview : 'response preview',
    full_prompt_encrypted:
      overrides.full_prompt_encrypted !== undefined ? overrides.full_prompt_encrypted : null,
    full_response_encrypted:
      overrides.full_response_encrypted !== undefined ? overrides.full_response_encrypted : null,
    request_logged_at: overrides.request_logged_at ?? '2026-04-16T09:00:00.000Z',
    buyer_api_key_id:
      overrides.buyer_api_key_id !== undefined ? overrides.buyer_api_key_id : '44444444-4444-4444-8444-444444444444',
    seller_key_id: overrides.seller_key_id !== undefined ? overrides.seller_key_id : null,
    provider: overrides.provider ?? 'openai',
    model: overrides.model ?? 'gpt-5.4',
    streaming: overrides.streaming ?? true,
    route_decision: overrides.route_decision ?? buildRouteDecision(),
    upstream_status: overrides.upstream_status ?? 200,
    error_code: overrides.error_code !== undefined ? overrides.error_code : null,
    latency_ms: overrides.latency_ms ?? 350,
    ttfb_ms: overrides.ttfb_ms !== undefined ? overrides.ttfb_ms : 40,
    routed_at: overrides.routed_at ?? '2026-04-16T09:00:01.000Z'
  };
}

function buildCanonicalLaneRow(
  overrides: Partial<{
    lane_id: string;
    session_key: string;
    lane_source_kind: string;
    lane_source_id: string;
    buyer_api_key_id: string | null;
    last_event_at: string | Date | null;
  }> = {}
) {
  return {
    lane_id: overrides.lane_id ?? 'lane:request:req_default',
    session_key: overrides.session_key ?? 'cli:request:req_default',
    lane_source_kind: overrides.lane_source_kind ?? 'request',
    lane_source_id: overrides.lane_source_id ?? 'req_default',
    buyer_api_key_id: overrides.buyer_api_key_id ?? null,
    last_event_at: overrides.last_event_at ?? null
  };
}

function buildCanonicalAttemptRow(
  overrides: Partial<{
    lane_id: string;
    request_attempt_archive_id: string;
    buyer_api_key_id: string | null;
  }> = {}
) {
  return {
    lane_id: overrides.lane_id ?? 'lane:request:req_default',
    request_attempt_archive_id:
      overrides.request_attempt_archive_id ?? '99999999-9999-4999-8999-999999999999',
    buyer_api_key_id: overrides.buyer_api_key_id ?? '44444444-4444-4444-8444-444444444444'
  };
}

function buildCanonicalEventRow(
  overrides: Partial<{
    lane_id: string;
    lane_event_id: string;
  }> = {}
) {
  return {
    lane_id: overrides.lane_id ?? 'lane:request:req_default',
    lane_event_id: overrides.lane_event_id ?? 'laneevt:default:attempt_status'
  };
}

function buildRouteDecision(
  overrides: Partial<{
    request_source: string;
    provider_selection_reason: string;
    openclaw_session_id: string | null;
  }> = {}
): string {
  const routeDecision: Record<string, string> = {
    request_source: overrides.request_source ?? 'cli-codex',
    provider_selection_reason: overrides.provider_selection_reason ?? 'cli_provider_pinned'
  };

  if (overrides.openclaw_session_id !== null) {
    routeDecision.openclaw_session_id = overrides.openclaw_session_id ?? 'oc_default';
  }

  return JSON.stringify(routeDecision);
}
