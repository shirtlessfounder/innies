import { Pool, type PoolClient } from 'pg';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from './sqlClient.js';

const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 180_000;
const DEFAULT_POOL_STATEMENT_TIMEOUT_MS = 60_000;
const DEFAULT_POOL_QUERY_TIMEOUT_MS = 65_000;
const DEFAULT_POOL_IDLE_IN_TX_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_MAX = 20;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

class PgTransactionContext implements TransactionContext {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = []
  ): Promise<SqlQueryResult<T>> {
    const result = await this.client.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }
}

export class PgSqlClient implements SqlClient {
  constructor(private readonly pool: Pool) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = []
  ): Promise<SqlQueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  /**
   * Run `run` inside a single BEGIN/COMMIT block, with server-side safety
   * timeouts installed via SET LOCAL so that a hung callback cannot leak a
   * connection from the pg pool or hold advisory locks indefinitely.
   *
   * - `idle_in_transaction_session_timeout` kills the backend if the tx is
   *   idle (no query running) for longer than the configured window. This
   *   covers the case where `run` hangs on non-db I/O (an HTTP fetch, a
   *   promise that never settles, an orphaned request after client
   *   disconnect).
   * - `statement_timeout` caps any single query inside the tx.
   *
   * Both defaults can be overridden via env vars when a batch job legitimately
   * needs longer (e.g. admin projectors running over large backfills).
   */
  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const idleInTxTimeoutMs = readPositiveIntEnv(
      'INNIES_DB_TX_IDLE_TIMEOUT_MS',
      DEFAULT_IDLE_IN_TX_TIMEOUT_MS
    );
    const statementTimeoutMs = readPositiveIntEnv(
      'INNIES_DB_TX_STATEMENT_TIMEOUT_MS',
      DEFAULT_STATEMENT_TIMEOUT_MS
    );

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local idle_in_transaction_session_timeout = ${idleInTxTimeoutMs}`);
      await client.query(`set local statement_timeout = ${statementTimeoutMs}`);
      const tx = new PgTransactionContext(client);
      const result = await run(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      // Best-effort rollback; if the backend was terminated by one of the
      // timeouts above, rollback itself may fail, and that's fine — the
      // outer error still propagates and the client is released below.
      try {
        await client.query('rollback');
      } catch {
        // swallow; connection is about to be released / discarded
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Build a pg pool with safety timeouts applied at the connection level.
 *
 * Non-transactional queries (`pool.query` via `PgSqlClient.query`) do NOT go
 * through `PgSqlClient.transaction`, so the SET LOCAL timeouts installed
 * there don't protect them. Without a server-side `statement_timeout` on the
 * pool, a single hung `pool.query()` waits forever — which is what wedged
 * `buildDashboardSnapshotPayload` on 2026-04-23 when its 7 parallel
 * `Promise.all` reads stalled on a saturated pool.
 *
 * Defaults:
 * - `statement_timeout` 60s — caps any single query server-side. Bigger than
 *   observed hot-window rollups (dashboard window=1m worst case ~8.5s) but
 *   tight enough to kill true hangs.
 * - `query_timeout` 65s — client-side cancel, 5s after statement_timeout so
 *   pg-node aborts the query if the server somehow doesn't.
 * - `idle_in_transaction_session_timeout` 30s — same scope and reasoning as
 *   the SET LOCAL fallback in `transaction()`, applied here so it also
 *   covers any caller that opens a tx without going through our wrapper
 *   (e.g. direct `pool.connect()` use, should any ever appear).
 *
 * All three are overridable per-env so batch backfills can opt out.
 */
export function buildPgClient(connectionString: string): PgSqlClient {
  const poolMax = readPositiveIntEnv('INNIES_DB_POOL_MAX', DEFAULT_POOL_MAX);
  const statementTimeoutMs = readPositiveIntEnv(
    'INNIES_DB_POOL_STATEMENT_TIMEOUT_MS',
    DEFAULT_POOL_STATEMENT_TIMEOUT_MS
  );
  const queryTimeoutMs = readPositiveIntEnv(
    'INNIES_DB_POOL_QUERY_TIMEOUT_MS',
    DEFAULT_POOL_QUERY_TIMEOUT_MS
  );
  const idleInTxTimeoutMs = readPositiveIntEnv(
    'INNIES_DB_POOL_IDLE_IN_TX_TIMEOUT_MS',
    DEFAULT_POOL_IDLE_IN_TX_TIMEOUT_MS
  );

  const pool = new Pool({
    connectionString,
    max: poolMax,
    statement_timeout: statementTimeoutMs,
    query_timeout: queryTimeoutMs,
    idle_in_transaction_session_timeout: idleInTxTimeoutMs
  });
  return new PgSqlClient(pool);
}
