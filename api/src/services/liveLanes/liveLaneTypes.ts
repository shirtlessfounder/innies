export const LIVE_LANE_PROJECTION_VERSION = 1;

export const LIVE_LANE_SOURCE_KINDS = ['openclaw_session', 'request'] as const;
export type LiveLaneSourceKind = (typeof LIVE_LANE_SOURCE_KINDS)[number];

export const LIVE_LANE_EVENT_SIDES = ['attempt', 'request', 'response', 'system'] as const;
export type LiveLaneEventSide = (typeof LIVE_LANE_EVENT_SIDES)[number];

export const LIVE_LANE_EVENT_KINDS = ['attempt_status', 'message', 'system'] as const;
export type LiveLaneEventKind = (typeof LIVE_LANE_EVENT_KINDS)[number];

export type LiveLaneIdentity = {
  laneId: string;
  laneSourceKind: LiveLaneSourceKind;
  laneSourceId: string;
  sessionKey: string;
  projectionVersion: number;
};

export type LiveLaneClassification = LiveLaneIdentity;

export type LiveLaneClassifierInput = {
  requestId: string;
  requestSource?: string | null;
  openclawSessionId?: string | null;
  openclawRunId?: string | null;
  routeDecision?: Record<string, unknown> | null;
};

export type LiveLaneEventIdentityInput = {
  requestAttemptArchiveId: string;
  eventKind: LiveLaneEventKind;
  side?: LiveLaneEventSide | null;
  ordinal?: number | null;
};

export function buildLiveLaneId(input: {
  laneSourceKind: LiveLaneSourceKind;
  laneSourceId: string;
}): string {
  return `lane:${input.laneSourceKind}:${input.laneSourceId}`;
}

export function buildLiveSessionKey(input: {
  laneSourceKind: LiveLaneSourceKind;
  laneSourceId: string;
}): string {
  switch (input.laneSourceKind) {
    case 'openclaw_session':
      return `cli:openclaw:${input.laneSourceId}`;
    case 'request':
      return `cli:request:${input.laneSourceId}`;
    default:
      return `cli:request:${input.laneSourceId}`;
  }
}

export function buildLiveLaneEventId(input: LiveLaneEventIdentityInput): string {
  const requestAttemptArchiveId = requireNonEmptyString(
    input.requestAttemptArchiveId,
    'requestAttemptArchiveId'
  );

  if (input.eventKind === 'attempt_status') {
    return `laneevt:${requestAttemptArchiveId}:attempt_status`;
  }

  const side = requireNonEmptyString(input.side, 'side');
  if (side !== 'request' && side !== 'response' && side !== 'system') {
    throw new Error(`unsupported live lane event side: ${side}`);
  }

  if (!Number.isInteger(input.ordinal) || (input.ordinal ?? 0) < 1) {
    throw new Error('live lane message events require a positive ordinal');
  }

  return `laneevt:${requestAttemptArchiveId}:${side}:${input.ordinal}`;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return trimmed;
}
