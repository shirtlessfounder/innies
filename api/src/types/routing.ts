export type SellerKeyStatus = 'active' | 'paused' | 'quarantined' | 'invalid' | 'revoked';

export interface SellerKey {
  id: string;
  orgId: string;
  provider: string;
  model: string;
  status: SellerKeyStatus;
  priorityWeight: number;
  monthlyCapacityLimitUnits?: number;
  monthlyCapacityUsedUnits: number;
  supportsStreaming: boolean;
}

export interface RouteRequest {
  requestId: string;
  orgId: string;
  provider: string;
  model: string;
  streaming: boolean;
}

export interface RouteDecision {
  sellerKeyId: string;
  attemptNo: number;
  reason: 'weighted_round_robin';
}

export type UpstreamErrorKind =
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'auth'
  | 'permission'
  | 'model_invalid'
  | 'other';

export interface UpstreamErrorLike extends Error {
  kind: UpstreamErrorKind;
  keySpecific?: boolean;
  statusCode?: number;
}

export interface ProxyResult {
  requestId: string;
  keyId: string;
  attemptNo: number;
  upstreamStatus: number;
  usageUnits?: number;
  contentType?: string;
  data: unknown;
  routeDecision?: Record<string, unknown>;
  ttfbMs?: number | null;
}

export interface PoolHealthSummary {
  totalKeys: number;
  byStatus: Record<SellerKeyStatus, number>;
  totalQueueDepth: number;
  orgQueues: Record<string, { running: number; pending: number }>;
}
