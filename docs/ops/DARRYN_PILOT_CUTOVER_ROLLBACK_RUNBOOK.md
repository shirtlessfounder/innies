# Darryn Pilot Cutover And Rollback Runbook

Operator runbook for the Darryn Phase 2 cutover-and-access workstream.

This covers:

- `fnf` org bootstrap
- buyer-key ownership cutover
- provider-credential ownership cutover
- GitHub-backed pilot access
- admin impersonation context
- rollback after a bad cutover

It does not cover routing policy, wallet logic, earnings logic, dashboard UI, or payments.

## Preconditions

1. Apply the cutover-access migration:

```bash
psql "$DATABASE_URL" -f docs/migrations/018_darryn_cutover_access.sql
```

2. Confirm these env vars are set on the API process:

```bash
export PILOT_DARRYN_GITHUB_ALLOWLIST="darryn"
export PILOT_ADMIN_GITHUB_ALLOWLIST="comma,separated,admin,logins"
export PILOT_GITHUB_CLIENT_ID="..."
export PILOT_GITHUB_CLIENT_SECRET="..."
export PILOT_GITHUB_REDIRECT_URI="https://<host>/v1/pilot/auth/github/callback"
export PILOT_SESSION_SECRET="..."
```

3. Confirm the buyer key and token credential ids to migrate.
4. Confirm routing is ready to accept the reserve-floor migration handshake:

```text
migrateReserveFloors(from_owner, to_owner, cutover_id)
```

Cutover is not complete until that handshake succeeds.

## Cutover

Use the admin API with an Innies admin key.

```bash
curl -sS \
  -X POST \
  -H "Authorization: Bearer $INNIES_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen | tr '[:upper:]' '[:lower:]')" \
  "$INNIES_BASE_URL/v1/admin/pilot/darryn/cutover" \
  -d '{
    "buyerKeyId": "<buyer-key-id>",
    "tokenCredentialIds": ["<credential-id-1>", "<credential-id-2>"],
    "darrynEmail": "darryn@example.com",
    "darrynDisplayName": "Darryn",
    "darrynGithubLogin": "darryn",
    "darrynGithubUserId": "<github-user-id>"
  }'
```

Expected behavior:

- a cutover freeze row is written first
- new admissions with the buyer key fail closed while the freeze is active
- existing already-admitted traffic stays historical Innies traffic
- ownership mappings are written for the buyer key and token credentials
- the buyer key and credentials are reassigned to `fnf`
- routing reserve floors are migrated from the Innies owner to the `fnf` owner
- the committed `cutover_record` is written only after the reserve-floor handshake succeeds
- the freeze is released only after the committed cutover is written

If the reserve-floor migration fails, the cutover must be treated as incomplete and fail closed.

## Cutover Verification

1. Confirm the cutover endpoint returned `ok: true` and a `cutoverId`.
2. Confirm buyer-key auth resolves to `fnf` for new admissions.
3. Confirm existing connected credentials still resolve without reconnect.
4. Confirm Darryn can log in through:

```text
GET /v1/pilot/auth/github/callback?mode=darryn&code=...
```

5. Confirm an admin can log in through:

```text
GET /v1/pilot/auth/github/callback?mode=admin&code=...
```

6. Confirm admin impersonation works:

```text
POST /v1/pilot/session/impersonate
POST /v1/pilot/session/impersonation/clear
```

7. Confirm there is no active freeze row left behind for the buyer key or credentials.

## Rollback

Rollback moves future admissions back to historical Innies ownership. Already-admitted `fnf` traffic remains historical `fnf` traffic.

```bash
curl -sS \
  -X POST \
  -H "Authorization: Bearer $INNIES_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen | tr '[:upper:]' '[:lower:]')" \
  "$INNIES_BASE_URL/v1/admin/pilot/darryn/rollback" \
  -d '{
    "buyerKeyId": "<buyer-key-id>",
    "tokenCredentialIds": ["<credential-id-1>", "<credential-id-2>"],
    "sourceCutoverId": "<cutover-id>"
  }'
```

Expected behavior:

- a rollback freeze row is written first
- new admissions with the buyer key fail closed while the rollback is in progress
- ownership mappings are updated back to the Innies org
- the buyer key and credentials are reassigned back to the Innies org
- the committed `rollback_record` is written
- the freeze is released only after the committed rollback is written

## Rollback Verification

1. Confirm the rollback endpoint returned `ok: true` and a `rollbackId`.
2. Confirm new buyer-key admissions resolve back to Innies ownership.
3. Confirm token credentials resolve back to Innies ownership without reconnect.
4. Confirm Darryn pilot login is still allowlisted, but post-rollback business logic reads historical Innies ownership for new admissions.
5. Confirm admin self-context and admin impersonation session reads still work.
6. Confirm there is no active rollback freeze row left behind.

## Failure Handling

- If a cutover or rollback request returns while a freeze is still active, stop admitting new pilot traffic for that buyer key until the freeze state is understood.
- If the reserve-floor handshake fails, do not treat the cutover as committed even if ownership writes already happened. The system is designed to fail closed before the committed marker.
- If Darryn login fails after cutover, verify the GitHub allowlist env vars and the stored GitHub identity row before retrying the cutover.
