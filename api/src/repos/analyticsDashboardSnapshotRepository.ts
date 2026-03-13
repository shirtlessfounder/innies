import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import type { AnalyticsWindow } from '../utils/analytics.js';

export type DashboardSnapshotFilters = {
  window: AnalyticsWindow;
  provider?: string;
  source?: string;
};

export type AnalyticsDashboardSnapshotPayload = {
  window: AnalyticsWindow;
  snapshotAt: string;
  summary: Record<string, unknown>;
  tokens: Record<string, unknown>[];
  buyers: Record<string, unknown>[];
  anomalies: Record<string, unknown>;
  events: Record<string, unknown>[];
  warnings?: string[];
};

export type DashboardSnapshotRecord = {
  cacheKey: string;
  window: AnalyticsWindow;
  provider?: string;
  source?: string;
  payload: AnalyticsDashboardSnapshotPayload;
  snapshotAt: Date;
  refreshedAt: Date;
};

export interface DashboardSnapshotStore {
  get(filters: DashboardSnapshotFilters): Promise<DashboardSnapshotRecord | null>;
  refreshIfLockAvailable(
    filters: DashboardSnapshotFilters,
    buildPayload: () => Promise<AnalyticsDashboardSnapshotPayload>
  ): Promise<DashboardSnapshotRecord | null>;
}

type SnapshotRow = {
  cache_key: string;
  dashboard_window: AnalyticsWindow;
  provider: string | null;
  source: string | null;
  payload: AnalyticsDashboardSnapshotPayload | string;
  snapshot_at: Date;
  refreshed_at: Date;
};

const LOCK_NAMESPACE = 19772191;
// Version the shared snapshot row so mixed-version API instances do not clobber
// newer dashboard payload shapes during rollouts or local/prod DB sharing.
const DASHBOARD_SNAPSHOT_CACHE_SCHEMA_VERSION = 3;

function buildCacheKey(filters: DashboardSnapshotFilters): string {
  return [
    'dashboard',
    `v${DASHBOARD_SNAPSHOT_CACHE_SCHEMA_VERSION}`,
    filters.window,
    filters.provider ?? '_',
    filters.source ?? '_'
  ].join(':');
}

function parsePayload(value: AnalyticsDashboardSnapshotPayload | string): AnalyticsDashboardSnapshotPayload {
  if (typeof value === 'string') {
    return JSON.parse(value) as AnalyticsDashboardSnapshotPayload;
  }

  return value;
}

function mapRow(row: SnapshotRow): DashboardSnapshotRecord {
  return {
    cacheKey: row.cache_key,
    window: row.dashboard_window,
    provider: row.provider ?? undefined,
    source: row.source ?? undefined,
    payload: parsePayload(row.payload),
    snapshotAt: row.snapshot_at,
    refreshedAt: row.refreshed_at
  };
}

export class AnalyticsDashboardSnapshotRepository implements DashboardSnapshotStore {
  constructor(private readonly db: SqlClient) {}

  async get(filters: DashboardSnapshotFilters): Promise<DashboardSnapshotRecord | null> {
    const cacheKey = buildCacheKey(filters);
    const result = await this.db.query<SnapshotRow>(
      `
        select
          cache_key,
          dashboard_window,
          provider,
          source,
          payload,
          snapshot_at,
          refreshed_at
        from ${TABLES.analyticsDashboardSnapshots}
        where cache_key = $1
        limit 1
      `,
      [cacheKey]
    );

    if (result.rowCount < 1) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async refreshIfLockAvailable(
    filters: DashboardSnapshotFilters,
    buildPayload: () => Promise<AnalyticsDashboardSnapshotPayload>
  ): Promise<DashboardSnapshotRecord | null> {
    const cacheKey = buildCacheKey(filters);

    return this.db.transaction(async (tx) => {
      const lockResult = await tx.query<{ locked: boolean }>(
        'select pg_try_advisory_xact_lock($1::integer, hashtext($2)) as locked',
        [LOCK_NAMESPACE, cacheKey]
      );

      if (!lockResult.rows[0]?.locked) {
        return null;
      }

      const payload = await buildPayload();
      const snapshotAt = new Date(payload.snapshotAt);
      const snapshotAtValue = Number.isNaN(snapshotAt.getTime()) ? new Date() : snapshotAt;
      const params: SqlValue[] = [
        cacheKey,
        filters.window,
        filters.provider ?? null,
        filters.source ?? null,
        payload,
        snapshotAtValue
      ];

      const upsertResult = await tx.query<SnapshotRow>(
        `
          insert into ${TABLES.analyticsDashboardSnapshots} (
            cache_key,
            dashboard_window,
            provider,
            source,
            payload,
            snapshot_at,
            refreshed_at,
            created_at,
            updated_at
          ) values ($1, $2, $3, $4, $5::jsonb, $6, now(), now(), now())
          on conflict (cache_key)
          do update set
            dashboard_window = excluded.dashboard_window,
            provider = excluded.provider,
            source = excluded.source,
            payload = excluded.payload,
            snapshot_at = excluded.snapshot_at,
            refreshed_at = now(),
            updated_at = now()
          returning
            cache_key,
            dashboard_window,
            provider,
            source,
            payload,
            snapshot_at,
            refreshed_at
        `,
        params
      );

      if (upsertResult.rowCount !== 1) {
        throw new Error('expected analytics dashboard snapshot upsert');
      }

      return mapRow(upsertResult.rows[0]);
    });
  }
}
