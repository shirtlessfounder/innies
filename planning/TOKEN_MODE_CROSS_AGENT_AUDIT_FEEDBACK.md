# Token Mode Cross-Agent Audit Feedback (Consolidated)

Date: 2026-03-01
Scope: C1 token-mode MVP (Agent 1, Agent 2, Agent 3)
Intent: single, de-duplicated execution list

## Current Status
- Implemented:
  - Agent 1 token-mode routing branch, non-allowlist deterministic block, terminal `401 unauthorized` mapping, admin token credential endpoints.
  - Agent 1 route-level tests for proxy token-policy block + terminal auth failure + admin replay behavior.
  - Agent 3 token credential schema/migrations, lifecycle repo/service, env-template token settings.
  - Agent 2 CLI smoke improvements, token auth hints, optional real-smoke mode.
  - Manual DB-backed pilot evidence script exists: `api/scripts/token_mode_manual_check.sh`.
- Verified:
  - `api`: build + tests pass (`21/21`).
  - `cli`: smoke pass.

## Remaining Findings (Open)

### High
1. Token-mode request default remains failure-prone.
- Proxy schema defaults `streaming=true` while C1 token mode is non-streaming only.
- Omitted `streaming` can fail by default for token-mode callers.
- Refs:
  - `api/src/routes/proxy.ts:18`
  - `api/src/routes/proxy.ts:423`

2. Pre-expiry refresh window policy is still not implemented.
- Current runtime refreshes only after upstream `401/403`.
- C1 contract calls for refresh trigger before expiry window (5 minutes pre-expiry).
- Refs:
  - `api/src/routes/proxy.ts:193`
  - `api/src/routes/proxy.ts:247`
  - `planning/TOKEN_MODE_MILESTONE.md:20`

3. Credential can remain routable after refresh-then-auth-fail path.
- If refresh succeeds but subsequent auth still fails, credential is not marked non-routable in that path.
- Risk: repeated selection of a bad credential.
- Refs:
  - `api/src/routes/proxy.ts:248`
  - `api/src/routes/proxy.ts:257`

### Medium
1. Revoke endpoint error naming drifts from contract.
- Missing token credential returns `404` with `code='invalid_request'`.
- Should align to `not_found` semantics used elsewhere.
- Refs:
  - `api/src/routes/admin.ts:359`
  - `api/src/routes/sellerKeys.ts:107`

2. Route-level test coverage is still thin on C1 matrix behavior.
- Missing direct route tests for:
  - token success pass-through semantics,
  - pre-expiry refresh path,
  - `429`/`5xx` token failover matrix,
  - non-replay mutation execution paths on admin token endpoints.
- Refs:
  - `api/tests/proxy.tokenMode.route.test.ts:175`
  - `api/tests/admin.tokenCredentials.route.test.ts:172`

## Priority Order (Remaining Work)
1. Agent 1: set C1-safe proxy default to `streaming=false`.
2. Agent 1 + Agent 3: enforce pre-expiry refresh-window behavior before upstream call.
3. Agent 1 + Agent 3: mark credential non-routable on refresh-then-auth-fail terminal path.
4. Agent 1: align revoke missing-id error to `not_found` contract.
5. Agent 1: add route-level tests for token success + failover matrix + refresh path.
6. Agent 1: add admin token endpoint route tests for non-replay mutation path.

## Exit Gate (Remaining)
- [ ] Token-mode-safe default request shape is enforced for C1 callers.
- [ ] Pre-expiry refresh policy is enforced before token routing attempts.
- [ ] Refresh-then-auth-fail path makes credential non-routable.
- [ ] Revoke not-found error contract is aligned with API docs/plan.
- [ ] Route-level token-mode matrix coverage is sufficient for C1 confidence.
