# Token Mode Agent 3 Handoff (C1)

Date: 2026-03-01
Scope: schema/repo primitives for token-mode credential lifecycle.

## Delivered
- Added migrations:
  - `migrations/002_token_mode_credentials.sql`
  - `migrations/002_token_mode_credentials_no_extensions.sql`
- Added repository:
  - `api/src/repos/tokenCredentialRepository.ts`
- Added service with audit hooks:
  - `api/src/services/tokenCredentialService.ts`
- Wired runtime:
  - `runtime.repos.tokenCredentials`
  - `runtime.services.tokenCredentials`

## Integration Notes (for Agent 1)
- Use `runtime.repos.tokenCredentials.selectActive(orgId, provider)` for routing-time credential lookup.
- Use `runtime.services.tokenCredentials.rotate(...)` for rotation flow so audit logging is preserved.
- Use `runtime.services.tokenCredentials.revoke(...)` for revoke actions so audit logging is preserved.
- `authScheme` is explicit (`x_api_key` or `bearer`) on credential records.
- Token fields are encrypted-at-rest and decrypted only in process memory.

## DB Invariants Implemented
- One active credential per (`org_id`, `provider`) via partial unique index.
- Monotonic `rotation_version` per (`org_id`, `provider`) via trigger guard.
- Status transition guard enforced via trigger:
  - allowed: `active -> rotating|expired|revoked`
  - allowed: `rotating -> active|expired|revoked`
  - allowed: `expired -> revoked`

## Rollback Notes
- Immediate rollback: disable token-mode routing in API config/feature guard.
- Migration rollback (if required):
  - drop `hr_token_credentials` table
  - drop trigger functions:
    - `hr_token_credentials_validate_transition`
    - `hr_token_credentials_enforce_rotation_version`
  - drop enum types:
    - `hr_token_auth_scheme`
    - `hr_token_credential_status`

## DB Verification Queries
1. Encrypted-at-rest check:
```sql
select id, provider, org_id, encode(encrypted_access_token, 'escape') as access_preview
from hr_token_credentials
order by created_at desc
limit 5;
```
Expectation: no plaintext token values present.

2. One-active-per-org/provider check:
```sql
select org_id, provider, count(*) as active_count
from hr_token_credentials
where status = 'active'
group by org_id, provider
having count(*) > 1;
```
Expectation: zero rows.

3. Rotation/status transition sanity:
```sql
select org_id, provider, id, rotation_version, status, created_at, updated_at, revoked_at
from hr_token_credentials
order by org_id, provider, rotation_version asc;
```
Expectation: versions strictly increase and status transitions align with policy.

## Manual DB-Backed Token Check Script
- Script: `api/scripts/token_mode_manual_check.sh`
- Purpose: run one non-streaming token-mode proxy request and print evidence:
  - request id
  - token credential response header (if present)
  - latest usage ledger row
  - latest token credential audit row
