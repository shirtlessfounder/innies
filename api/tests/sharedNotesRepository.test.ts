import { describe, expect, it, vi } from 'vitest';
import { SharedNotesRepository } from '../src/services/v2Notes/sharedNotesRepository.js';

type PoolStub = {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
};

type ClientStub = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function makePool(responses: Array<{ rows: unknown[]; rowCount?: number }>): { pool: PoolStub; client: ClientStub } {
  let responseIdx = 0;
  const clientQuery = vi.fn(async () => {
    const next = responses[responseIdx++] ?? { rows: [], rowCount: 0 };
    return next;
  });
  const client: ClientStub = {
    query: clientQuery,
    release: vi.fn()
  };
  const pool: PoolStub = {
    query: vi.fn(async () => {
      const next = responses[responseIdx++] ?? { rows: [], rowCount: 0 };
      return next;
    }),
    connect: vi.fn(async () => client)
  };
  return { pool, client };
}

describe('SharedNotesRepository', () => {
  it('getDocument upserts an empty document and selects it back', async () => {
    const { pool } = makePool([
      // ensureDocument insert
      { rows: [], rowCount: 0 },
      // select
      {
        rows: [{ id: 'v2:notes.md', content: 'hello', revision: 3, updatedAt: '2026-04-19T00:00:00Z' }],
        rowCount: 1
      }
    ]);
    const repo = new SharedNotesRepository({
      pool: pool as any,
      createListenerClient: async () => ({} as any)
    });

    const doc = await repo.getDocument();

    expect(doc).toEqual({
      id: 'v2:notes.md',
      content: 'hello',
      revision: 3,
      updatedAt: '2026-04-19T00:00:00.000Z'
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect((pool.query as any).mock.calls[0][0]).toContain('insert into shared_documents');
    expect((pool.query as any).mock.calls[1][0]).toContain('select');
  });

  it('saveDocument inserts/updates and fires pg_notify inside a tx', async () => {
    const { pool, client } = makePool([]);
    // Set up specific responses on the connected client (pool.connect → client)
    const responses = [
      { rows: [] }, // begin
      {
        rows: [{ id: 'v2:notes.md', content: 'new', revision: 4, updatedAt: '2026-04-19T00:00:00Z' }],
        rowCount: 1
      },
      { rows: [] }, // pg_notify
      { rows: [] } // commit
    ];
    let idx = 0;
    client.query.mockImplementation(async () => responses[idx++] ?? { rows: [] });

    const repo = new SharedNotesRepository({
      pool: pool as any,
      createListenerClient: async () => ({} as any)
    });
    const doc = await repo.saveDocument('new', 3);

    expect(doc.content).toBe('new');
    expect(doc.revision).toBe(4);
    const sqls = client.query.mock.calls.map((args: any[]) => String(args[0]));
    expect(sqls[0]).toBe('begin');
    expect(sqls[1]).toContain('insert into shared_documents');
    expect(sqls[2]).toContain('pg_notify');
    expect(sqls[3]).toBe('commit');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('saveDocument rolls back on pg error', async () => {
    const { pool, client } = makePool([]);
    const responses: Array<{ rows: unknown[] } | Error> = [
      { rows: [] }, // begin
      new Error('boom'), // insert fails
      { rows: [] } // rollback
    ];
    let idx = 0;
    client.query.mockImplementation(async () => {
      const next = responses[idx++];
      if (next instanceof Error) throw next;
      return next ?? { rows: [] };
    });

    const repo = new SharedNotesRepository({
      pool: pool as any,
      createListenerClient: async () => ({} as any)
    });

    await expect(repo.saveDocument('x', null)).rejects.toThrow('boom');
    const sqls = client.query.mock.calls.map((args: any[]) => String(args[0]));
    expect(sqls[0]).toBe('begin');
    expect(sqls[sqls.length - 1]).toBe('rollback');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('listen subscribes to the v2_shared_notes_updates channel and returns a disposer', async () => {
    const { pool } = makePool([]);
    const listenerQuery = vi.fn(async () => ({ rows: [] }));
    const listenerOn = vi.fn();
    const listenerOff = vi.fn();
    const listenerEnd = vi.fn(async () => {});
    const listenerClient = {
      query: listenerQuery,
      on: listenerOn,
      off: listenerOff,
      end: listenerEnd
    };

    const repo = new SharedNotesRepository({
      pool: pool as any,
      createListenerClient: async () => listenerClient as any
    });

    const updates: any[] = [];
    const dispose = await repo.listen((doc) => updates.push(doc));

    expect(listenerOn).toHaveBeenCalledWith('notification', expect.any(Function));
    expect(listenerQuery).toHaveBeenCalledWith('LISTEN v2_shared_notes_updates');

    await dispose();

    expect(listenerOff).toHaveBeenCalled();
    expect(listenerQuery).toHaveBeenCalledWith('UNLISTEN v2_shared_notes_updates');
    expect(listenerEnd).toHaveBeenCalledOnce();

    // second dispose is a no-op
    await dispose();
    expect(listenerEnd).toHaveBeenCalledOnce();
  });
});
