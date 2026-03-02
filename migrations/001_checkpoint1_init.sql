-- =========================================================
-- Headroom C1 schema only (internal team MVP)
-- PostgreSQL 15+
-- =========================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------
-- Enums (C1 only)
-- -----------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_role_type') THEN
    CREATE TYPE hr_role_type AS ENUM ('admin', 'seller', 'buyer');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_api_key_scope') THEN
    CREATE TYPE hr_api_key_scope AS ENUM ('buyer_proxy', 'admin');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_seller_key_status') THEN
    CREATE TYPE hr_seller_key_status AS ENUM ('active', 'paused', 'quarantined', 'invalid', 'revoked');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_disable_scope') THEN
    CREATE TYPE hr_disable_scope AS ENUM ('seller_key', 'org', 'model', 'global');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_usage_entry_type') THEN
    CREATE TYPE hr_usage_entry_type AS ENUM ('usage', 'correction', 'reversal');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_recon_status') THEN
    CREATE TYPE hr_recon_status AS ENUM ('ok', 'warn', 'breach', 'unresolved', 'resolved');
  END IF;
END $$;

-- -----------------------------
-- Helpers
-- -----------------------------
CREATE OR REPLACE FUNCTION hr_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hr_prevent_update_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. UPDATE/DELETE not allowed.', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION hr_apply_kill_switch_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hr_kill_switch_current (scope, target_id, is_disabled, reason, source_event_id, updated_at)
  VALUES (NEW.scope, NEW.target_id, NEW.is_disabled, NEW.reason, NEW.id, NEW.created_at)
  ON CONFLICT (scope, target_id)
  DO UPDATE SET
    is_disabled = EXCLUDED.is_disabled,
    reason = EXCLUDED.reason,
    source_event_id = EXCLUDED.source_event_id,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$;

-- -----------------------------
-- Core identity/tenant
-- -----------------------------
CREATE TABLE IF NOT EXISTS hr_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  spend_cap_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hr_orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES hr_users(id) ON DELETE CASCADE,
  role hr_role_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_memberships_org_role ON hr_memberships(org_id, role);
CREATE INDEX IF NOT EXISTS idx_hr_memberships_user ON hr_memberships(user_id);

-- -----------------------------
-- Auth/access
-- -----------------------------
CREATE TABLE IF NOT EXISTS hr_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES hr_orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scope hr_api_key_scope NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_by uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_api_keys_org_active ON hr_api_keys(org_id, is_active);

