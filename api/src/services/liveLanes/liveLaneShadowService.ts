import type { LiveLaneProjectorInput } from '../../repos/requestLogRepository.js';
import type { SqlClient, SqlValue } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';
import { decryptSecret } from '../../utils/crypto.js';
import { buildLiveLaneProjection } from './liveLaneProjectorService.js';

export const KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID =
  'f3f97490-540f-4d13-ba1b-2ad1adff1ff1';

type SourceTruthRow = {
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
  route_decision: Record<string, unknown> | string | null;
  upstream_status: number | null;
  error_code: string | null;
  latency_ms: number;
  ttfb_ms: number | null;
  routed_at: string | Date;
};

type CanonicalLaneRow = {
  lane_id: string;
  session_key: string;
  lane_source_kind: string;
  lane_source_id: string;
  buyer_api_key_id: string | null;
  last_event_at: string | Date | null;
};

type CanonicalAttemptRow = {
  lane_id: string;
  request_attempt_archive_id: string;
  buyer_api_key_id: string | null;
};

type CanonicalEventRow = {
  lane_id: string;
  lane_event_id: string;
};

type MutableLaneState = {
  laneId: string;
  sessionKey: string;
  laneSourceKind: string;
  laneSourceId: string;
  buyerApiKeyId: string | null;
  attemptIds: Set<string>;
  eventCount: number;
  latestActivityAt: string | null;
};

export type LiveLaneShadowDiffInput = {
  buyerApiKeyId?: string | null;
};

export type LiveLaneShadowLaneState = {
  laneId: string;
  sessionKey: string;
  laneSourceKind: string;
  laneSourceId: string;
  buyerApiKeyId: string | null;
  attemptIds: string[];
  attemptCount: number;
  eventCount: number;
  latestActivityAt: string | null;
};

export type LiveLaneShadowMembershipMismatch = {
  laneId: string;
  sessionKey: string;
  sourceAttemptIds: string[];
  canonicalAttemptIds: string[];
  missingFromCanonicalAttemptIds: string[];
  unexpectedCanonicalAttemptIds: string[];
};

export type LiveLaneShadowEventCountMismatch = {
  laneId: string;
  sessionKey: string;
  sourceEventCount: number;
  canonicalEventCount: number;
};

export type LiveLaneShadowLatestActivityMismatch = {
  laneId: string;
  sessionKey: string;
  sourceLatestActivityAt: string | null;
  canonicalLatestActivityAt: string | null;
};

export type LiveLaneShadowDiffReport = {
  scope: {
    buyerApiKeyId: string | null;
  };
  totals: {
    sourceLaneCount: number;
    canonicalLaneCount: number;
    sourceAttemptCount: number;
    canonicalAttemptCount: number;
    sourceEventCount: number;
    canonicalEventCount: number;
  };
  laneCount: {
    source: number;
    canonical: number;
    matches: boolean;
  };
  mismatchCounts: {
    sourceOnlyLaneCount: number;
    canonicalOnlyLaneCount: number;
    membershipMismatchCount: number;
    eventCountMismatchCount: number;
    latestActivityMismatchCount: number;
  };
  mismatches: {
    sourceOnlyLanes: LiveLaneShadowLaneState[];
    canonicalOnlyLanes: LiveLaneShadowLaneState[];
    membershipMismatches: LiveLaneShadowMembershipMismatch[];
    eventCountMismatches: LiveLaneShadowEventCountMismatch[];
    latestActivityMismatches: LiveLaneShadowLatestActivityMismatch[];
  };
  isClean: boolean;
};

export class LiveLaneShadowService {
  constructor(private readonly deps: { db: SqlClient }) {}

