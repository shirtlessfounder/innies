export const TABLES = {
  auditLogEvents: 'in_audit_log_events',
  idempotencyKeys: 'in_idempotency_keys',
  orgs: 'in_orgs',
  requestLog: 'in_request_log',
  sellerKeys: 'in_seller_keys',
  tokenCredentials: 'in_token_credentials',
  tokenCredentialEvents: 'in_token_credential_events',
  usageLedger: 'in_usage_ledger',
  dailyAggregates: 'in_daily_aggregates',
  reconciliationRuns: 'in_reconciliation_runs',
  routingEvents: 'in_routing_events'
} as const;
