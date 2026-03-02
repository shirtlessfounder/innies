# MVP Re-Audit Consolidation + Work Split

Date: 2026-03-01
Scope: Checkpoint 1 only (team-of-4 internal MVP)

## Consolidated Findings (MVP relevance)

### Critical
1. Proxy idempotency persistence contract mismatch can fail successful requests.
- Proxy uses `scope='proxy.v1'` and stores `response_body`, but DB constraint for `proxy.*` requires `response_body IS NULL`.
- Impact: likely 500 after upstream success when idempotency write occurs.
- Refs:
  - `api/src/routes/proxy.ts`
  - `migrations/001_checkpoint1_init_no_extensions.sql` (`hr_idempotency_keys` check)

2. Seller-key flows will fail without encryption key env.
- `SELLER_SECRET_ENC_KEY_B64` is required at runtime for encrypt/decrypt paths.
- Impact: seller-key create/read path fails in environments missing this env var.
- Refs:
  - `api/src/utils/crypto.ts`
  - `api/src/repos/sellerKeyRepository.ts`

### High
3. Missing C1 health-check + quarantine automation.
- Scope requires periodic synthetic checks, auto quarantine/cooldown/recovery.
- Current runtime retries/failover but does not automate key state transitions from health checks.
- Refs:
  - `TECHNICAL_SCOPE.md` health-check section
  - `api/src/jobs/*` (no key-health job)

4. Per-buyer cap enforcement missing.
- Scope requires per-buyer caps.
- Current path checks kill-switch/compat/queue, but no org spend/usage cap gate before upstream call.
- Refs:
  - `TECHNICAL_SCOPE.md` proxy + routing scope
  - `api/src/routes/proxy.ts`

### Medium
5. Admin audit logging for sensitive mutations is not wired.
- Scope requires admin audit log events.
- Admin/seller-key mutations currently do not persist `hr_audit_log_events`.
- Refs:
  - `TECHNICAL_SCOPE.md` team auth/controls
  - `api/src/routes/admin.ts`, `api/src/routes/sellerKeys.ts`

6. Non-JSON idempotent replay shape mismatch.
- First response may be raw text; replay path returns JSON object wrapper.
- Breaks “return original result” semantics.
- Refs:
  - `api/src/routes/proxy.ts`

7. Idempotency format contract not enforced.
- Scope says UUIDv7 or opaque token length >=32.
- Current implementation only validates header presence.
- Refs:
  - `TECHNICAL_SCOPE.md` idempotency contract
  - `api/src/routes/proxy.ts`, `api/src/routes/admin.ts`, `api/src/routes/sellerKeys.ts`

8. UI exists as shell pages but not runnable product package.
- Team cannot use dashboard/ops in C1 without app scaffold/scripts.
- Refs:
  - `ui/src/app/*`

### Acceptable C1 defer (explicit)
9. Reconciliation realism (provider pull) is still self-referential.
- Current expected=actual from internal ledger; not true provider drift detection.
- Acceptable for C1 only if explicitly marked temporary.

## Current Verification Snapshot
- `api`: `npm run build` passes.
- `api`: `npm test` passes.
- `cli`: smoke test previously reported passing.

---

## Work Split by Agent

## Agent 1 (Core API + Contracts)

### MVP Must Do
- [ ] Fix critical proxy idempotency/DB mismatch.
  - Keep `proxy.*` scope to satisfy privacy guard.
  - C1 explicit policy: metadata-only idempotency for proxy requests (`response_body=NULL`), replay returns deterministic `409` (`proxy_replay_not_supported`).
  - Do not introduce DB constraint changes for C1.
  - This is an explicit C1 override of the general “return original result” idempotency behavior for proxy paths.
- [ ] Add per-buyer cap gate before upstream call.
  - Enforce org-level cap only when cap is configured using a minimal, explicit source (`hr_orgs.spend_cap_minor` or equivalent).
  - If no cap is configured, pass through normally.
  - Return deterministic `capacity_unavailable`/`suspended` style error when exceeded.
- [ ] Add idempotency format validator and reuse across all mutation endpoints.
  - Validate UUIDv7 or opaque token length >= 32.
- [ ] Update `docs/API_CONTRACT.md` for final behavior.

### Files
- `api/src/routes/proxy.ts`
- `api/src/routes/admin.ts`
- `api/src/routes/sellerKeys.ts`
- `api/src/services/idempotencyService.ts`
- `docs/API_CONTRACT.md`

### Exit Check
- `npm run build`
- `npm test`
- Manual checks:
  - proxy request with `Idempotency-Key` on real DB completes with no `hr_idempotency_keys` constraint error
  - duplicate replay behavior
  - proxy idempotency rows for `proxy.*` contain metadata-only payloads (`response_body IS NULL`)

---

## Agent 2 (CLI + UX / UI Runtime)

### MVP Must Do
- [ ] Make `ui` runnable for team usage.
  - Add minimal app package scaffolding/scripts so dashboard shell can run.
  - Wire pages to existing mock or live adapters consistently.
- [ ] Keep CLI compatibility with proxy behavior changes.
  - Ensure no assumptions about wrapped proxy payloads.
- [ ] Update/confirm CLI smoke coverage for 2xx/4xx pass-through + idempotency expectations.

### Non-blocking for API C1 Exit
- [ ] UI runnable scaffold can land in parallel and should not block API C1 gate.

### Files
- `ui/*` (scaffold + scripts)
- `cli/src/commands/claude.js`
- `cli/scripts/smoke.sh`
- `docs/CLI_UX.md` (if behavior text changes)

### Exit Check
- `npm test` (cli package)
- UI local run command documented and verified
- CLI smoke passes against updated API

---

## Agent 3 (Data/Jobs/Observability)

### MVP Must Do
- [ ] Add minimal audit log persistence for admin/sensitive actions.
  - kill-switch
  - replay-metering
  - seller-key create/update
- [ ] Implement C1 health-check + quarantine automation job.
  - one periodic synthetic check
  - one deterministic failure threshold -> set status `quarantined`
  - manual recovery/unquarantine only for C1
  - no auto-recovery work unless trivial
- [ ] Support per-buyer cap computation/query path for Agent 1 gate.
  - add repo query for org recent usage/spend vs cap config

### C1.5 (defer allowed)
- [ ] provider-side reconciliation pull adapter (replace self-referential source)

### Files
- `api/src/repos/*` (audit + cap queries)
- `api/src/jobs/*` (health/quarantine job)
- `api/src/services/runtime.ts` (wire job/repo)

### Exit Check
- `npm run build`
- `npm test`
- Manual DB checks:
  - audit rows created for sensitive actions
  - key status changes under health-check failure simulation
  - verify `SELLER_SECRET_ENC_KEY_B64` is set in runtime env and seller-key create/read works

---

## Suggested Execution Order
1. Agent 1: fix critical idempotency mismatch first (hard blocker).
2. Agent 3: add audit logging + cap query + health/quarantine automation.
3. Agent 1: integrate cap gate + finalize proxy replay semantics.
4. Agent 2: UI runnable scaffold + CLI smoke alignment.
5. Final C1 smoke: CLI -> proxy -> DB ledgers/audit -> pool/usage views.

## C1 Done Criteria (Practical)
- No request-path DB constraint failures under normal idempotent proxy traffic.
- Proxy semantics compatible with client expectations (status/body fidelity).
- Team can run CLI and access a runnable dashboard shell.
- Sensitive admin actions are auditable.
- Health-check driven quarantine exists and is testable.
