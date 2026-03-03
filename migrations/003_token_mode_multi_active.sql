-- =========================================================
-- Headroom C1.1: allow multiple active token credentials per org/provider
-- =========================================================

BEGIN;

-- C1 originally enforced single-active via partial unique index.
-- For team pooling we allow multiple active credentials and route-distribute
-- across them in application logic.
DROP INDEX IF EXISTS uq_hr_token_credentials_active;
DROP INDEX IF EXISTS uq_in_token_credentials_active;

COMMIT;
