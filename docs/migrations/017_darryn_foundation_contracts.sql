BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_finalization_kind') THEN
    CREATE TYPE in_finalization_kind AS ENUM ('served_request', 'correction', 'reversal');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_wallet_effect_type') THEN
    CREATE TYPE in_wallet_effect_type AS ENUM (
      'buyer_debit',
      'buyer_correction',
      'buyer_reversal',
      'manual_credit',
      'manual_debit',
      'payment_credit',
      'payment_reversal'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_earnings_effect_type') THEN
    CREATE TYPE in_earnings_effect_type AS ENUM (
      'contributor_accrual',
      'contributor_correction',
      'contributor_reversal',
      'withdrawal_reserve',
      'withdrawal_release',
      'payout_settlement',
      'payout_adjustment'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_projector_type') THEN
    CREATE TYPE in_projector_type AS ENUM ('wallet', 'earnings');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_projector_state') THEN
    CREATE TYPE in_projector_state AS ENUM ('pending_projection', 'projected', 'needs_operator_correction');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_earnings_balance_bucket') THEN
    CREATE TYPE in_earnings_balance_bucket AS ENUM (
      'pending',
      'withdrawable',
      'reserved_for_payout',
      'settled',
      'adjusted'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_withdrawal_request_status') THEN
    CREATE TYPE in_withdrawal_request_status AS ENUM (
      'requested',
      'under_review',
      'approved',
      'rejected',
      'settlement_failed',
      'settled'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'in_routing_mode') THEN
    CREATE TYPE in_routing_mode AS ENUM (
      'self-free',
      'paid-team-capacity',
      'team-overflow-on-contributor-capacity'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS in_rate_card_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_key text NOT NULL UNIQUE,
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS in_canonical_metering_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  finalization_kind in_finalization_kind NOT NULL,
  idempotency_key text NOT NULL,
  session_id text,
  source_metering_event_id uuid REFERENCES in_canonical_metering_events(id) ON DELETE RESTRICT,
  admission_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  admission_cutover_id uuid,
  admission_routing_mode in_routing_mode NOT NULL,
  consumer_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  consumer_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  team_consumer_id text,
  buyer_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL,
  serving_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  provider_account_id text,
  token_credential_id uuid REFERENCES in_token_credentials(id) ON DELETE SET NULL,
  capacity_owner_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  rate_card_version_id uuid NOT NULL REFERENCES in_rate_card_versions(id) ON DELETE RESTRICT,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  usage_units bigint NOT NULL DEFAULT 0,
  buyer_debit_minor bigint NOT NULL DEFAULT 0,
  contributor_earnings_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, attempt_no, finalization_kind),
  UNIQUE (idempotency_key),
  CHECK (attempt_no >= 1),
  CHECK (
    (finalization_kind = 'served_request' AND source_metering_event_id IS NULL)
    OR (finalization_kind IN ('correction', 'reversal') AND source_metering_event_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_in_canonical_metering_events_request
  ON in_canonical_metering_events (request_id, attempt_no);

CREATE INDEX IF NOT EXISTS idx_in_canonical_metering_events_source
  ON in_canonical_metering_events (source_metering_event_id)
  WHERE source_metering_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_in_canonical_metering_events_consumer_org_created
  ON in_canonical_metering_events (consumer_org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS in_metering_projector_states (
  metering_event_id uuid NOT NULL REFERENCES in_canonical_metering_events(id) ON DELETE CASCADE,
  projector in_projector_type NOT NULL,
  state in_projector_state NOT NULL DEFAULT 'pending_projection',
  retry_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  last_error_code text,
  last_error_message text,
  projected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metering_event_id, projector),
  CHECK (retry_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_in_metering_projector_states_projector_state
  ON in_metering_projector_states (projector, state, updated_at ASC);

CREATE TABLE IF NOT EXISTS in_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id text NOT NULL,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  buyer_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL,
  metering_event_id uuid REFERENCES in_canonical_metering_events(id) ON DELETE RESTRICT,
  effect_type in_wallet_effect_type NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  actor_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  reason text,
  processor_effect_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_wallet_ledger_metering_effect
  ON in_wallet_ledger (metering_event_id, effect_type)
  WHERE metering_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_wallet_ledger_processor_effect
  ON in_wallet_ledger (processor_effect_id, effect_type)
  WHERE processor_effect_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_in_wallet_ledger_wallet_created
  ON in_wallet_ledger (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS in_earnings_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  contributor_user_id uuid NOT NULL REFERENCES in_users(id) ON DELETE RESTRICT,
  metering_event_id uuid REFERENCES in_canonical_metering_events(id) ON DELETE RESTRICT,
  effect_type in_earnings_effect_type NOT NULL,
  balance_bucket in_earnings_balance_bucket NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  actor_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  reason text,
  withdrawal_request_id uuid,
  payout_reference text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_earnings_ledger_metering_effect
  ON in_earnings_ledger (metering_event_id, effect_type)
  WHERE metering_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_in_earnings_ledger_contributor_created
  ON in_earnings_ledger (contributor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS in_withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  contributor_user_id uuid NOT NULL REFERENCES in_users(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  destination jsonb NOT NULL,
  status in_withdrawal_request_status NOT NULL DEFAULT 'requested',
  requested_by_user_id uuid NOT NULL REFERENCES in_users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  note text,
  settlement_reference text,
  settlement_failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_minor > 0)
);

CREATE INDEX IF NOT EXISTS idx_in_withdrawal_requests_contributor_created
  ON in_withdrawal_requests (contributor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS in_fnf_api_key_ownership (
  api_key_id uuid PRIMARY KEY REFERENCES in_api_keys(id) ON DELETE CASCADE,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  owner_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS in_fnf_token_credential_ownership (
  token_credential_id uuid PRIMARY KEY REFERENCES in_token_credentials(id) ON DELETE CASCADE,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  capacity_owner_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS in_cutover_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  target_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  effective_at timestamptz NOT NULL,
  buyer_key_ownership_swapped boolean NOT NULL DEFAULT false,
  provider_credential_ownership_swapped boolean NOT NULL DEFAULT false,
  reserve_floor_migration_completed boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_in_cutover_records_effective_at
  ON in_cutover_records (effective_at DESC, created_at DESC);

ALTER TABLE in_canonical_metering_events
  DROP CONSTRAINT IF EXISTS fk_in_canonical_metering_events_admission_cutover;

ALTER TABLE in_canonical_metering_events
  ADD CONSTRAINT fk_in_canonical_metering_events_admission_cutover
  FOREIGN KEY (admission_cutover_id)
  REFERENCES in_cutover_records(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS in_rollback_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_cutover_id uuid REFERENCES in_cutover_records(id) ON DELETE SET NULL,
  effective_at timestamptz NOT NULL,
  reverted_buyer_key_target_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  reverted_provider_credential_target_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_in_rollback_records_effective_at
  ON in_rollback_records (effective_at DESC, created_at DESC);

ALTER TABLE in_earnings_ledger
  DROP CONSTRAINT IF EXISTS fk_in_earnings_ledger_withdrawal_request;

ALTER TABLE in_earnings_ledger
  ADD CONSTRAINT fk_in_earnings_ledger_withdrawal_request
  FOREIGN KEY (withdrawal_request_id)
  REFERENCES in_withdrawal_requests(id)
  ON DELETE SET NULL;

COMMIT;
