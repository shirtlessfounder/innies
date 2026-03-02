export type SellerKeySummary = {
  id: string;
  provider: string;
  status: 'active' | 'paused' | 'quarantined' | 'invalid' | 'revoked';
  capUnits: number;
  usedUnits: number;
  lastHealthAt: string;
};

export type BuyerUsageSummary = {
  period: string;
  requests: number;
  usageUnits: number;
  retailEquivalentMinor: number;
};

export type PoolHealthSummary = {
  activeKeys: number;
  quarantinedKeys: number;
  inFlightRequests: number;
  failureRatePct: number;
};

export async function getSellerKeySummaries(): Promise<SellerKeySummary[]> {
  return [
    {
      id: 'key_a1',
      provider: 'anthropic',
      status: 'active',
      capUnits: 100000,
      usedUnits: 32450,
      lastHealthAt: '2026-03-01T12:00:00Z'
    },
    {
      id: 'key_b2',
      provider: 'anthropic',
      status: 'quarantined',
      capUnits: 50000,
      usedUnits: 47210,
      lastHealthAt: '2026-03-01T11:52:00Z'
    }
  ];
}

export async function getBuyerUsageSummary(): Promise<BuyerUsageSummary> {
  return {
    period: '2026-03',
    requests: 812,
    usageUnits: 182344,
    retailEquivalentMinor: 24500
  };
}

export async function getPoolHealthSummary(): Promise<PoolHealthSummary> {
  return {
    activeKeys: 7,
    quarantinedKeys: 1,
    inFlightRequests: 4,
    failureRatePct: 0.7
  };
}
