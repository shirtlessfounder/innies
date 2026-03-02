import { describe, expect, it } from 'vitest';
import { RouterEngine } from '../src/services/routerEngine.js';
import type { SellerKey } from '../src/types/routing.js';

function key(id: string, weight: number): SellerKey {
  return {
    id,
    orgId: 'seller',
    provider: 'anthropic',
    model: 'claude-code',
    status: 'active',
    priorityWeight: weight,
    monthlyCapacityUsedUnits: 0,
    supportsStreaming: true,
  };
}

describe('RouterEngine', () => {
  it('uses weighted round robin order deterministically', () => {
    const router = new RouterEngine();
    const candidates = [key('a', 3), key('b', 1)];

    const picks = Array.from({ length: 4 }, () =>
      router.pickWeightedRoundRobin({
        orgId: 'org-1',
        provider: 'anthropic',
        model: 'claude-code',
        candidates,
      })?.id
    );

    expect(picks).toEqual(['a', 'a', 'a', 'b']);
  });

  it('respects exclude list for failover', () => {
    const router = new RouterEngine();
    const candidates = [key('a', 1), key('b', 1)];

    const pick = router.pickWeightedRoundRobin({
      orgId: 'org-1',
      provider: 'anthropic',
      model: 'claude-code',
      candidates,
      excludeKeyIds: new Set(['a']),
    });

    expect(pick?.id).toBe('b');
  });
});
