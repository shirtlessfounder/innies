import type { AdminSessionRow } from '../../repos/adminSessionRepository.js';
import type {
  AdminRequestSource,
  AdminSessionProjectionCandidate,
  ResolvedAdminSessionGrouping
} from './adminArchiveTypes.js';

export const DEFAULT_ADMIN_SESSION_IDLE_GAP_MS = 30 * 60 * 1000;

export function normalizeAdminRequestSource(input: {
  requestSource: string | null;
  provider: string;
  providerSelectionReason: string | null;
  openclawRunId: string | null;
  openclawSessionId: string | null;
}): AdminRequestSource | null {
  const requestSource = trimToNull(input.requestSource);
  if (requestSource === 'openclaw' || requestSource === 'cli-claude' || requestSource === 'cli-codex' || requestSource === 'direct') {
    return requestSource;
  }

  if (input.providerSelectionReason === 'cli_provider_pinned') {
    return canonicalizeProvider(input.provider) === 'openai' ? 'cli-codex' : 'cli-claude';
  }

  if (trimToNull(input.openclawSessionId) || trimToNull(input.openclawRunId)) {
    return 'openclaw';
  }

  return null;
}

export function resolveAdminSessionGrouping(input: {
  candidate: AdminSessionProjectionCandidate;
  latestInLane: AdminSessionRow | null;
  idleGapMs?: number;
}): ResolvedAdminSessionGrouping | null {
  const requestSource = normalizeAdminRequestSource({
    requestSource: input.candidate.requestSource,
    provider: input.candidate.provider,
    providerSelectionReason: input.candidate.providerSelectionReason,
    openclawRunId: input.candidate.openclawRunId,
    openclawSessionId: input.candidate.openclawSessionId
  });

  if (!requestSource || requestSource === 'direct') {
    return null;
  }

  const openclawSessionId = trimToNull(input.candidate.openclawSessionId);
  const openclawRunId = trimToNull(input.candidate.openclawRunId);
  if (requestSource === 'openclaw') {
    if (openclawSessionId) {
      return {
        sessionKey: `openclaw:session:${openclawSessionId}`,
        sessionType: 'openclaw',
        groupingBasis: 'explicit_session_id',
        sourceSessionId: openclawSessionId,
        sourceRunId: openclawRunId
      };
    }

    if (openclawRunId) {
      return {
        sessionKey: `openclaw:run:${openclawRunId}`,
        sessionType: 'openclaw',
        groupingBasis: 'explicit_run_id',
        sourceSessionId: null,
        sourceRunId: openclawRunId
      };
    }

    return {
      sessionKey: `openclaw:request:${input.candidate.requestId}`,
      sessionType: 'openclaw',
      groupingBasis: 'request_fallback',
      sourceSessionId: null,
      sourceRunId: null
    };
  }

  const eventTime = projectionEventTime(input.candidate);
  const latest = input.latestInLane;
  if (latest && isWithinIdleGap({
    previousLastActivityAt: new Date(latest.last_activity_at),
    currentEventTime: eventTime,
    idleGapMs: input.idleGapMs ?? DEFAULT_ADMIN_SESSION_IDLE_GAP_MS
  })) {
    return {
      sessionKey: latest.session_key,
      sessionType: 'cli',
      groupingBasis: latest.grouping_basis,
      sourceSessionId: latest.source_session_id,
      sourceRunId: latest.source_run_id
    };
  }

  return {
    sessionKey: `cli:idle:${input.candidate.orgId}:${input.candidate.apiKeyId ?? 'none'}:${input.candidate.requestId}`,
    sessionType: 'cli',
    groupingBasis: 'idle_gap',
    sourceSessionId: null,
    sourceRunId: null
  };
}

export function projectionEventTime(candidate: AdminSessionProjectionCandidate): Date {
  return candidate.completedAt ?? candidate.startedAt;
}

function isWithinIdleGap(input: {
  previousLastActivityAt: Date;
  currentEventTime: Date;
  idleGapMs: number;
}): boolean {
  return input.currentEventTime.getTime() - input.previousLastActivityAt.getTime() <= input.idleGapMs;
}

function canonicalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'anthropic') return 'anthropic';
  return normalized;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
