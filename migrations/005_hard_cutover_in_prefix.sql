-- =========================================================
-- Hard cutover: rename Headroom hr_* objects to Innies in_*
-- Run after 001-004 migrations.
-- =========================================================

BEGIN;

-- Enums
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_role_type') THEN
    ALTER TYPE hr_role_type RENAME TO in_role_type;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_api_key_scope') THEN
    ALTER TYPE hr_api_key_scope RENAME TO in_api_key_scope;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_seller_key_status') THEN
    ALTER TYPE hr_seller_key_status RENAME TO in_seller_key_status;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_disable_scope') THEN
    ALTER TYPE hr_disable_scope RENAME TO in_disable_scope;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_usage_entry_type') THEN
    ALTER TYPE hr_usage_entry_type RENAME TO in_usage_entry_type;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_recon_status') THEN
    ALTER TYPE hr_recon_status RENAME TO in_recon_status;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_token_auth_scheme') THEN
    ALTER TYPE hr_token_auth_scheme RENAME TO in_token_auth_scheme;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_token_credential_status') THEN
    ALTER TYPE hr_token_credential_status RENAME TO in_token_credential_status;
  END IF;
END $$;

-- Functions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hr_set_updated_at') THEN
    ALTER FUNCTION hr_set_updated_at() RENAME TO in_set_updated_at;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hr_prevent_update_delete') THEN
    ALTER FUNCTION hr_prevent_update_delete() RENAME TO in_prevent_update_delete;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hr_apply_kill_switch_event') THEN
    ALTER FUNCTION hr_apply_kill_switch_event() RENAME TO in_apply_kill_switch_event;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hr_token_credentials_validate_transition') THEN
    ALTER FUNCTION hr_token_credentials_validate_transition() RENAME TO in_token_credentials_validate_transition;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hr_token_credentials_enforce_rotation_version') THEN
    ALTER FUNCTION hr_token_credentials_enforce_rotation_version() RENAME TO in_token_credentials_enforce_rotation_version;
  END IF;
END $$;

-- Tables
ALTER TABLE IF EXISTS hr_users RENAME TO in_users;
ALTER TABLE IF EXISTS hr_orgs RENAME TO in_orgs;
ALTER TABLE IF EXISTS hr_memberships RENAME TO in_memberships;
ALTER TABLE IF EXISTS hr_api_keys RENAME TO in_api_keys;
ALTER TABLE IF EXISTS hr_idempotency_keys RENAME TO in_idempotency_keys;
ALTER TABLE IF EXISTS hr_seller_keys RENAME TO in_seller_keys;
ALTER TABLE IF EXISTS hr_model_compatibility_rules RENAME TO in_model_compatibility_rules;
ALTER TABLE IF EXISTS hr_kill_switch_events RENAME TO in_kill_switch_events;
ALTER TABLE IF EXISTS hr_kill_switch_current RENAME TO in_kill_switch_current;
ALTER TABLE IF EXISTS hr_routing_events RENAME TO in_routing_events;
ALTER TABLE IF EXISTS hr_usage_ledger RENAME TO in_usage_ledger;
ALTER TABLE IF EXISTS hr_daily_aggregates RENAME TO in_daily_aggregates;
ALTER TABLE IF EXISTS hr_audit_log_events RENAME TO in_audit_log_events;
ALTER TABLE IF EXISTS hr_incident_events RENAME TO in_incident_events;
ALTER TABLE IF EXISTS hr_reconciliation_runs RENAME TO in_reconciliation_runs;
ALTER TABLE IF EXISTS hr_token_credentials RENAME TO in_token_credentials;

-- Key indexes (optional but keeps naming consistent)
ALTER INDEX IF EXISTS uq_hr_users_email_lower RENAME TO uq_in_users_email_lower;
ALTER INDEX IF EXISTS idx_hr_memberships_org_role RENAME TO idx_in_memberships_org_role;
ALTER INDEX IF EXISTS idx_hr_memberships_user RENAME TO idx_in_memberships_user;
ALTER INDEX IF EXISTS idx_hr_api_keys_org_active RENAME TO idx_in_api_keys_org_active;
ALTER INDEX IF EXISTS idx_hr_idempotency_expires_at RENAME TO idx_in_idempotency_expires_at;
ALTER INDEX IF EXISTS idx_hr_idempotency_scope_tenant RENAME TO idx_in_idempotency_scope_tenant;
ALTER INDEX IF EXISTS idx_hr_seller_keys_org_status RENAME TO idx_in_seller_keys_org_status;
ALTER INDEX IF EXISTS idx_hr_seller_keys_status_weight RENAME TO idx_in_seller_keys_status_weight;
ALTER INDEX IF EXISTS idx_hr_seller_keys_provider_status RENAME TO idx_in_seller_keys_provider_status;
ALTER INDEX IF EXISTS idx_hr_model_rules_lookup RENAME TO idx_in_model_rules_lookup;
ALTER INDEX IF EXISTS idx_hr_kill_switch_scope_target_created RENAME TO idx_in_kill_switch_scope_target_created;
ALTER INDEX IF EXISTS idx_hr_routing_events_org_created RENAME TO idx_in_routing_events_org_created;
ALTER INDEX IF EXISTS idx_hr_routing_events_seller_created RENAME TO idx_in_routing_events_seller_created;
ALTER INDEX IF EXISTS idx_hr_routing_events_provider_model_created RENAME TO idx_in_routing_events_provider_model_created;
ALTER INDEX IF EXISTS uq_hr_usage_ledger_usage_once RENAME TO uq_in_usage_ledger_usage_once;
ALTER INDEX IF EXISTS idx_hr_usage_ledger_org_created RENAME TO idx_in_usage_ledger_org_created;
ALTER INDEX IF EXISTS idx_hr_usage_ledger_seller_created RENAME TO idx_in_usage_ledger_seller_created;
ALTER INDEX IF EXISTS idx_hr_usage_ledger_request_id RENAME TO idx_in_usage_ledger_request_id;
ALTER INDEX IF EXISTS idx_hr_daily_aggregates_day_org RENAME TO idx_in_daily_aggregates_day_org;
ALTER INDEX IF EXISTS idx_hr_audit_log_events_created RENAME TO idx_in_audit_log_events_created;
ALTER INDEX IF EXISTS idx_hr_audit_log_events_target_created RENAME TO idx_in_audit_log_events_target_created;
ALTER INDEX IF EXISTS idx_hr_audit_log_events_org_created RENAME TO idx_in_audit_log_events_org_created;
ALTER INDEX IF EXISTS uq_hr_token_credentials_active RENAME TO uq_in_token_credentials_active;
ALTER INDEX IF EXISTS idx_hr_token_credentials_org_provider_status RENAME TO idx_in_token_credentials_org_provider_status;
ALTER INDEX IF EXISTS idx_hr_token_credentials_weekly_window RENAME TO idx_in_token_credentials_weekly_window;

COMMIT;