  async diff(input: LiveLaneShadowDiffInput = {}): Promise<LiveLaneShadowDiffReport> {
    const buyerApiKeyId = normalizeNullableString(input.buyerApiKeyId);
    const sourceRows = await this.listSourceTruthRows(buyerApiKeyId);
    const canonicalLaneRows = await this.listCanonicalLaneRows(buyerApiKeyId);
    const canonicalAttemptRows = await this.listCanonicalAttemptRows(buyerApiKeyId);
    const canonicalEventRows = await this.listCanonicalEventRows(buyerApiKeyId);

    const sourceStates = aggregateSourceTruth(sourceRows);
    const canonicalStates = aggregateCanonicalTruth(
      canonicalLaneRows,
      canonicalAttemptRows,
      canonicalEventRows
    );

    const sourceLaneIds = new Set(sourceStates.keys());
    const canonicalLaneIds = new Set(canonicalStates.keys());
    const sharedLaneIds = [...sourceLaneIds].filter((laneId) => canonicalLaneIds.has(laneId)).sort();

    const sourceOnlyLanes = [...sourceStates.values()]
      .filter((lane) => !canonicalLaneIds.has(lane.laneId))
      .map(finalizeLaneState)
      .sort(compareLaneStates);
    const canonicalOnlyLanes = [...canonicalStates.values()]
      .filter((lane) => !sourceLaneIds.has(lane.laneId))
      .map(finalizeLaneState)
      .sort(compareLaneStates);

    const membershipMismatches: LiveLaneShadowMembershipMismatch[] = [];
    const eventCountMismatches: LiveLaneShadowEventCountMismatch[] = [];
    const latestActivityMismatches: LiveLaneShadowLatestActivityMismatch[] = [];

    for (const laneId of sharedLaneIds) {
      const sourceLane = sourceStates.get(laneId);
      const canonicalLane = canonicalStates.get(laneId);
      if (!sourceLane || !canonicalLane) {
        continue;
      }

      const sourceAttemptIds = sortStrings([...sourceLane.attemptIds]);
      const canonicalAttemptIds = sortStrings([...canonicalLane.attemptIds]);
      const missingFromCanonicalAttemptIds = sourceAttemptIds.filter(
        (attemptId) => !canonicalLane.attemptIds.has(attemptId)
      );
      const unexpectedCanonicalAttemptIds = canonicalAttemptIds.filter(
        (attemptId) => !sourceLane.attemptIds.has(attemptId)
      );

      if (missingFromCanonicalAttemptIds.length > 0 || unexpectedCanonicalAttemptIds.length > 0) {
        membershipMismatches.push({
          laneId,
          sessionKey: sourceLane.sessionKey,
          sourceAttemptIds,
          canonicalAttemptIds,
          missingFromCanonicalAttemptIds,
          unexpectedCanonicalAttemptIds
        });
      }

      if (sourceLane.eventCount !== canonicalLane.eventCount) {
        eventCountMismatches.push({
          laneId,
          sessionKey: sourceLane.sessionKey,
          sourceEventCount: sourceLane.eventCount,
          canonicalEventCount: canonicalLane.eventCount
        });
      }

      if (sourceLane.latestActivityAt !== canonicalLane.latestActivityAt) {
        latestActivityMismatches.push({
          laneId,
          sessionKey: sourceLane.sessionKey,
          sourceLatestActivityAt: sourceLane.latestActivityAt,
          canonicalLatestActivityAt: canonicalLane.latestActivityAt
        });
      }
    }

    membershipMismatches.sort(compareLaneIdField);
    eventCountMismatches.sort(compareLaneIdField);
    latestActivityMismatches.sort(compareLaneIdField);

    const totals = {
      sourceLaneCount: sourceStates.size,
      canonicalLaneCount: canonicalStates.size,
      sourceAttemptCount: sumLaneMetric(sourceStates, (lane) => lane.attemptIds.size),
      canonicalAttemptCount: sumLaneMetric(canonicalStates, (lane) => lane.attemptIds.size),
      sourceEventCount: sumLaneMetric(sourceStates, (lane) => lane.eventCount),
      canonicalEventCount: sumLaneMetric(canonicalStates, (lane) => lane.eventCount)
    };

    const mismatchCounts = {
      sourceOnlyLaneCount: sourceOnlyLanes.length,
      canonicalOnlyLaneCount: canonicalOnlyLanes.length,
      membershipMismatchCount: membershipMismatches.length,
      eventCountMismatchCount: eventCountMismatches.length,
      latestActivityMismatchCount: latestActivityMismatches.length
    };

    return {
      scope: {
        buyerApiKeyId
      },
      totals,
      laneCount: {
        source: totals.sourceLaneCount,
        canonical: totals.canonicalLaneCount,
        matches: totals.sourceLaneCount === totals.canonicalLaneCount
      },
      mismatchCounts,
      mismatches: {
        sourceOnlyLanes,
        canonicalOnlyLanes,
        membershipMismatches,
        eventCountMismatches,
        latestActivityMismatches
      },
      isClean:
        totals.sourceLaneCount === totals.canonicalLaneCount &&
        mismatchCounts.sourceOnlyLaneCount === 0 &&
        mismatchCounts.canonicalOnlyLaneCount === 0 &&
        mismatchCounts.membershipMismatchCount === 0 &&
        mismatchCounts.eventCountMismatchCount === 0 &&
        mismatchCounts.latestActivityMismatchCount === 0
    };
  }

