import { describe, expect, it } from 'vitest';
import { KeyPool } from '../src/services/keyPool.js';
import { OrgQueueManager } from '../src/services/orgQueue.js';
import { RouterEngine } from '../src/services/routerEngine.js';
import { RoutingService } from '../src/services/routingService.js';

function makeService() {
  const pool = new KeyPool();
  pool.setKeys([
    {
      id: 'k1',
      orgId: 'seller-a',
      provider: 'anthropic',
      model: 'claude-code',
      status: 'active',
      priorityWeight: 1,
      monthlyCapacityUsedUnits: 0,
      supportsStreaming: true,
    },
    {
      id: 'k2',
      orgId: 'seller-b',
      provider: 'anthropic',
      model: 'claude-code',
      status: 'active',
      priorityWeight: 1,
      monthlyCapacityUsedUnits: 0,
      supportsStreaming: true,
    },
  ]);

  return {
    service: new RoutingService(pool, new RouterEngine(), new OrgQueueManager(20, 3, 8_000)),
  };
}

describe('RoutingService', () => {
  it('fails over after server error and succeeds on alternate key', async () => {
    const { service } = makeService();
    const attempted: string[] = [];

    const result = await service.execute({
      request: {
        requestId: 'r1',
        orgId: 'buyer-1',
        provider: 'anthropic',
        model: 'claude-code',
        streaming: true,
      },
      runUpstream: async (decision) => {
        attempted.push(decision.sellerKeyId);
        if (decision.attemptNo === 1) {
          const err = new Error('server') as Error & { kind: string };
          err.kind = 'server_error';
          throw err;
        }
        return { upstreamStatus: 200, data: { ok: true }, usageUnits: 50 };
      },
    });

    expect(attempted.length).toBe(2);
    expect(new Set(attempted).size).toBe(2);
    expect(result.upstreamStatus).toBe(200);
  });

  it('returns capacity_unavailable when no active keys exist', async () => {
    const pool = new KeyPool();
    pool.setKeys([
      {
        id: 'k1',
        orgId: 'seller-a',
        provider: 'anthropic',
        model: 'claude-code',
        status: 'paused',
        priorityWeight: 1,
        monthlyCapacityUsedUnits: 0,
        supportsStreaming: true,
      },
    ]);

    const service = new RoutingService(pool, new RouterEngine(), new OrgQueueManager(20, 3, 8_000));

    await expect(
      service.execute({
        request: {
          requestId: 'r2',
          orgId: 'buyer-1',
          provider: 'anthropic',
          model: 'claude-code',
          streaming: true,
        },
        runUpstream: async () => ({ upstreamStatus: 200, data: {}, usageUnits: 1 }),
      })
    ).rejects.toMatchObject({ code: 'capacity_unavailable' });
  });
});
