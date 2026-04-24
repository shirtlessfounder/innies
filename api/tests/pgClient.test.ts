import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgSqlClient } from '../src/repos/pgClient.js';

type ExecutedQuery = { sql: string; params?: unknown[] };

function buildFakePool(options?: { runThrows?: unknown; connectRejects?: boolean }) {
  const executed: ExecutedQuery[] = [];
  const releases: Array<'release'> = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      releases.push('release');
    })
  };

  const pool = {
    connect: vi.fn(async () => {
      if (options?.connectRejects) {
        throw new Error('connect failed');
      }
      return client;
    }),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    end: vi.fn(async () => undefined)
  };

  return { pool, client, executed, releases };
}

describe('PgSqlClient.transaction', () => {
  const originalIdle = process.env.INNIES_DB_TX_IDLE_TIMEOUT_MS;
  const originalStmt = process.env.INNIES_DB_TX_STATEMENT_TIMEOUT_MS;

  afterEach(() => {
    if (originalIdle === undefined) {
      delete process.env.INNIES_DB_TX_IDLE_TIMEOUT_MS;
    } else {
      process.env.INNIES_DB_TX_IDLE_TIMEOUT_MS = originalIdle;
    }
    if (originalStmt === undefined) {
      delete process.env.INNIES_DB_TX_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.INNIES_DB_TX_STATEMENT_TIMEOUT_MS = originalStmt;
    }
  });

  it('installs SET LOCAL idle_in_transaction_session_timeout and statement_timeout after BEGIN', async () => {
    delete process.env.INNIES_DB_TX_IDLE_TIMEOUT_MS;
    delete process.env.INNIES_DB_TX_STATEMENT_TIMEOUT_MS;

    const { pool, executed, releases } = buildFakePool();
    const db = new PgSqlClient(pool as never);

    await db.transaction(async () => 'ok');

    expect(executed.map((q) => q.sql)).toEqual([
      'begin',
      'set local idle_in_transaction_session_timeout = 30000',
      'set local statement_timeout = 180000',
      'commit'
    ]);
    expect(releases).toEqual(['release']);
  });

  it('honors env overrides for both timeouts', async () => {
    process.env.INNIES_DB_TX_IDLE_TIMEOUT_MS = '5000';
    process.env.INNIES_DB_TX_STATEMENT_TIMEOUT_MS = '45000';

    const { pool, executed } = buildFakePool();
    const db = new PgSqlClient(pool as never);

    await db.transaction(async () => 'ok');

    expect(executed.map((q) => q.sql)).toContain('set local idle_in_transaction_session_timeout = 5000');
    expect(executed.map((q) => q.sql)).toContain('set local statement_timeout = 45000');
  });

  it('falls back to defaults when env values are non-numeric or non-positive', async () => {
    process.env.INNIES_DB_TX_IDLE_TIMEOUT_MS = 'banana';
    process.env.INNIES_DB_TX_STATEMENT_TIMEOUT_MS = '0';

    const { pool, executed } = buildFakePool();
    const db = new PgSqlClient(pool as never);

    await db.transaction(async () => 'ok');

    expect(executed.map((q) => q.sql)).toContain('set local idle_in_transaction_session_timeout = 30000');
    expect(executed.map((q) => q.sql)).toContain('set local statement_timeout = 180000');
  });

  it('rolls back and releases when the callback throws', async () => {
    const { pool, executed, releases } = buildFakePool();
    const db = new PgSqlClient(pool as never);

    await expect(
      db.transaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(executed.map((q) => q.sql)).toContain('rollback');
    expect(executed.map((q) => q.sql)).not.toContain('commit');
    expect(releases).toEqual(['release']);
  });

  it('still releases the connection when rollback itself fails (e.g. backend already terminated by timeout)', async () => {
    const { pool, client, releases } = buildFakePool();
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'rollback') {
        throw new Error('connection terminated');
      }
      return { rows: [], rowCount: 0 };
    });
    const db = new PgSqlClient(pool as never);

    await expect(
      db.transaction(async () => {
        throw new Error('tx body failed');
      })
    ).rejects.toThrow('tx body failed');

    expect(releases).toEqual(['release']);
  });
});
