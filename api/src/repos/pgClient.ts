import { Pool, type PoolClient } from 'pg';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from './sqlClient.js';

const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 180_000;

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

export function buildPgClient(connectionString: string): PgSqlClient {
  const pool = new Pool({ connectionString, max: 20 });
  return new PgSqlClient(pool);
}
