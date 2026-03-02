import { Pool, type PoolClient } from 'pg';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from './sqlClient.js';

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

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const tx = new PgTransactionContext(client);
      const result = await run(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function buildPgClient(connectionString: string): PgSqlClient {
  const pool = new Pool({ connectionString, max: 20 });
  return new PgSqlClient(pool);
}
