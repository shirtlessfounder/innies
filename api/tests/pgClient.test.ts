import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgSqlClient, buildPgClient } from '../src/repos/pgClient.js';

const poolConstructorCalls: Array<Record<string, unknown>> = [];

vi.mock('pg', () => {
  class FakePool {
    constructor(options: Record<string, unknown>) {
      poolConstructorCalls.push(options);
    }
    async connect() {
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined
      };
    }
    async query() {
      return { rows: [], rowCount: 0 };
    }
    async end() {
      return undefined;
    }
  }

  return { Pool: FakePool };
});

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

describe('buildPgClient', () => {
  const envKeys = [
    'INNIES_DB_POOL_MAX',
    'INNIES_DB_POOL_STATEMENT_TIMEOUT_MS',
    'INNIES_DB_POOL_QUERY_TIMEOUT_MS',
    'INNIES_DB_POOL_IDLE_IN_TX_TIMEOUT_MS'
  ] as const;
  const originals: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  for (const key of envKeys) {
    originals[key] = process.env[key];
  }

  afterEach(() => {
    poolConstructorCalls.length = 0;
    for (const key of envKeys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  });

  it('constructs the Pool with server-side safety timeouts by default', () => {
    for (const key of envKeys) delete process.env[key];

    buildPgClient('postgres://example/db');

    expect(poolConstructorCalls).toHaveLength(1);
    expect(poolConstructorCalls[0]).toMatchObject({
      connectionString: 'postgres://example/db',
      max: 20,
      statement_timeout: 60_000,
      query_timeout: 65_000,
      idle_in_transaction_session_timeout: 30_000
    });
  });

  it('query_timeout is strictly greater than statement_timeout so the server-side cap fires first', () => {
    for (const key of envKeys) delete process.env[key];

    buildPgClient('postgres://example/db');

    const opts = poolConstructorCalls[0] as {
      statement_timeout: number;
      query_timeout: number;
    };
    expect(opts.query_timeout).toBeGreaterThan(opts.statement_timeout);
  });

  it('honors env overrides for all four pool knobs', () => {
    process.env.INNIES_DB_POOL_MAX = '7';
    process.env.INNIES_DB_POOL_STATEMENT_TIMEOUT_MS = '15000';
    process.env.INNIES_DB_POOL_QUERY_TIMEOUT_MS = '16000';
    process.env.INNIES_DB_POOL_IDLE_IN_TX_TIMEOUT_MS = '9000';

    buildPgClient('postgres://example/db');

    expect(poolConstructorCalls[0]).toMatchObject({
      max: 7,
      statement_timeout: 15_000,
      query_timeout: 16_000,
      idle_in_transaction_session_timeout: 9_000
    });
  });

  it('falls back to defaults when env values are non-positive or non-numeric', () => {
    process.env.INNIES_DB_POOL_MAX = '-3';
    process.env.INNIES_DB_POOL_STATEMENT_TIMEOUT_MS = 'banana';
    process.env.INNIES_DB_POOL_QUERY_TIMEOUT_MS = '0';
    process.env.INNIES_DB_POOL_IDLE_IN_TX_TIMEOUT_MS = '';

    buildPgClient('postgres://example/db');

    expect(poolConstructorCalls[0]).toMatchObject({
      max: 20,
      statement_timeout: 60_000,
      query_timeout: 65_000,
      idle_in_transaction_session_timeout: 30_000
    });
  });
});
