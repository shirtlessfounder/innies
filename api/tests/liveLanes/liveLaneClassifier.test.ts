import { describe, expect, it } from 'vitest';
import {
  classifyLiveLane,
  readMeaningfulOpenClawSessionId
} from '../../src/services/liveLanes/liveLaneClassifier.js';
import {
  LIVE_LANE_PROJECTION_VERSION,
  buildLiveLaneEventId
} from '../../src/services/liveLanes/liveLaneTypes.js';

describe('classifyLiveLane', () => {
  it('classifies pinned cli-codex traffic with a stable openclaw session onto a canonical lane', () => {
    const classification = classifyLiveLane({
      requestId: 'req_123',
      routeDecision: {
        request_source: 'cli-codex',
        provider_selection_reason: 'cli_provider_pinned',
        openclaw_session_id: 'oc_sess_123',
        openclaw_run_id: 'run_req_123'
      }
    });

    expect(classification).toEqual({
      laneId: 'lane:openclaw_session:oc_sess_123',
      laneSourceKind: 'openclaw_session',
      laneSourceId: 'oc_sess_123',
      sessionKey: 'cli:openclaw:oc_sess_123',
      projectionVersion: LIVE_LANE_PROJECTION_VERSION
    });
    expect(classification.sessionKey).not.toMatch(/^cli:idle:/);
  });

  it('lets stable openclaw session identity outrank request_source for routed openclaw traffic', () => {
    const classification = classifyLiveLane({
      requestId: 'req_234',
      requestSource: 'openclaw',
      openclawSessionId: 'oc_sess_234'
    });

    expect(classification.laneSourceKind).toBe('openclaw_session');
    expect(classification.laneSourceId).toBe('oc_sess_234');
    expect(classification.sessionKey).toBe('cli:openclaw:oc_sess_234');
  });

  it('uses request-scoped fallback identity when no durable stable session id exists', () => {
    const classification = classifyLiveLane({
      requestId: 'req_fallback',
      routeDecision: {
        request_source: 'direct'
      }
    });

    expect(classification).toEqual({
      laneId: 'lane:request:req_fallback',
      laneSourceKind: 'request',
      laneSourceId: 'req_fallback',
      sessionKey: 'cli:request:req_fallback',
      projectionVersion: LIVE_LANE_PROJECTION_VERSION
    });
  });

  it('classifies legacy recovered pinned codex session ids as stable lanes', () => {
    const recoveredPinnedSessionId = 'f3f97490-540f-4d13-ba1b-2ad1adff1ff1';
    const classification = classifyLiveLane({
      requestId: 'req_generated',
      routeDecision: {
        request_source: 'cli-codex',
        provider_selection_reason: 'cli_provider_pinned',
        openclaw_session_id: recoveredPinnedSessionId
      }
    });

    expect(classification.laneSourceKind).toBe('openclaw_session');
    expect(classification.laneSourceId).toBe(recoveredPinnedSessionId);
    expect(classification.sessionKey).toBe(`cli:openclaw:${recoveredPinnedSessionId}`);
  });

  it('does not promote run ids into canonical live-lane identity when no stable session exists', () => {
    const classification = classifyLiveLane({
      requestId: 'req_from_run_only',
      routeDecision: {
        request_source: 'cli-codex',
        openclaw_run_id: 'run_req_only'
      }
    });

    expect(classification.laneSourceKind).toBe('request');
    expect(classification.laneSourceId).toBe('req_from_run_only');
    expect(classification.sessionKey).toBe('cli:request:req_from_run_only');
  });
});

describe('readMeaningfulOpenClawSessionId', () => {
  it('ignores blank and placeholder session ids before falling back to request scope', () => {
    expect(readMeaningfulOpenClawSessionId({
      requestId: 'req_ignored',
      openclawSessionId: '   ',
      routeDecision: {
        openclaw_session_id: 'unknown'
      }
    })).toBeNull();
  });
});

describe('buildLiveLaneEventId', () => {
  it('builds deterministic request and status event ids from persisted attempt provenance', () => {
    expect(buildLiveLaneEventId({
      requestAttemptArchiveId: 'archive_1',
      eventKind: 'attempt_status'
    })).toBe('laneevt:archive_1:attempt_status');

    expect(buildLiveLaneEventId({
      requestAttemptArchiveId: 'archive_1',
      eventKind: 'message',
      side: 'request',
      ordinal: 2
    })).toBe('laneevt:archive_1:request:2');
  });
});
