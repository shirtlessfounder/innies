# Token Label Set Design

## Goal

Add a focused operator flow for renaming an existing token credential label without rotating, pausing, probing, or otherwise changing the credential.

## Problem

Innies stores token labels in `debugLabel`, and operators use those labels throughout routing/debug output. Today labels can be set on create and changed during rotate, but there is no narrow rename flow for an already-existing credential.

That creates unnecessary operator friction:

- renaming a label currently implies a full token rotation, which is the wrong mutation
- there is no dedicated script for simple metadata cleanup
- the admin API has no label-only update endpoint

The user wants a direct rename path.

## Scope

In scope:

- a new admin API endpoint for label-only updates
- a matching operator script `innies-token-label-set`
- repository/service support for label-only mutation
- docs updates for the new command and endpoint
- tests covering the new backend behavior

Out of scope:

- clearing labels to `null`
- rotating credentials as part of rename
- changing token status, refresh tokens, contribution caps, or expiry
- bulk label edits
- uniqueness enforcement across labels

## User-Facing Requirements

- Operators can rename an existing token credential label without rotating the token.
- The script supports the usual selection modes:
  - list selection by number
  - direct selection by credential UUID
  - direct selection by exact current label
- The script accepts only a non-empty replacement label.
- If an exact current label is ambiguous, the script fails and tells the operator to use a number or UUID instead.
- The new flow follows the current admin-script ergonomics and auth model.

## API Design

### Route

Add:

- `PATCH /v1/admin/token-credentials/:id/label`

This route follows the same pattern as the existing refresh-token and contribution-cap PATCH routes:

- admin API key required
- idempotency key required
- idempotent replay supported
- JSON request/response

### Request Body

```json
{
  "debugLabel": "darryn-codex-main"
}
```

Validation rules:

- `debugLabel` is required
- trim surrounding whitespace
- minimum length `1`
- maximum length `64`
- empty-after-trim is rejected

### Eligibility

The endpoint updates only non-revoked credentials.

Behavior:

- if the credential does not exist, return `404`
- if the credential is revoked, treat it as not eligible and return `404`
- all other statuses remain eligible:
  - `active`
  - `paused`
  - `maxed`
  - `expired`
  - `rotating`

This keeps the route narrowly focused on metadata while avoiding historical edits on revoked credentials.

### Response Shape

```json
{
  "ok": true,
  "id": "2fec984c-a7e6-42c7-8b34-0d21bf0d4eb4",
  "orgId": "818d0cc7-7ed2-469f-b690-a977e72a921d",
  "provider": "openai",
  "status": "active",
  "previousDebugLabel": "darryn-codex-2",
  "debugLabel": "darryn-codex-main",
  "changed": true
}
```

Semantics:

- `changed: true` when the new label differs from the stored label
- `changed: false` when the new label exactly matches the stored label after validation

Returning `changed: false` avoids turning an idempotent rename request into an error.

### Idempotency Scope

Add a new idempotency scope:

- `admin_token_credentials_label_v1`

The request hash should include:

- credential id
- parsed body
- caller admin API key id

## Backend Design

### Repository

Add a narrow repository method to update only `debug_label` and return the updated credential row.

Preferred shape:

- `updateDebugLabel(id: string, debugLabel: string): Promise<TokenCredential | null>`

Repository behavior:

- update only `debug_label`
- reject revoked credentials by filtering `status <> 'revoked'`
- return the updated row for response-building and audit logging
- return `null` if no eligible row exists

### Service

Add a service method:

- `updateDebugLabel(id: string, debugLabel: string, actor?): Promise<... | null>`

Service responsibilities:

- fetch/update through the repository
- emit one audit event
- preserve current status/provider/org information for the response

Audit event:

- action: `token_credential.update_debug_label`
- metadata includes:
  - `provider`
  - `status`
  - `previousDebugLabel`
  - `debugLabel`
  - `changed`

### Route Integration

In `admin.ts`:

- add a `zod` schema for the request body
- place the new route near the other token-credential PATCH routes
- use the same idempotency structure as `refresh-token` and `contribution-cap`
- build the response from the updated credential returned by the service

## Operator Script Design

### Command

Add:

- `innies-token-label-set`

Update `scripts/install.sh` so the command is installed into `~/.local/bin`.

### Script UX

The script should mirror the current contribution-cap/pause selection style.

Flow:

1. load env via `_common.sh`
2. require admin token
3. require `DATABASE_URL`
4. require `psql`
5. prompt for provider (`Claude Code` or `Codex`)
6. list non-revoked credentials for that provider, newest first
7. prompt for `credential number, UUID, or exact debug label`
8. prompt for `new label`
9. prompt for `Idempotency-Key`
10. print a short summary
11. call `PATCH /v1/admin/token-credentials/:id/label`

The credential list should show:

- number
- current label or `(no label)`
- status
- id
- updated time

### Selection Rules

- number selection uses the displayed list
- UUID selection works directly
- exact label selection uses the existing helper logic and remains exact-case
- if exact label lookup returns multiple matches in the chosen provider lane, the script errors and requires UUID or numeric selection

### New Label Rules

- non-empty only
- trim before send
- no `clear` mode

## Documentation Changes

Update:

- `scripts/README.md`
- `docs/API_CONTRACT.md`
- install summary output in `scripts/install.sh`
- any repo-local references that list the operator command inventory

Documentation should clearly state:

- `innies-token-label-set` renames labels only
- it does not rotate token material
- it requires admin auth and `DATABASE_URL`

## Risks

Primary risks:

- operators may assume rename also changes historical event payloads already persisted elsewhere
- duplicate labels in one provider lane can make exact-label lookup ambiguous

Mitigations:

- keep the command name explicit: `label-set`
- keep the response explicit: `previousDebugLabel`, `debugLabel`, `changed`
- make ambiguous-label handling fail loudly and direct operators to UUID/number

## Verification Requirements

Implementation is complete only if all of the following are true:

1. `PATCH /v1/admin/token-credentials/:id/label` exists and requires admin auth plus idempotency key.
2. The route rejects empty labels and labels longer than 64 characters.
3. The route returns `404` for missing or revoked credentials.
4. The route returns `changed: false` when the label already matches.
5. Audit logging records `token_credential.update_debug_label` with previous/new label metadata.
6. `innies-token-label-set` is installed by `scripts/install.sh`.
7. `innies-token-label-set` supports number / UUID / exact current label selection.
8. `scripts/README.md` and `docs/API_CONTRACT.md` document the new flow.

## Open Questions

None.
