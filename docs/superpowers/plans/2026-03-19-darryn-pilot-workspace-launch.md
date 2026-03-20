# Darryn Pilot Workspace Launch Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch the Darryn Phase 2 pilot as a sequence of Conductor-sized workspaces with explicit ownership, dependency gates, and copy-paste kickoff instructions.

**Architecture:** Use the workspace split defined in `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`. Land shared contracts first, then start backend domain work, then UI, then payments. Each workspace owns one seam and must not silently widen scope.

**Tech Stack:** TypeScript, Express, Next.js, Postgres SQL migrations, Vitest, Conductor workspaces

---

## Chunk 1: Wave 0 and Wave 1

### Task 1: Launch `darryn-phase2-foundation-contracts`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Likely modify: `docs/migrations/*`
- Likely modify: `api/src/repos/tableNames.ts`
- Likely create/modify: `api/src/repos/*`
- Likely create/modify: `api/src/types/*`
- Likely create/modify: `api/src/services/metering/*`
- Likely test: `api/tests/*`

- [ ] **Step 1: Start a workspace named `darryn-phase2-foundation-contracts`**

Use this prompt:

```text
Implement the Darryn Phase 2 foundation-contracts workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Scope:
- own only shared schema/contracts/types/projector-state work
- do not implement cutover business logic, routing policy, wallet behavior, earnings behavior, UI, or payments

Deliverables:
- migrations/schema for canonical metering event storage, projector-state storage, wallet ledger, earnings ledger, withdrawal requests, fnf ownership mapping, cutover_record, rollback_record
- shared enum/value contracts for finalization_kind, wallet_effect_type, earnings_effect_type, projector states
- shared repository/types/service seams for canonical metering persistence and ledger projection inputs
- FK/read contract for rate_card_version_id owned by routing later

Required constraints:
- canonical metering is event-shaped, with served_request plus later correction/reversal events
- projection state is per (metering_event_id, projector)
- do not add domain commands that belong to wallet or earnings

Before coding:
- write a short implementation plan in docs/superpowers/plans for this workspace
- then implement with tests

Definition of done:
- downstream workstreams can build without redefining shared money or attribution contracts
- tests/migrations pass for the new schema contracts
```

- [ ] **Step 2: Wait for a mergeable foundation PR**

Expected output:
- one PR/commit series containing only shared contracts and tests
- no domain behavior hidden inside the foundation branch

- [ ] **Step 3: Do not start later waves on top of ad hoc local assumptions**

Gate:
- downstream workspaces must read the landed foundation diff before implementation

### Task 2: Launch `darryn-phase2-cutover-access`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Likely modify: `api/src/routes/admin.ts`
- Likely modify: `api/src/middleware/auth.ts`
- Likely modify/create: auth/session services under `api/src/services/*`
- Likely test: `api/tests/*`

- [ ] **Step 1: Start this workspace after foundation contracts are landed**

Use this prompt:

```text
Implement the Darryn Phase 2 cutover-and-access workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Use the landed foundation-contracts branch/commit as your contract source. If it is not landed yet, stop.

Scope:
- fnf org creation/mapping
- buyer-key migration
- provider-credential ownership migration
- GitHub allowlist auth for Darryn
- admin impersonation/context-switch backend behavior
- cutover_record/rollback_record creation
- cutover freeze behavior before committed markers
- cutover completion handshake with routing reserve-floor migration
- cutover freeze behavior and rollback runbook

Do not implement:
- routing policy
- reserve-floor storage APIs
- wallet, earnings, UI, or payments

Important contract rules:
- no transient dual-home state for admitted traffic
- migration is fail-closed before committed cutover/rollback markers
- expose auth/session context for Darryn self, admin self, and admin impersonating Darryn
- cutover is not complete until routing's `migrateReserveFloors(from_owner, to_owner, cutover_id)` handshake succeeds

Before coding:
- write a workspace-local implementation plan
- verify the exact auth/session seams consumed by downstream UI/API work

Definition of done:
- existing buyer key resolves to fnf after cutover
- existing credentials belong to fnf without reconnect
- cutover/rollback behavior is explicit and tested
```

- [ ] **Step 2: Keep this workspace independent of wallet/earnings/UI**

Expected output:
- one backend/auth-focused PR with cutover tests and runbook updates

### Task 3: Launch `darryn-phase2-routing-metering`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Likely modify: `api/src/services/routingService.ts`
- Likely modify: `api/src/services/routerEngine.ts`
- Likely modify: `api/src/services/metering/usageMeteringWriter.ts`
- Likely create/modify: routing/metering repositories and rate-card storage under `api/src/*`
- Likely test: `api/tests/*`

- [ ] **Step 1: Start this workspace after foundation contracts are landed**

Use this prompt:

```text
Implement the Darryn Phase 2 routing-and-canonical-metering workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Use the landed foundation-contracts branch/commit as your contract source. If it is not landed yet, stop.

Scope:
- explicit routing modes: self-free, paid-team-capacity, team-overflow-on-contributor-capacity
- canonical metering event writes for every finalized pilot-mode request, including self-free
- correction/reversal event support
- admission-time classification persistence for replay/metering
- missing-metering detection/retry and operator correction intake for financially unfinalized requests
- request-history and routing-explanation backend APIs
- admin-managed rate-card tables/versioning and rate_card_version_id application
- reserve-floor storage/read-write APIs
- reserve-floor migration helper used by cutover
- lane isolation for innies claude vs innies codex
- model-agnostic provider preference behavior only where allowed

Do not implement:
- wallet ledger behavior
- earnings withdrawal behavior
- dashboard UI
- payment processor integration

Important dependency rule:
- full paid-team-capacity completion depends on the later wallet admission API; if wallet is not landed yet, implement the seam and mark that integration as the remaining follow-up

Before coding:
- write a workspace-local implementation plan
- explicitly define the request-history and reserve-floor APIs that downstream workspaces will consume

Definition of done:
- all finalized pilot-mode requests emit canonical metering
- rate-card version and derived debit/earnings amounts are persisted
- reserve-floor APIs exist and sold-capacity enforcement is fail-closed
```

- [ ] **Step 2: Coordinate only on shared contracts**

Expected output:
- one backend routing/metering PR that downstream wallet/earnings/UI work can consume

## Chunk 2: Wave 2, 3, and 4

### Task 4: Launch `darryn-phase2-wallet-admission`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Read: landed foundation and routing/metering diffs
- Likely create/modify: wallet repos/services/routes under `api/src/*`
- Likely modify: `api/src/routes/admin.ts`
- Likely test: `api/tests/*`

- [ ] **Step 1: Start this workspace after routing/metering contracts are landed**

Use this prompt:

```text
Implement the Darryn Phase 2 wallet-and-paid-admission workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Use the landed foundation and routing/metering commits as your contract sources. If they are not landed yet, stop.

Scope:
- wallet ledger
- balance computation
- manual wallet credits/debits with reason metadata
- paid admission API for paid-team-capacity
- serialized paid admission behavior
- negative-balance handling for already-admitted work
- wallet projector runner and retry/backlog handling
- operator visibility for wallet projection failures
- wallet-owned payment outcome recording seam for later payment integration
- optional wallet-owned `attemptAutoRecharge(wallet_id, trigger)` seam for later payment integration

Do not implement:
- payment processor calls
- payment-method storage/UI
- contributor earnings/withdrawals
- dashboard UI beyond backend APIs

Critical contracts:
- ensurePaidAdmissionEligible(wallet_id, trigger)
- attemptAutoRecharge(wallet_id, trigger)
- recordPaymentOutcome(wallet_id, processor_effect_id, effect_type)
- wallet is the single writer for wallet-ledger rows, including payment_credit

Before coding:
- write a workspace-local implementation plan
- make the routing integration seam explicit in tests

Definition of done:
- paid admissions fail clearly on insufficient balance
- finalized paid metering projects to wallet ledger rows
- manual credits/debits are first-class visible ledger entries
```

- [ ] **Step 2: Mark the routing integration status clearly**

Expected output:
- one wallet PR with tests
- explicit note whether routing integration landed in the same wave or is waiting on merge order

### Task 5: Launch `darryn-phase2-earnings-withdrawals`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Read: landed foundation and routing/metering diffs
- Likely create/modify: earnings/withdrawal repos/services/routes under `api/src/*`
- Likely modify: `api/src/routes/admin.ts`
- Likely test: `api/tests/*`

- [ ] **Step 1: Start this workspace after routing/metering contracts are landed**

Use this prompt:

```text
Implement the Darryn Phase 2 contributor-earnings-and-withdrawals workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Use the landed foundation and routing/metering commits as your contract sources. If they are not landed yet, stop.

Scope:
- earnings ledger projection from canonical metering
- derived availability buckets: pending, withdrawable, reserved_for_payout, settled, adjusted
- withdrawal request lifecycle: requested, under_review, approved, rejected, settlement_failed, settled
- withdrawal request commands/history
- payout settlement and settlement-failed flows
- earnings projector runner and retry/backlog handling
- operator visibility for stuck earnings projections

Do not implement:
- wallet logic
- payment processor logic
- dashboard UI beyond backend APIs

Pilot-specific rule:
- earnings arise only from team-overflow-on-contributor-capacity, so withdrawable promotion should not depend on wallet outcomes in this pilot

Before coding:
- write a workspace-local implementation plan
- make request-state history and admin settlement actions explicit in tests

Definition of done:
- overflow metering accrues visible earnings
- Darryn can request withdrawal only from withdrawable funds
- admin actions produce truthful ledger-backed outcomes
```

- [ ] **Step 2: Keep request lifecycle and balance buckets separate**

Expected output:
- one earnings/withdrawals PR with clear state-model tests