CREATE TABLE IF NOT EXISTS hr_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,             -- e.g. proxy.usage.write, admin.kill-switch
  tenant_scope text NOT NULL,      -- e.g. org:<uuid> or platform
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_code int NOT NULL,
  response_body jsonb,             -- null for proxy.* scopes
  response_digest text,            -- required for proxy.* scopes
  response_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (scope, tenant_scope, idempotency_key),
  CHECK (
    scope !~ '^proxy\\.' OR
    (response_body IS NULL AND response_digest IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_hr_idempotency_expires_at ON hr_idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_hr_idempotency_scope_tenant ON hr_idempotency_keys(scope, tenant_scope);

-- -----------------------------
-- Seller keys/pool
-- -----------------------------
CREATE TABLE IF NOT EXISTS hr_seller_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hr_orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_label text,
  encrypted_secret bytea NOT NULL,
  encryption_key_id text NOT NULL,
  status hr_seller_key_status NOT NULL DEFAULT 'active',
  monthly_capacity_limit_units bigint,
  monthly_capacity_used_units bigint NOT NULL DEFAULT 0,
  priority_weight int NOT NULL DEFAULT 100,
  failure_count int NOT NULL DEFAULT 0,
  last_health_at timestamptz,
  last_used_at timestamptz,
  compromised_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (monthly_capacity_limit_units IS NULL OR monthly_capacity_limit_units >= 0),
  CHECK (monthly_capacity_used_units >= 0),
  CHECK (priority_weight >= 0),
  CHECK (failure_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_hr_seller_keys_org_status ON hr_seller_keys(org_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_seller_keys_status_weight ON hr_seller_keys(status, priority_weight);
CREATE INDEX IF NOT EXISTS idx_hr_seller_keys_provider_status ON hr_seller_keys(provider, status);

CREATE TABLE IF NOT EXISTS hr_model_compatibility_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  supports_streaming boolean NOT NULL,
  supports_tools boolean NOT NULL,
  max_input_tokens int,
  max_output_tokens int,
  is_enabled boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_hr_model_rules_lookup
  ON hr_model_compatibility_rules(provider, model, is_enabled);

ALTER TABLE hr_model_compatibility_rules
  DROP CONSTRAINT IF EXISTS hr_model_rules_no_overlap_excl;
ALTER TABLE hr_model_compatibility_rules
  ADD CONSTRAINT hr_model_rules_no_overlap_excl
  EXCLUDE USING gist (
    provider WITH =,
    model WITH =,
    tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz), '[)') WITH &&
  );

CREATE TABLE IF NOT EXISTS hr_kill_switch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope hr_disable_scope NOT NULL,
  target_id text NOT NULL,
  is_disabled boolean NOT NULL,
  reason text NOT NULL,
  triggered_by uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_kill_switch_scope_target_created
  ON hr_kill_switch_events(scope, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_kill_switch_current (
  scope hr_disable_scope NOT NULL,
  target_id text NOT NULL,
  is_disabled boolean NOT NULL,
  reason text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES hr_kill_switch_events(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target_id)
);

-- -----------------------------
-- Routing + usage (C1 critical)
-- -----------------------------
CREATE TABLE IF NOT EXISTS hr_routing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  attempt_no int NOT NULL,
  org_id uuid NOT NULL REFERENCES hr_orgs(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES hr_api_keys(id) ON DELETE SET NULL,
  seller_key_id uuid REFERENCES hr_seller_keys(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  streaming boolean NOT NULL DEFAULT false,
  route_decision jsonb NOT NULL,
  upstream_status int,
  error_code text,
  latency_ms int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, request_id, attempt_no),
  CHECK (attempt_no >= 1),
  CHECK (latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_hr_routing_events_org_created
  ON hr_routing_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_routing_events_seller_created
  ON hr_routing_events(seller_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_routing_events_provider_model_created
  ON hr_routing_events(provider, model, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type hr_usage_entry_type NOT NULL DEFAULT 'usage',
  request_id text NOT NULL,
  attempt_no int NOT NULL DEFAULT 1,
  org_id uuid NOT NULL REFERENCES hr_orgs(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES hr_api_keys(id) ON DELETE SET NULL,
  seller_key_id uuid REFERENCES hr_seller_keys(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  usage_units bigint NOT NULL,
  retail_equivalent_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  source_event_id uuid REFERENCES hr_usage_ledger(id) ON DELETE RESTRICT,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (entry_type = 'usage' AND source_event_id IS NULL) OR
    (entry_type IN ('correction', 'reversal') AND source_event_id IS NOT NULL)
  ),
  CHECK (
    input_tokens >= 0 AND
    output_tokens >= 0 AND
    usage_units >= 0 AND
    retail_equivalent_minor >= 0
  )
);

-- one primary usage row; allow many corrections/reversals
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_usage_primary_once
ON hr_usage_ledger (org_id, request_id, attempt_no)
WHERE entry_type = 'usage';

CREATE INDEX IF NOT EXISTS idx_hr_usage_ledger_org_created
  ON hr_usage_ledger(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_usage_ledger_seller_created
  ON hr_usage_ledger(seller_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_usage_ledger_request_id
  ON hr_usage_ledger(request_id);

CREATE TABLE IF NOT EXISTS hr_daily_aggregates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL,
  org_id uuid NOT NULL REFERENCES hr_orgs(id) ON DELETE CASCADE,
  seller_key_id uuid REFERENCES hr_seller_keys(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  requests_count bigint NOT NULL,
  usage_units bigint NOT NULL,
  retail_equivalent_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, org_id, seller_key_id, provider, model),
  CHECK (
    requests_count >= 0 AND
    usage_units >= 0 AND
    retail_equivalent_minor >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_hr_daily_aggregates_day_org
  ON hr_daily_aggregates(day DESC, org_id);

-- -----------------------------
-- Audit + incident
-- -----------------------------
CREATE TABLE IF NOT EXISTS hr_audit_log_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  actor_api_key_id uuid REFERENCES hr_api_keys(id) ON DELETE SET NULL,
  org_id uuid REFERENCES hr_orgs(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_audit_log_created
  ON hr_audit_log_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_audit_log_target_created
  ON hr_audit_log_events(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_audit_log_org_created
  ON hr_audit_log_events(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL,
  category text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  owner_user_id uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  CHECK (status IN ('open', 'mitigated', 'closed'))
);

CREATE TABLE IF NOT EXISTS hr_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL,
  provider text NOT NULL,
  status hr_recon_status NOT NULL,
  expected_units bigint NOT NULL,
  actual_units bigint NOT NULL,
  delta_units bigint NOT NULL,
  delta_pct numeric(8,4) NOT NULL,
  delta_minor bigint,
  reviewed_by uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_date, provider),
  CHECK (expected_units >= 0 AND actual_units >= 0)
);

-- -----------------------------
-- Triggers
-- -----------------------------
DROP TRIGGER IF EXISTS trg_hr_users_set_updated_at ON hr_users;
CREATE TRIGGER trg_hr_users_set_updated_at
BEFORE UPDATE ON hr_users
FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_orgs_set_updated_at ON hr_orgs;
CREATE TRIGGER trg_hr_orgs_set_updated_at
BEFORE UPDATE ON hr_orgs
FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_seller_keys_set_updated_at ON hr_seller_keys;
CREATE TRIGGER trg_hr_seller_keys_set_updated_at
BEFORE UPDATE ON hr_seller_keys
FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_daily_aggregates_set_updated_at ON hr_daily_aggregates;
CREATE TRIGGER trg_hr_daily_aggregates_set_updated_at
BEFORE UPDATE ON hr_daily_aggregates
FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_apply_kill_switch_event ON hr_kill_switch_events;
CREATE TRIGGER trg_hr_apply_kill_switch_event
AFTER INSERT ON hr_kill_switch_events
FOR EACH ROW EXECUTE FUNCTION hr_apply_kill_switch_event();

-- append-only protections
DROP TRIGGER IF EXISTS trg_hr_usage_ledger_append_only ON hr_usage_ledger;
CREATE TRIGGER trg_hr_usage_ledger_append_only
BEFORE UPDATE OR DELETE ON hr_usage_ledger
FOR EACH ROW EXECUTE FUNCTION hr_prevent_update_delete();

COMMIT;
