BEGIN;

CREATE TABLE IF NOT EXISTS in_pilot_admission_freezes (
  id uuid PRIMARY KEY,
  resource_type text NOT NULL CHECK (resource_type IN ('buyer_key', 'token_credential')),
  resource_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('cutover', 'rollback')),
  source_org_id uuid REFERENCES in_orgs(id) ON DELETE SET NULL,
  target_org_id uuid REFERENCES in_orgs(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  released_at timestamptz,
  release_reason text,
  released_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_pilot_admission_freezes_active_resource
  ON in_pilot_admission_freezes (resource_type, resource_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_in_pilot_admission_freezes_active_lookup
  ON in_pilot_admission_freezes (resource_type, resource_id, created_at DESC)
  WHERE released_at IS NULL;

COMMIT;
