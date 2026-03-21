export type PilotSession = {
  sessionKind: 'darryn_self' | 'admin_self' | 'admin_impersonation';
  actorUserId: string | null;
  actorApiKeyId: string | null;
  actorOrgId: string | null;
  effectiveOrgId: string;
  effectiveOrgSlug: string | null;
  effectiveOrgName: string | null;
  githubLogin: string | null;
  userEmail: string | null;
  impersonatedUserId: string | null;
  issuedAt?: string;
  expiresAt?: string;
};

export type WalletSnapshot = {
  walletId: string;
  ownerOrgId: string;
  balanceMinor: number;
  currency: string;
};

export type WalletLedgerEntry = {
  id: string;
  wallet_id?: string;
  entry_type?: string | null;
  effect_type: string;
  amount_minor: number;
  currency?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

export type ConnectedAccount = {
  credentialId: string;
  orgId: string;
  provider: string;
  debugLabel: string | null;
  status: string;
  rawStatus: string;
  expandedStatus: string;
  statusSource: string | null;
  exclusionReason: string | null;
  authDiagnosis: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenState: 'missing' | 'present' | null;
  expiresAt: string;
  rateLimitedUntil: string | null;
  nextProbeAt: string | null;
  fiveHourReservePercent: number;
  sevenDayReservePercent: number;
  providerUsageRefreshSupported: boolean;
  providerUsageSource: string | null;
  providerUsageFetchedAt: string | null;
  providerUsageState: 'unsupported' | 'missing' | 'fresh' | 'soft_stale' | 'hard_stale';
  providerUsageWarning: string | null;
  fiveHourUtilizationRatio: number | null;
  fiveHourResetsAt: string | null;
  fiveHourContributionCapExhausted: boolean | null;
  fiveHourUsageExhausted: boolean | null;
  sevenDayUtilizationRatio: number | null;
  sevenDayResetsAt: string | null;
  sevenDayContributionCapExhausted: boolean | null;
  sevenDayUsageExhausted: boolean | null;
};

export type RequestHistoryRow = {
  request_id: string;
  attempt_no: number;
  session_id: string | null;
  admission_org_id: string;
  admission_cutover_id: string | null;
  admission_routing_mode: string;
  consumer_org_id: string;
  buyer_key_id: string | null;
  serving_org_id: string;
  provider_account_id: string | null;
  token_credential_id: string | null;
  capacity_owner_user_id: string | null;
  provider: string;
  model: string;
  rate_card_version_id: string;
  input_tokens: number;
  output_tokens: number;
  usage_units: number;
  buyer_debit_minor: number;
  contributor_earnings_minor: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  prompt_preview: string | null;
  response_preview: string | null;
  route_decision: Record<string, unknown> | null;
  projector_states: Array<{
    projector: string;
    state: string;
    retryCount: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> | null;
};

export type EarningsSummary = {
  pendingMinor: number;
  withdrawableMinor: number;
  reservedForPayoutMinor: number;
  settledMinor: number;
  adjustedMinor: number;
};

export type EarningsHistoryEntry = {
  id?: string;
  earnings_ledger_entry_id?: string;
  effect_type?: string | null;
  bucket?: string | null;
  amount_minor?: number | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type Withdrawal = {
  id: string;
  status: string;
  amount_minor: number;
  destination?: Record<string, unknown> | null;
  note?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  settlement_reference?: string | null;
  settlement_failure_reason?: string | null;
};

export type StoredPaymentMethod = {
  id: string;
  processor: 'stripe';
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  funding: string | null;
  status: 'active' | 'detached';
};

export type AutoRechargeSettings = {
  enabled: boolean;
  amountMinor: number;
  currency: string;
};

export type PaymentAttempt = {
  id: string;
  kind: 'manual_topup' | 'auto_recharge';
  trigger: 'admission_blocked' | 'post_finalization_negative' | null;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  amountMinor: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type PilotFundingState = {
  paymentMethod: StoredPaymentMethod | null;
  autoRecharge: AutoRechargeSettings;
  attempts: PaymentAttempt[];
};

export type PilotIdentityDiscoveryEntry = {
  targetUserId: string;
  targetOrgId: string;
  targetOrgSlug: string | null;
  targetOrgName: string | null;
  githubLogin: string | null;
  userEmail: string;
  displayName: string | null;
};

export type PilotDashboardData = {
  session: PilotSession;
  wallet: WalletSnapshot;
  walletLedger: WalletLedgerEntry[];
  funding: PilotFundingState;
  requests: RequestHistoryRow[];
  accounts: ConnectedAccount[];
  earningsSummary: EarningsSummary;
  earningsHistory: EarningsHistoryEntry[];
  withdrawals: Withdrawal[];
};

export type AdminPilotAccountView = {
  identity: PilotIdentityDiscoveryEntry;
  wallet: WalletSnapshot;
  walletLedger: WalletLedgerEntry[];
  requests: RequestHistoryRow[];
  requestExplanation: RequestHistoryRow | null;
  accounts: ConnectedAccount[];
  earningsSummary: EarningsSummary | null;
  earningsHistory: EarningsHistoryEntry[];
  withdrawals: Withdrawal[];
};
