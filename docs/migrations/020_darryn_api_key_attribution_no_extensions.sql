BEGIN;

ALTER TABLE in_earnings_ledger
  ADD COLUMN IF NOT EXISTS actor_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL;

ALTER TABLE in_withdrawal_requests
  ADD COLUMN IF NOT EXISTS reviewed_by_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL;

COMMIT;