  diffKnownAffectedBuyerKey(): Promise<LiveLaneShadowDiffReport> {
    return this.diff({
      buyerApiKeyId: KNOWN_OPENCLAW_CODEX_AFFECTED_BUYER_API_KEY_ID
    });
  }

  private async listSourceTruthRows(buyerApiKeyId: string | null): Promise<SourceTruthRow[]> {
    const params: SqlValue[] = [];
    const where = [];

    if (buyerApiKeyId) {
      params.push(buyerApiKeyId);
      where.push(`re.api_key_id = $${params.length}`);
    }

    const sql = `
      select
        rl.id as request_attempt_archive_id,
        rl.request_id,
        rl.attempt_no,
        rl.org_id,
        rl.proxied_path,
        rl.request_content_type,
        rl.response_content_type,
        rl.prompt_preview,
        rl.response_preview,
        rl.full_prompt_encrypted,
        rl.full_response_encrypted,
        rl.created_at as request_logged_at,
        re.api_key_id as buyer_api_key_id,
        re.seller_key_id,
        re.provider,
        re.model,
        re.streaming,
        re.route_decision,
        re.upstream_status,
        re.error_code,
        re.latency_ms,
        re.ttfb_ms,
        re.created_at as routed_at
      from ${TABLES.requestLog} rl
      join ${TABLES.routingEvents} re
        on re.org_id = rl.org_id
       and re.request_id = rl.request_id
       and re.attempt_no = rl.attempt_no
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by re.created_at asc, rl.id asc
    `;

    const result = await this.deps.db.query<SourceTruthRow>(sql, params);
    return result.rows;
  }

  private async listCanonicalLaneRows(buyerApiKeyId: string | null): Promise<CanonicalLaneRow[]> {
    const params: SqlValue[] = [];
    const where = [];

    if (buyerApiKeyId) {
      params.push(buyerApiKeyId);
      where.push(`
        exists (
          select 1
          from ${TABLES.liveLaneAttempts} a
          where a.lane_id = ${TABLES.liveLanes}.lane_id
            and a.buyer_api_key_id = $${params.length}
        )
      `);
    }

    const sql = `
      select
        lane_id,
        session_key,
        lane_source_kind,
        lane_source_id,
        buyer_api_key_id,
        last_event_at
      from ${TABLES.liveLanes}
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by lane_id asc
    `;

    const result = await this.deps.db.query<CanonicalLaneRow>(sql, params);
    return result.rows;
  }

  private async listCanonicalAttemptRows(buyerApiKeyId: string | null): Promise<CanonicalAttemptRow[]> {
    const params: SqlValue[] = [];
    const where = [];

    if (buyerApiKeyId) {
      params.push(buyerApiKeyId);
      where.push(`buyer_api_key_id = $${params.length}`);
    }

    const sql = `
      select
        lane_id,
        request_attempt_archive_id,
        buyer_api_key_id
      from ${TABLES.liveLaneAttempts}
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by lane_id asc, request_attempt_archive_id asc
    `;

    const result = await this.deps.db.query<CanonicalAttemptRow>(sql, params);
    return result.rows;
  }

