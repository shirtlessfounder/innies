# Token Mode Execution Plan V2 (C1)

Date: 2026-03-01
Scope: Close remaining C1 token-mode gaps for internal 4-user pilot.

## Objective
Ship a valid non-streaming token-mode pilot path with deterministic policy behavior, operational usability, and verifiable evidence.

## Current State
- Done:
  - Token-mode routing path exists.
  - Non-allowlisted deterministic block exists.
  - Token credential schema/repo/service exists.
  - Token credential admin API exists (create/rotate/revoke).
  - Build/tests/CLI smoke currently pass.
- Remaining gaps:
  - Expiry prefilter and refresh-before-expiry window not fully enforced in routing selection path.
  - Token credential repo has select/map mismatch (`listActiveForRouting` vs `mapRow` expected fields).
  - Token-mode route behavior lacks route-level integration tests.
  - New Agent 1 paths lack route-level integration tests (non-allowlisted block, terminal token-auth error mapping, admin token credential endpoints).
  - Default proxy request shape still defaults to `streaming=true` (easy token-mode rejection).
  - Real backend token-route proof is still optional in smoke (env-gated).

## Workstreams

## Workstream 1: Token Credential Selection Hardening
Owner: Agent 3
Priority: P0

### Tasks
- [ ] Enforce `expires_at > now()` in active credential selection query.
- [ ] Add pre-request refresh trigger for credentials within 5-minute expiry window.
- [ ] Resolve repository select/map mismatch:
  - include required fields in `listActiveForRouting` select, or
  - make mapper tolerant for routing-select shape.
- [ ] Add/adjust tests to cover expired active credential exclusion.
- [ ] Ensure failure reason remains deterministic when all credentials are expired/unauthorized.

### Files
- `api/src/repos/tokenCredentialRepository.ts`
- `api/tests/tokenCredentialRepository.test.ts`
- `api/src/routes/proxy.ts` (only if error mapping needs small adjustment)

### Exit Check
- [ ] `cd api && npm run build`
- [ ] `cd api && npm test`

## Workstream 2: Token Credential Admin API Surface
Owner: Agent 1
Consult: Agent 3
Priority: Done (keep as verification only)

### Tasks
- [x] Add minimal admin endpoints:
  - [x] `POST /v1/admin/token-credentials`
  - [x] `POST /v1/admin/token-credentials/rotate`
  - [x] `POST /v1/admin/token-credentials/:id/revoke`
- [x] Enforce idempotency on these mutation endpoints.
- [x] Use `runtime.services.tokenCredentials` so audit logging remains automatic.
- [x] Add request validation (`zod`) for required fields.
- [x] Lock endpoint error contract to existing API patterns:
  - [x] `invalid_request` (400) for validation/header issues
  - [x] `not_found` (404) for unknown credential id
  - [x] `idempotency_mismatch` (409) and replay behavior consistent with existing admin mutations
  - [x] `forbidden` (403) for scope/authz failures
- [ ] Verify docs and manual evidence for create -> rotate -> revoke flow in pilot env.

### Files
- `api/src/routes/admin.ts`
- `api/src/services/runtime.ts` (if wiring changes)
- `docs/API_CONTRACT.md`

### Exit Check
- [x] `cd api && npm run build`
- [x] `cd api && npm test`
- [ ] Manual: create -> rotate -> revoke sequence produces audit rows.

## Workstream 3: Token-Route Evidence + Proxy Shape Safety
Owner: Agent 2 + Agent 1
Priority: P1 (required for pilot signoff)

### Tasks
- [x] Keep default local smoke lightweight.
- [x] Add explicit required pilot command for real token-route evidence:
  - run smoke with `HEADROOM_SMOKE_REAL_PROXY=1` in pilot/staging environment.
- [x] Update runbook so pilot signoff requires proof of `x-headroom-token-credential-id` header.
- [ ] Lock C1 proxy request shape to safe default:
  - set proxy schema default `streaming=false` for token-mode compatibility.
  - keep token-mode streaming explicitly rejected for C1 (C1.5 scope).
- [ ] Add at least one route-level integration test covering token-mode branch behavior:
  - allowlisted org non-streaming success path
  - non-allowlisted org deterministic block path
- [ ] Add route-level integration test for terminal token-auth failure classification:
  - exhausted auth failures return deterministic `401 unauthorized` (not `capacity_unavailable`)
- [ ] Add route-level integration tests for new admin token endpoints:
  - create endpoint idempotent replay behavior
  - rotate endpoint idempotent replay behavior
  - revoke endpoint idempotent replay behavior

### Files
- `cli/scripts/smoke.sh`
- `cli/package.json`
- `docs/CLI_UX.md`
- `api/src/routes/proxy.ts`
- `api/tests/proxy.tokenMode.route.test.ts` (new)
- `api/tests/admin.tokenCredentials.route.test.ts` (new)

### Exit Check
- [ ] `cd cli && npm run test:smoke`
- [ ] Real proxy smoke (env-enabled) captures token-route evidence.
- [ ] `cd api && npm test` includes token-mode route-level coverage and new admin token endpoint route coverage.

## Pilot Evidence Bundle (Required)
Owner: Pilot Lead

Collect and store for go/no-go:
- [ ] request id
- [ ] upstream HTTP status
- [ ] token credential id header (`x-headroom-token-credential-id`)
- [ ] usage ledger row id
- [ ] token credential audit row id

Suggested command:
- [ ] `api/scripts/token_mode_manual_check.sh`

## Execution Order
1. Workstream 1 (expiry prefilter hardening)
2. Workstream 3 (real-route evidence + request-shape safety + route-level tests)
3. Workstream 2 verification (manual audit evidence for token credential lifecycle API)
4. Run evidence bundle and complete 4-user pilot gate

## Go Gate (C1 Token Pilot)
- [ ] Non-streaming token-mode request succeeds through proxy.
- [ ] Non-allowlisted org is blocked deterministically.
- [ ] Expired/near-expiry credential handling follows prefilter + refresh-window policy.
- [ ] Terminal token-auth failure classification is deterministic: exhausted auth failures return `401 unauthorized` (not `capacity_unavailable`).
- [ ] Token credential repository select/map mismatch is resolved.
- [ ] Token credential lifecycle can be operated via admin API (no manual DB edits required).
- [ ] Token-mode proxy branch has route-level integration test coverage.
- [ ] Pilot evidence bundle captured.

## Out of Scope (C1.5)
- Streaming token-mode validation.
- Provider-agnostic token adapter branching.
- Advanced automated refresh scheduling beyond current C1 path.
