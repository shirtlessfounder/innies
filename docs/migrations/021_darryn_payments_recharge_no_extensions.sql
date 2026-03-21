BEGIN;

CREATE TABLE IF NOT EXISTS in_payment_profiles (
  id uuid PRIMARY KEY,
  wallet_id text NOT NULL UNIQUE,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  processor text NOT NULL DEFAULT 'stripe',
  processor_customer_id text NOT NULL UNIQUE,
  default_payment_method_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS in_payment_methods (
  id uuid PRIMARY KEY,
  wallet_id text NOT NULL,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  payment_profile_id uuid NOT NULL REFERENCES in_payment_profiles(id) ON DELETE CASCADE,
  processor text NOT NULL DEFAULT 'stripe',
  processor_payment_method_id text NOT NULL UNIQUE,
  processor_customer_id text NOT NULL,
  brand text NOT NULL,
  last4 char(4) NOT NULL,
  exp_month integer NOT NULL,
  exp_year integer NOT NULL,
  funding text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  detached_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_in_payment_profiles_default_method'
      AND table_name = 'in_payment_profiles'
  ) THEN
    ALTER TABLE in_payment_profiles
      ADD CONSTRAINT fk_in_payment_profiles_default_method
      FOREIGN KEY (default_payment_method_id)
      REFERENCES in_payment_methods(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_payment_methods_wallet_created
  ON in_payment_methods (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS in_auto_recharge_settings (
  wallet_id text PRIMARY KEY,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  amount_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  payment_method_id uuid REFERENCES in_payment_methods(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS in_payment_attempts (
  id uuid PRIMARY KEY,
  wallet_id text NOT NULL,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  payment_method_id uuid REFERENCES in_payment_methods(id) ON DELETE SET NULL,
  processor text NOT NULL DEFAULT 'stripe',
  kind text NOT NULL,
  trigger text,
  status text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  processor_checkout_session_id text,
  processor_payment_intent_id text,
  processor_effect_id text,
  idempotency_key text,
  initiated_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  last_error_code text,
  last_error_message text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_in_payment_attempts_wallet_created
  ON in_payment_attempts (wallet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_in_payment_attempts_wallet_status
  ON in_payment_attempts (wallet_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_payment_attempts_wallet_pending_auto_recharge
  ON in_payment_attempts (wallet_id)
  WHERE kind = 'auto_recharge'
    AND status IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_payment_attempts_wallet_manual_topup_idempotency
  ON in_payment_attempts (wallet_id, idempotency_key)
  WHERE kind = 'manual_topup'
    AND idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS in_payment_webhook_events (
  id uuid PRIMARY KEY,
  processor text NOT NULL DEFAULT 'stripe',
  processor_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS in_payment_outcomes (
  id uuid PRIMARY KEY,
  wallet_id text NOT NULL,
  owner_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  payment_attempt_id uuid REFERENCES in_payment_attempts(id) ON DELETE SET NULL,
  processor text NOT NULL DEFAULT 'stripe',
  processor_event_id text NOT NULL,
  processor_effect_id text NOT NULL UNIQUE,
  effect_type in_wallet_effect_type NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  metadata jsonb,
  wallet_recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_payment_outcomes_effect_type
    CHECK (effect_type IN ('payment_credit', 'payment_reversal'))
);

CREATE INDEX IF NOT EXISTS idx_in_payment_outcomes_wallet_created
  ON in_payment_outcomes (wallet_id, created_at DESC);

COMMIT;