  private async listCanonicalEventRows(buyerApiKeyId: string | null): Promise<CanonicalEventRow[]> {
    const params: SqlValue[] = [];
    const joins = [];
    const where = [];

    if (buyerApiKeyId) {
      params.push(buyerApiKeyId);
      joins.push(`
        join ${TABLES.liveLaneAttempts} a
          on a.request_attempt_archive_id = e.request_attempt_archive_id
      `);
      where.push(`a.buyer_api_key_id = $${params.length}`);
    }

    const sql = `
      select
        e.lane_id,
        e.lane_event_id
      from ${TABLES.liveLaneEvents} e
      ${joins.join('\n')}
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by e.lane_id asc, e.lane_event_id asc
    `;

    const result = await this.deps.db.query<CanonicalEventRow>(sql, params);
    return result.rows;
  }
}

function aggregateSourceTruth(rows: SourceTruthRow[]): Map<string, MutableLaneState> {
  const lanes = new Map<string, MutableLaneState>();

  for (const row of rows) {
    const draft = buildLiveLaneProjection(mapSourceTruthRow(row));
    const lane = getOrCreateLaneState(lanes, {
      laneId: draft.lane.laneId,
      sessionKey: draft.lane.sessionKey,
      laneSourceKind: draft.lane.laneSourceKind,
      laneSourceId: draft.lane.laneSourceId,
      buyerApiKeyId: draft.lane.buyerApiKeyId ?? null,
      latestActivityAt: normalizeDateValue(draft.lane.lastEventAt)
    });

    lane.buyerApiKeyId = lane.buyerApiKeyId ?? draft.lane.buyerApiKeyId ?? null;
    lane.attemptIds.add(draft.attempt.requestAttemptArchiveId);
    lane.eventCount += draft.events.length;
    lane.latestActivityAt = maxIsoTimestamp(lane.latestActivityAt, normalizeDateValue(draft.lane.lastEventAt));
  }

  return lanes;
}

function aggregateCanonicalTruth(
  laneRows: CanonicalLaneRow[],
  attemptRows: CanonicalAttemptRow[],
  eventRows: CanonicalEventRow[]
): Map<string, MutableLaneState> {
  const lanes = new Map<string, MutableLaneState>();

  for (const row of laneRows) {
    lanes.set(row.lane_id, {
      laneId: row.lane_id,
      sessionKey: row.session_key,
      laneSourceKind: row.lane_source_kind,
      laneSourceId: row.lane_source_id,
      buyerApiKeyId: row.buyer_api_key_id,
      attemptIds: new Set<string>(),
      eventCount: 0,
      latestActivityAt: normalizeDateValue(row.last_event_at)
    });
  }

  for (const row of attemptRows) {
    const lane = getOrCreateLaneState(lanes, {
      laneId: row.lane_id,
      sessionKey: row.lane_id,
      laneSourceKind: 'unknown',
      laneSourceId: row.lane_id,
      buyerApiKeyId: row.buyer_api_key_id,
      latestActivityAt: null
    });
    lane.buyerApiKeyId = lane.buyerApiKeyId ?? row.buyer_api_key_id ?? null;
    lane.attemptIds.add(row.request_attempt_archive_id);
  }

  for (const row of eventRows) {
    const lane = getOrCreateLaneState(lanes, {
      laneId: row.lane_id,
      sessionKey: row.lane_id,
      laneSourceKind: 'unknown',
      laneSourceId: row.lane_id,
      buyerApiKeyId: null,
      latestActivityAt: null
    });
    lane.eventCount += 1;
  }

  return lanes;
}

