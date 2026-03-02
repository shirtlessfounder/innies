import type { SellerKey } from '../types/routing.js';

function toWeightedRing(keys: SellerKey[]): SellerKey[] {
  const ring: SellerKey[] = [];
  for (const key of keys) {
    const weight = Math.max(1, Math.floor(key.priorityWeight));
    for (let i = 0; i < weight; i += 1) ring.push(key);
  }
  return ring;
}

export class RouterEngine {
  private cursorByRoute = new Map<string, number>();

  pickWeightedRoundRobin(params: {
    orgId: string;
    provider: string;
    model: string;
    candidates: SellerKey[];
    excludeKeyIds?: Set<string>;
  }): SellerKey | null {
    const { orgId, provider, model, candidates } = params;
    const exclude = params.excludeKeyIds ?? new Set<string>();

    const eligible = candidates.filter((k) => !exclude.has(k.id));
    if (eligible.length === 0) return null;

    const ring = toWeightedRing(eligible);
    const routeKey = `${orgId}:${provider}:${model}`;
    const cursor = this.cursorByRoute.get(routeKey) ?? 0;
    const idx = cursor % ring.length;
    this.cursorByRoute.set(routeKey, cursor + 1);
    return ring[idx];
  }
}
