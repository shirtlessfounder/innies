BEGIN;

CREATE TABLE IF NOT EXISTS in_github_identities (
  user_id uuid PRIMARY KEY REFERENCES in_users(id) ON DELETE CASCADE,
  github_user_id text NOT NULL,
  github_login text NOT NULL,
  github_email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (github_user_id),
  UNIQUE (github_login)
);

CREATE INDEX IF NOT EXISTS idx_in_github_identities_login
  ON in_github_identities (github_login);

CREATE TABLE IF NOT EXISTS in_pilot_cutover_freezes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_kind text NOT NULL,
  buyer_key_id uuid NOT NULL REFERENCES in_api_keys(id) ON DELETE CASCADE,
  source_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  target_org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE RESTRICT,
  source_cutover_id uuid REFERENCES in_cutover_records(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text,
  CHECK (operation_kind IN ('cutover', 'rollback'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_pilot_cutover_freezes_active_buyer_key
  ON in_pilot_cutover_freezes (buyer_key_id)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS in_pilot_cutover_freeze_credentials (
  freeze_id uuid NOT NULL REFERENCES in_pilot_cutover_freezes(id) ON DELETE CASCADE,
  token_credential_id uuid NOT NULL REFERENCES in_token_credentials(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (freeze_id, token_credential_id)
);

CREATE INDEX IF NOT EXISTS idx_in_pilot_cutover_freeze_credentials_token
  ON in_pilot_cutover_freeze_credentials (token_credential_id);

COMMIT;