function mapSourceTruthRow(row: SourceTruthRow): LiveLaneProjectorInput {
  return {
    requestAttemptArchiveId: row.request_attempt_archive_id,
    requestId: row.request_id,
    attemptNo: Number(row.attempt_no),
    orgId: row.org_id,
    proxiedPath: row.proxied_path,
    requestContentType: row.request_content_type,
    responseContentType: row.response_content_type,
    promptPreview: row.prompt_preview,
    responsePreview: row.response_preview,
    fullPrompt: decryptValue(row.full_prompt_encrypted),
    fullResponse: decryptValue(row.full_response_encrypted),
    requestLoggedAt: new Date(row.request_logged_at),
    buyerApiKeyId: row.buyer_api_key_id,
    sellerKeyId: row.seller_key_id,
    provider: row.provider,
    model: row.model,
    streaming: row.streaming,
    routeDecision: normalizeJson<Record<string, unknown>>(row.route_decision),
    upstreamStatus: row.upstream_status,
    errorCode: row.error_code,
    latencyMs: Number(row.latency_ms),
    ttfbMs: row.ttfb_ms === null ? null : Number(row.ttfb_ms),
    routedAt: new Date(row.routed_at)
  };
}

function decryptValue(value: Buffer | string | null): string | null {
  if (value === null) {
    return null;
  }
  return decryptSecret(value);
}

function normalizeJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  return value as T;
}

function getOrCreateLaneState(
  lanes: Map<string, MutableLaneState>,
  seed: {
    laneId: string;
    sessionKey: string;
    laneSourceKind: string;
    laneSourceId: string;
    buyerApiKeyId: string | null;
    latestActivityAt: string | null;
  }
): MutableLaneState {
  const existing = lanes.get(seed.laneId);
  if (existing) {
    existing.sessionKey = existing.sessionKey === seed.laneId ? seed.sessionKey : existing.sessionKey;
    existing.laneSourceKind = existing.laneSourceKind === 'unknown'
      ? seed.laneSourceKind
      : existing.laneSourceKind;
    existing.laneSourceId = existing.laneSourceId === seed.laneId
      ? seed.laneSourceId
      : existing.laneSourceId;
    existing.buyerApiKeyId = existing.buyerApiKeyId ?? seed.buyerApiKeyId;
    existing.latestActivityAt = maxIsoTimestamp(existing.latestActivityAt, seed.latestActivityAt);
    return existing;
  }

  const created: MutableLaneState = {
    laneId: seed.laneId,
    sessionKey: seed.sessionKey,
    laneSourceKind: seed.laneSourceKind,
    laneSourceId: seed.laneSourceId,
    buyerApiKeyId: seed.buyerApiKeyId,
    attemptIds: new Set<string>(),
    eventCount: 0,
    latestActivityAt: seed.latestActivityAt
  };
  lanes.set(seed.laneId, created);
  return created;
}

function finalizeLaneState(lane: MutableLaneState): LiveLaneShadowLaneState {
  return {
    laneId: lane.laneId,
    sessionKey: lane.sessionKey,
    laneSourceKind: lane.laneSourceKind,
    laneSourceId: lane.laneSourceId,
    buyerApiKeyId: lane.buyerApiKeyId,
    attemptIds: sortStrings([...lane.attemptIds]),
    attemptCount: lane.attemptIds.size,
    eventCount: lane.eventCount,
    latestActivityAt: lane.latestActivityAt
  };
}

function normalizeDateValue(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function maxIsoTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left >= right ? left : right;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sumLaneMetric(
  lanes: Map<string, MutableLaneState>,
  readMetric: (lane: MutableLaneState) => number
): number {
  let total = 0;
  for (const lane of lanes.values()) {
    total += readMetric(lane);
  }
  return total;
}

function sortStrings(values: string[]): string[] {
  return values.sort((left, right) => left.localeCompare(right));
}

function compareLaneIdField(left: { laneId: string }, right: { laneId: string }): number {
  return left.laneId.localeCompare(right.laneId);
}

function compareLaneStates(left: LiveLaneShadowLaneState, right: LiveLaneShadowLaneState): number {
  return left.laneId.localeCompare(right.laneId);
}
