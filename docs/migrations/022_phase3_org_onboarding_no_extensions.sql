BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_users'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_users'
      AND column_name = 'github_login'
  ) THEN
    ALTER TABLE in_users
      ADD COLUMN IF NOT EXISTS github_login text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_orgs'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_orgs'
      AND column_name = 'owner_user_id'
  ) THEN
    ALTER TABLE in_orgs
      ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_memberships'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_memberships'
      AND column_name = 'ended_at'
  ) THEN
    ALTER TABLE in_memberships
      ADD COLUMN IF NOT EXISTS ended_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
      AND column_name = 'membership_id'
  ) THEN
    ALTER TABLE in_api_keys
      ADD COLUMN IF NOT EXISTS membership_id uuid REFERENCES in_memberships(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
      AND column_name = 'revoked_at'
  ) THEN
    ALTER TABLE in_api_keys
      ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS in_org_invites (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES in_orgs(id) ON DELETE CASCADE,
  github_login text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES in_users(id) ON DELETE RESTRICT,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  accepted_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  revoked_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_in_org_invites_status
    CHECK (status IN ('pending', 'revoked', 'accepted'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'in_memberships'
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) = 'UNIQUE (org_id, user_id)'
  ) THEN
    ALTER TABLE in_memberships
      ADD CONSTRAINT uq_in_memberships_org_user UNIQUE (org_id, user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_org_invites_pending_org_login
  ON in_org_invites (org_id, github_login)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_api_keys_active_membership
  ON in_api_keys (membership_id)
  WHERE membership_id IS NOT NULL
    AND revoked_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT ALL PRIVILEGES ON TABLE in_org_invites TO niyant;
    GRANT SELECT (github_login), INSERT (github_login), UPDATE (github_login), REFERENCES (github_login)
      ON TABLE in_users TO niyant;
    GRANT SELECT (owner_user_id), INSERT (owner_user_id), UPDATE (owner_user_id), REFERENCES (owner_user_id)
      ON TABLE in_orgs TO niyant;
    GRANT SELECT (ended_at), INSERT (ended_at), UPDATE (ended_at), REFERENCES (ended_at)
      ON TABLE in_memberships TO niyant;
    GRANT SELECT (membership_id, revoked_at), INSERT (membership_id, revoked_at), UPDATE (membership_id, revoked_at), REFERENCES (membership_id, revoked_at)
      ON TABLE in_api_keys TO niyant;
  END IF;
END $$;

COMMIT;
