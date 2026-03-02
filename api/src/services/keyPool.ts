import type { PoolHealthSummary, SellerKey, SellerKeyStatus } from '../types/routing.js';

const ALL_STATUSES: SellerKeyStatus[] = ['active', 'paused', 'quarantined', 'invalid', 'revoked'];

export class KeyPool {
  private keys = new Map<string, SellerKey>();

  upsertKey(key: SellerKey): void {
    this.keys.set(key.id, key);
  }

  setKeys(keys: SellerKey[]): void {
    this.keys.clear();
    for (const key of keys) this.upsertKey(key);
  }

  getAll(): SellerKey[] {
    return [...this.keys.values()];
  }

  getById(id: string): SellerKey | undefined {
    return this.keys.get(id);
  }

  getCandidates(provider: string, model: string, streaming: boolean): SellerKey[] {
    return this.getAll().filter((key) => {
      if (key.provider !== provider || key.model !== model) return false;
      if (key.status !== 'active') return false;
      if (streaming && !key.supportsStreaming) return false;
      if (
        key.monthlyCapacityLimitUnits !== undefined
        && key.monthlyCapacityUsedUnits >= key.monthlyCapacityLimitUnits
      ) {
        return false;
      }
      return true;
    });
  }

  addCapacityUsage(keyId: string, units: number): void {
    const key = this.keys.get(keyId);
    if (!key) return;
    key.monthlyCapacityUsedUnits += units;
  }

  getHealthSummary(queueSnapshot: Record<string, { running: number; pending: number }>): PoolHealthSummary {
    const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<SellerKeyStatus, number>;
    for (const key of this.keys.values()) byStatus[key.status] += 1;

    const totalQueueDepth = Object.values(queueSnapshot).reduce((sum, s) => sum + s.pending, 0);

    return {
      totalKeys: this.keys.size,
      byStatus,
      totalQueueDepth,
      orgQueues: queueSnapshot,
    };
  }
}
