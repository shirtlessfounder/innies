# Token Mode Milestone (Checkpoint 1 Critical Path)

Date: 2026-03-01
Scope: internal team-of-4 pilot path for gateway/OAuth token sharing
Status: required before C1 GO

## Goal
Validate the core thesis path end-to-end using token-mode credentials (not static key-only assumptions).

## Upstream Token Protocol (C1 locked profile)
- C1 provider profile: Anthropic-compatible upstream.
- Auth header mapping is deterministic from credential `auth_scheme`:
  - `x_api_key` => `x-api-key: <access_token>`
  - `bearer` => `Authorization: Bearer <access_token>`
- C1 default for Anthropic profile: `auth_scheme = x_api_key`.
- Upstream base URL: `ANTHROPIC_UPSTREAM_BASE_URL` (default `https://api.anthropic.com`).
- Endpoint mapping:
  - proxy non-streaming/streaming requests map to provider endpoint path passed through `/v1/proxy/*`.
  - streaming validation is optional C1.5; non-streaming is required for C1 exit.
- Refresh trigger rule:
  - attempt refresh starting 5 minutes before `expires_at`.
  - if refresh fails, credential transitions to `expired` and is non-routable.
- Required execution fields:
  - `provider`, `org_id`, encrypted `access_token`, encrypted `refresh_token` (if issued), `expires_at`, `status`, `rotation_version`.
- This profile is fixed for C1; no provider branching until C1 exit.

## Migration + Rollout (required)
- [ ] Add migration file(s) for token credential schema changes before runtime changes are deployed.
- [ ] Deploy order:
  - [ ] apply DB migration
  - [ ] deploy API code with backward-compatible reads
  - [ ] enable token-mode write path
  - [ ] enable token-mode routing path
- [ ] Backward-compat window:
  - [ ] keep legacy key path available until token-mode E2E is verified in production-like env.
- [ ] Rollback plan:
  - [ ] disable token-mode routing flag
  - [ ] keep admin ops available
  - [ ] revert to last known-good auth path

## Success Criteria (GO/NO-GO)
- [ ] A token credential can be created, encrypted, stored, retrieved, and rotated.
- [ ] Proxy can route real non-streaming token-mode traffic successfully to upstream provider.
- [ ] Non-streaming token-mode requests work with retry/failover/queue behavior (C1).
- [ ] Metering and spend-cap checks are accurate on token-mode traffic.
- [ ] 4 internal users can run daily workflows on token mode for >= 7 days without blocker incidents.

If any box is unchecked: NO-GO for C1 launch.

---

## Workstream A: Credential Model + Storage
Owner: Agent 3

### Token Lifecycle Contract (required)
- [ ] Required fields per credential record:
  - [ ] `provider`
  - [ ] `org_id`
  - [ ] `auth_scheme` (`x_api_key` | `bearer`)
  - [ ] encrypted `access_token`
  - [ ] encrypted `refresh_token` (nullable only if provider flow does not issue refresh tokens)
  - [ ] `expires_at`
  - [ ] `status` (`active`, `rotating`, `expired`, `revoked`)
  - [ ] `rotation_version` and timestamps (`created_at`, `updated_at`, `rotated_at`)
- [ ] Refresh behavior:
  - [ ] refresh attempt begins before expiry (default: 5 minutes pre-expiry).
  - [ ] on refresh failure, keep deterministic status transition and error visibility.
- [ ] Rotation behavior:
  - [ ] only one active credential per (`org_id`, `provider`) at a time.
  - [ ] prior credential transitions to non-active terminal/archived state.
- [ ] Deterministic selection rule:
  - [ ] proxy always selects newest `active` credential by `rotation_version` then `updated_at`.
  - [ ] any credential in `rotating`/`expired`/`revoked` state is never selected for routing.
- [ ] Required DB invariants:
  - [ ] unique active credential per (`org_id`, `provider`).
  - [ ] monotonic `rotation_version` per (`org_id`, `provider`).
  - [ ] status transition guard rejects invalid transitions.

### Deliverables
- [ ] Add token credential table/model (provider, org, encrypted token payload, expiry metadata, rotation metadata).
- [ ] Add repo methods for create/read/update/rotate token credentials.
- [ ] Ensure encryption at rest using existing keying path (`SELLER_SECRET_ENC_KEY_B64` or equivalent token-specific envelope).
- [ ] Add audit log writes for token create/rotate/revoke actions.

### Acceptance Tests
- [ ] DB row contents are non-plaintext for token fields.
- [ ] Decrypt path works in request runtime.
- [ ] Rotation marks prior credential state and activates new one deterministically.

---

## Workstream B: Upstream Token Adapter
Owner: Agent 1

### Deliverables
- [ ] Implement provider adapter path that uses stored token credential for upstream auth.
- [ ] Add token-expired/unauthorized handling and failover behavior.
- [ ] Maintain proxy semantics already decided for C1 (status/body fidelity and idempotency policy).
  - [ ] Explicitly inherit C1 proxy idempotency: metadata-only persistence for `proxy.*` and deterministic non-replayable `409` contract.
