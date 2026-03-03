# Token Mode Agent Work Split (C1)

Date: 2026-03-01  
Source of truth: `planning/TOKEN_MODE_MILESTONE.md`  
Scope: Checkpoint 1 only (internal team-of-4, non-streaming required)

## Ownership Baseline
- Agent 1: Core API request path, routing behavior, proxy contracts.
- Agent 2: CLI UX, onboarding/runbooks, smoke/integration flow.
- Agent 3: Data model/migrations, repos, security/encryption, metering integrity.

## Agent 1 - Proxy + Routing (Token Adapter)

### Must ship (C1)
- [ ] Add token-mode routing path in proxy using stored credential for upstream auth.
- [ ] Enforce org allowlist guard (`TOKEN_MODE_ENABLED_ORGS`) pre-routing.
- [ ] Implement deterministic `auth_scheme` mapping in adapter:
  - [ ] `x_api_key` -> `x-api-key: <access_token>`
  - [ ] `bearer` -> `Authorization: Bearer <access_token>`
- [ ] Implement fixed retry/failover matrix:
  - [ ] `401/403`: refresh once, then failover, else hard-fail.
  - [ ] `429`: backoff + failover.
  - [ ] `5xx`/network timeout: failover.
  - [ ] model-invalid/permission-invalid: hard-fail.
- [ ] Keep C1 proxy behavior unchanged:
  - [ ] upstream status/body fidelity
  - [ ] metadata-only idempotency for `proxy.*`
  - [ ] deterministic replay `409` for proxy scopes
- [ ] Non-streaming token-mode path fully working; streaming may remain C1.5.

### Handoff artifacts
- [ ] Updated `api/src/routes/proxy.ts` and token adapter/service files.
- [ ] One E2E proof request id (token-mode success) with upstream status.
- [ ] Short note in `docs/API_CONTRACT.md` for token-mode auth + failure semantics.

### Exit checks
- [ ] `cd api && npm run build`
- [ ] `cd api && npm test`
- [ ] Manual: token-enabled org succeeds; non-allowlisted org blocked deterministically.

## Agent 2 - CLI + Team Onboarding

### Must ship (C1)
- [x] Update CLI path (`headroom claude`) to operate cleanly on token-mode route.
- [x] Ensure CLI errors are clear for token auth failures (expired/unauthorized/not-enabled).
- [x] Add team runbook for token-mode onboarding and daily use.
- [x] Update smoke test flow to assert token-mode route usage (not legacy static-key path).

### Handoff artifacts
- [x] `docs/CLI_UX.md` token-mode section with exact commands.
- [x] Smoke script output snippet showing token-mode success and one failure case.
- [x] Pilot checklist snippet for 4 users (what to run each day).

### Exit checks
- [x] `cd cli && npm run test:smoke`
- [ ] Manual: fresh teammate follows runbook and gets one successful request.

## Agent 3 - Schema + Credential Lifecycle + Metering

### Must ship (C1)
- [ ] Add token credential migration/table with required fields:
  - [ ] `provider`, `org_id`, `auth_scheme`, encrypted `access_token`, encrypted `refresh_token`, `expires_at`, `status`, `rotation_version`, timestamps
- [ ] Enforce DB invariants:
  - [ ] one active credential per (`org_id`, `provider`)
  - [ ] monotonic `rotation_version` per (`org_id`, `provider`)
  - [ ] status transition guard
- [ ] Add repo methods: create/read/select-active/rotate/revoke/mark-expired.
- [ ] Keep encryption-at-rest via existing key path (`SELLER_SECRET_ENC_KEY_B64`).
- [ ] Wire audit-log events for token create/rotate/revoke.
- [ ] Confirm usage ledger + spend-cap gates still fire for token-mode requests.

### Handoff artifacts
- [ ] Migration SQL file(s) + rollback notes.
- [ ] Repo/service API notes for Agent 1 integration.
- [ ] DB verification query set:
  - [ ] encrypted-at-rest check
  - [ ] one-active-per-org/provider check
  - [ ] rotation/status transition check

### Exit checks
- [ ] `cd api && npm run build`
- [ ] `cd api && npm test`
- [ ] Manual DB checks pass for invariants and encrypted storage.

## Parallelization Plan

### Phase 1 (parallel)
- Agent 3: migrations + repo primitives + invariants.
- Agent 2: CLI/runbook updates that do not require final API merge.

### Phase 2
- Agent 1: integrate token adapter/routing on top of Agent 3 repo contracts.

### Phase 3 (parallel)
- Agent 1 + Agent 2: end-to-end CLI against token-mode route, tighten errors/docs.

## Merge Order
1. Agent 3 (schema/repo primitives)
2. Agent 1 (proxy/routing integration)
3. Agent 2 (final CLI/runbook polish on merged API behavior)

## C1 Go Gate (all required)
- [ ] Real non-streaming token-mode request succeeds through proxy.
- [ ] Retry/failover behavior matches matrix.
- [ ] Usage + cap behavior correct on token-mode traffic.
- [ ] 4-user pilot runbook usable.
- [ ] Feature flag/allowlist owner has configured pilot orgs.