### Task 6: Launch `darryn-phase2-dashboard-surfaces`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Read: landed cutover, routing, wallet, and earnings API diffs
- Likely modify: `ui/src/app/*`
- Likely modify: `ui/src/components/*`
- Likely modify: `ui/src/lib/*`
- Likely test: `ui/tests/*` and any relevant API/UI tests

- [ ] **Step 1: Start this workspace only after backend API shapes are stable**

Use this prompt:

```text
Implement the Darryn Phase 2 dashboard-surfaces workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Use the landed cutover, routing/metering, wallet, and earnings API commits as your contract sources. If those APIs are still moving, stop.

Scope:
- Darryn dashboard views for wallet, request history, routing attribution, connected account status, reserve floors, earnings, and withdrawals
- admin account-view pages and impersonation-entry UI
- reserve-floor controls against backend reserve-floor APIs
- manual-funding visibility using backend wallet-ledger APIs

Do not implement:
- pricing logic
- routing logic
- ledger math
- payment-method or auto-recharge UI until the payments workstream lands

Before coding:
- write a workspace-local implementation plan
- map each page to one existing backend contract instead of inventing adapters

Definition of done:
- Darryn and admins can understand free vs paid vs earnings outcomes from the dashboard alone
- Claude and Codex `5h` / `1w` reserve-floor controls work end to end
- manual top-ups become visible immediately in wallet history
- withdrawal history works end to end
```

- [ ] **Step 2: Treat payment controls as out of scope until payments lands**

Expected output:
- one UI-focused PR built strictly on stable backend APIs

### Task 7: Launch `darryn-phase2-payments-recharge`

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Read: landed wallet API diffs
- Likely create/modify: payment routes/services/webhooks under `api/src/*`
- Likely modify: wallet integration seams under `api/src/*`
- Likely modify: `ui/src/app/*` and `ui/src/components/*`
- Likely test: `api/tests/*` and `ui/tests/*`

- [ ] **Step 1: Start this workspace only after wallet APIs are landed**

Use this prompt:

```text
Implement the Darryn Phase 2 card-payments-and-auto-recharge workstream from docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md.

Use the landed wallet-admission commit as your contract source. If wallet is not landed yet, stop.

Scope:
- payment processor integration
- stored payment method
- top-up flow
- webhook normalization
- auto-recharge settings and attempts
- dashboard payment-method and auto-recharge controls
- normalized payment outcomes recorded through the wallet-owned payment outcome interface
- refund/chargeback reversals
- payment-method removal disabling future auto-recharge

Do not implement:
- ad hoc wallet-ledger writes outside wallet-owned recording APIs
- routing logic
- earnings logic

Critical contracts:
- attemptAutoRecharge(wallet_id, trigger)
- trigger values: admission_blocked, post_finalization_negative
- result values: not_configured, charge_succeeded(processor_effect_id), charge_failed(processor_effect_id | null), charge_pending(payment_attempt_id)
- payment-backed credits must be idempotent on (processor_effect_id, wallet_effect_type)

Before coding:
- write a workspace-local implementation plan
- make the single-writer wallet-ledger rule explicit in tests
- make failed-payment no-balance-change behavior and serialized/visible recharge attempts explicit in tests

Definition of done:
- live funding and auto-recharge work without double-crediting
- failed payments do not change wallet balance
- refund/chargeback reversals are explicit and correct
- recharge attempts are serialized and visible
- wallet pause/clear behavior matches the payment outcome contract
- removing a payment method disables future auto-recharge cleanly
- dashboard payment controls reflect stored processor state truthfully
```

- [ ] **Step 2: Verify wallet idempotency before claiming done**

Expected output:
- one payments PR that proves no duplicate credits from retries or late webhooks

## Chunk 3: Coordinator Rules

### Task 8: Keep the merge order strict

**Files:**
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Read: this plan

- [ ] **Step 1: Merge in this order**

1. `darryn-phase2-foundation-contracts`
2. `darryn-phase2-cutover-access` and `darryn-phase2-routing-metering`
3. `darryn-phase2-wallet-admission` and `darryn-phase2-earnings-withdrawals`
4. `darryn-phase2-dashboard-surfaces`
5. `darryn-phase2-payments-recharge`

- [ ] **Step 2: Block downstream work if contracts move**

Rule:
- if a producer workspace changes an owned API/schema after a consumer workspace started, rebase the consumer only after the producer contract lands

- [ ] **Step 3: Require each workspace to show verification**

Expected verification:
- focused tests for the owned seam
- no claims of completion without command output

### Task 9: Use the split spec as the source of truth

**Files:**
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`

- [ ] **Step 1: Include the split spec path in every workspace prompt**

Reason:
- keeps ownership boundaries and dependency rules stable

- [ ] **Step 2: Reject scope creep**

Examples:
- dashboard workspace must not invent pricing math
- payments workspace must not bypass wallet-owned ledger writes
- cutover workspace must not implement reserve-floor storage itself
