import {
  LIVE_LANE_PROJECTION_VERSION,
  buildLiveLaneId,
  buildLiveSessionKey,
  type LiveLaneClassification,
  type LiveLaneClassifierInput,
  type LiveLaneSourceKind
} from './liveLaneTypes.js';

const NON_MEANINGFUL_SESSION_IDS = new Set(['null', 'undefined', 'none', 'unknown', 'n/a']);

export function classifyLiveLane(input: LiveLaneClassifierInput): LiveLaneClassification {
  const requestId = readRequiredString(input.requestId, 'requestId');
  const openclawSessionId = readMeaningfulOpenClawSessionId(input);

  if (openclawSessionId) {
    return buildClassification('openclaw_session', openclawSessionId);
  }

  return buildClassification('request', requestId);
}

export function readMeaningfulOpenClawSessionId(input: LiveLaneClassifierInput): string | null {
  const explicit = readMeaningfulString(input.openclawSessionId);
  if (explicit) {
    return explicit;
  }

  return readMeaningfulString(readRouteDecisionString(input.routeDecision, 'openclaw_session_id'));
}

function buildClassification(
  laneSourceKind: LiveLaneSourceKind,
  laneSourceId: string
): LiveLaneClassification {
  return {
    laneId: buildLiveLaneId({
      laneSourceKind,
      laneSourceId
    }),
    laneSourceKind,
    laneSourceId,
    sessionKey: buildLiveSessionKey({
      laneSourceKind,
      laneSourceId
    }),
    projectionVersion: LIVE_LANE_PROJECTION_VERSION
  };
}

function readRouteDecisionString(
  routeDecision: Record<string, unknown> | null | undefined,
  fieldName: string
): string | null {
  if (!routeDecision) {
    return null;
  }

  return typeof routeDecision[fieldName] === 'string'
    ? (routeDecision[fieldName] as string)
    : null;
}

function readMeaningfulString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return NON_MEANINGFUL_SESSION_IDS.has(trimmed.toLowerCase()) ? null : trimmed;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const normalized = readMeaningfulString(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return normalized;
}