- [ ] Non-streaming token-mode path is required for C1 pilot; streaming token-mode is optional and tracked separately.
- [ ] Implement fixed token-mode retry/failover matrix:
  - [ ] `401/403`: refresh once; if still failing, fail over to next eligible credential; if none, hard-fail.
  - [ ] `429`: backoff + failover.
  - [ ] `5xx`/network timeout: failover.
  - [ ] non-key-specific model/permission invalid: hard-fail (no failover loop).

### Acceptance Tests
- [ ] Real upstream non-streaming request succeeds using token-mode credential.
- [ ] Expired/invalid token yields deterministic error + telemetry.
- [ ] Retry/failover behavior remains correct under token auth failures.

---

## Workstream C: CLI + Onboarding Flow
Owner: Agent 2

### Deliverables
- [ ] Add operator/user flow docs for token-mode setup.
- [ ] Update CLI smoke/integration checks to cover token-mode route assumptions.
- [ ] Keep existing recursion-safe launcher and doctor behavior.

### Acceptance Tests
- [ ] Team can follow one runbook and reach successful token-mode request.
- [ ] CLI diagnostics clearly surface token-mode auth failures.
- [ ] `headroom claude` path is proven to hit token-mode route (not legacy key path), with recorded request evidence.

---

## Workstream D: Metering + Cap Validation on Token Mode
Owner: Agent 3 (with Agent 1 integration)

### Deliverables
- [ ] Confirm usage writes and cap gates trigger from token-mode requests.
- [ ] Add reconciliation note/flag for token-mode pilot traffic.

### Acceptance Tests
- [ ] Usage ledger rows created for token-mode success paths.
- [ ] Spend-cap enforcement blocks token-mode calls when threshold reached.
- [ ] Metering drift sample check within MVP tolerance for pilot runs:
  - [ ] daily drift <= 2% during pilot window.

---

## End-to-End Pilot Gate (4 users)
Owner: Pilot Lead (you)
Support: Agent 1/2/3

### Pilot Plan
- [ ] Seed 4 internal user accounts with token-mode-enabled org setup.
- [ ] Run fixed daily workflow suite through token-mode proxy path.
- [ ] Track failures by class: auth, routing, queue, metering, cap, replay.
- [ ] Define denominator before pilot starts:
  - [ ] minimum 50 routed requests/day across the 4 users OR scripted suite completion
  - [ ] fixed workflow suite with at least 3 representative tasks/user/day

### Pilot Exit Metrics
- [ ] >= 95% successful request completion over the 7-day pilot window on the defined denominator.
- [ ] No unresolved Sev1/Sev2 incidents on token path.
- [ ] No silent metering failures.
- [ ] Daily metering drift <= 2%.
- [ ] Team confirms usability of token setup + daily flow.

---

## Verification Commands (minimum)
- [ ] `cd api && npm run build`
- [ ] `cd api && npm test`
- [ ] `cd cli && npm run test:smoke`
- [ ] DB-backed manual token test script run (to be added in this milestone)
- [ ] Runtime/env gates:
  - [ ] `DATABASE_URL` present and reachable.
  - [ ] `SELLER_SECRET_ENC_KEY_B64` present and valid length.
  - [ ] token-mode feature flag/config enabled for pilot orgs:
    - [ ] canonical config: `TOKEN_MODE_ENABLED_ORGS` (org allowlist)
    - [ ] enforcement point: proxy route pre-routing guard
    - [ ] owner: Agent 1 (proxy enforcement) + Pilot Lead (config values + rollout sequence)
- [ ] One real token-mode E2E evidence capture:
  - [ ] request id
  - [ ] upstream success status
  - [ ] usage ledger row id
  - [ ] audit log row id for token credential action
- [ ] DB verification checks (examples):
  - [ ] verify token rows are encrypted-at-rest (no plaintext token strings in DB values).
  - [ ] verify one active credential per (`org_id`, `provider`).
  - [ ] verify status transitions for rotate/expire/revoke.

---

## Emergency Fallback (required)
- [ ] One-step token-mode disable switch documented and tested.
- [ ] If token-mode incident occurs:
  - [ ] disable token-mode routing
  - [ ] route via mandatory legacy/static-key fallback path during pilot window
  - [ ] log incident + decision record
  - [ ] restore only after postmortem action items are complete

---

## Risks / Open Questions
- Provider token-sharing terms and allowed auth patterns may constrain implementation details.
- OAuth refresh-token flow may require provider-specific state and refresh scheduling.
- If token mode requires different compatibility routing, update matrix rules explicitly.

## Provider Policy Gate
Owner: Founder/CEO + legal reviewer
- [ ] Record go/no-go decision for token-sharing approach before pilot start.
- [ ] Decision date recorded in launch notes.

## Immediate Next Step
Implement Workstream A and B first, then run a single real token-mode request through proxy and record evidence before broader pilot start.
