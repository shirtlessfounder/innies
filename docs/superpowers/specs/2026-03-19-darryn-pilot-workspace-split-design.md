# Darryn Pilot Workspace Split Design

## Goal

Split the Darryn Phase 2 pilot into Conductor-sized workstreams that can run mostly independently while preserving one shared contract for org cutover, routing attribution, wallet charging, and contributor earnings.

## Context

The requested pilot in `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md` is too broad for one implementation stream. It combines:

- org/account migration
- auth and dashboard access
- routing behavior changes
- request-level metering and accounting
- buyer wallet funding and paid admission
- contributor earnings and withdrawals
- buyer/admin product surfaces
- live card payments and auto-recharge

The current codebase already has real seams in:

- admin/auth surfaces in `api/src/routes/admin.ts`
- routing in `api/src/services/routingService.ts`
- usage metering in `api/src/services/metering/usageMeteringWriter.ts`
- a still-thin web surface under `ui/src/app`

That supports a contract-first split better than a single vertical implementation.

## Decision

Use a hybrid contract-first split:

1. Land one narrow foundation workstream first.
2. Start the domain workstreams against that foundation contract.
3. Leave card payments and auto-recharge to a second wave after wallet-ledger fundamentals exist.

This is preferred over:

- one large vertical pilot, which would create too much merge pressure
- pure domain parallelization, which would make multiple workspaces invent the same contracts independently

## Planning Granularity

This document is a program-split spec, not one umbrella implementation plan.

Required planning output:

- one implementation plan per workstream
- no single umbrella build plan that tries to execute all seven workstreams in one session
- only the foundation-contracts workstream should be planned first
- later workstream plans should reference this spec plus the landed foundation contract

## Non-Goals

- planning general Friends & Family self-serve onboarding
- permissionless org creation
- combining live payments into the same first-wave wallet build
- defining exact UI copy or polish beyond the surfaces needed for the pilot

## Shared Contract

All implementation workstreams must treat the following as shared invariants:

### Org Boundary

- `innies` remains the internal team org.
- `fnf` becomes the Darryn product/accounting org.
- Darryn's existing buyer key and connected provider credentials move to `fnf`.
- Historical `innies` usage remains historical only and does not backfill into Phase 2 wallet or earnings views.
- Darryn-facing request history is post-cutover only; pre-cutover request history remains available only through existing internal/admin historical tools.

### Cutover Boundary

- The authoritative cutover marker is one committed cutover record containing:
  - `cutover_id`
  - `effective_at`
  - buyer-key ownership swap completion
  - provider-credential ownership swap completion
- The authoritative rollback marker is one committed rollback record containing:
  - `rollback_id`
  - `effective_at`
  - reverted buyer-key ownership target
  - reverted provider-credential ownership target
- Request and session classification is based on admission-time org resolution, not finalization time.
- Requests admitted before `effective_at` remain historical `innies` traffic even if they finalize after cutover.
- Requests admitted at or after `effective_at` are `fnf` traffic even if they finalize during the cutover window.
- A rollback creates a new rollback marker for future admissions only; it does not reclassify already-admitted requests or rewrite canonical metering history.
- While buyer-key and credential migration is in progress before a cutover or rollback record is committed, new admissions on the migrating buyer key and newly sold admissions on the migrating credentials are fail-closed.
- There is no transient dual-home state for admitted traffic: admissions either happen fully before the committed marker or fully after it.
- Foundation owns the `cutover_record` schema and shared read contract only.
- Foundation owns the `rollback_record` schema and shared read contract only.
- Cutover and access owns creation of `cutover_record` and `rollback_record` rows.
- Routing and canonical metering owns persisting the admission-time classification inputs carried forward into replay and metering:
  - `admission_org_id`
  - `admission_cutover_id`
  - `admission_routing_mode`

Cutover-to-routing reserve-floor handshake:

1. Routing exposes reserve-floor storage plus `migrateReserveFloors(from_owner, to_owner, cutover_id)`.
2. Cutover enters the migration freeze described above.
3. Cutover completes buyer-key and credential ownership migration, then invokes the routing reserve-floor migration helper.
4. Cutover commits `cutover_record` only after reserve-floor migration succeeds.
5. Routing admits post-cutover traffic only after the committed `cutover_record` is visible.

### Routing Modes

Only these financially relevant modes are valid:

- `self-free`
- `paid-team-capacity`
- `team-overflow-on-contributor-capacity`

No workspace should introduce implicit shared-pool behavior outside those modes.

`pilot-mode request` means any finalized request admitted under one of those three modes:

- Darryn self-use in `fnf`
- Darryn paid fallback onto `innies` team capacity
- `innies` internal/team traffic overflowing onto Darryn-contributed capacity

### Canonical Metering Fact

Every finalized pilot-mode request, including `self-free`, must emit one initial canonical metering event with `finalization_kind = served_request`.
Later corrections or reversals emit additional canonical metering events that reference the original event.

Every canonical metering event must persist:

- `metering_event_id`
- `request_id`
- `attempt_no`
- `finalization_kind`
- `source_metering_event_id` when `finalization_kind` is `correction` or `reversal`
- idempotency key derived from `(request_id, attempt_no, finalization_kind)`
- `rate_card_version_id`
- metered quantity fields required for pricing and replay:
  - `input_tokens`
  - `output_tokens`
  - `usage_units`
- consumer org/user identity
- serving org/capacity owner identity
- serving credential
- provider/model
- routing mode
- buyer debit amount, if any
- contributor earnings amount, if any

For `self-free`, the initial `served_request` metering event still exists, but carries zero buyer debit and zero contributor earnings.

Wallet, earnings, dashboards, and support views must all reconcile to that fact instead of deriving money independently.

Allowed idempotency and effect values:

- `finalization_kind`
  - `served_request`
  - `correction`
  - `reversal`
- `wallet_effect_type`
  - `buyer_debit`
  - `buyer_correction`
  - `buyer_reversal`
  - `manual_credit`
  - `manual_debit`
  - `payment_credit`
  - `payment_reversal`
- `earnings_effect_type`
  - `contributor_accrual`
  - `contributor_correction`
  - `contributor_reversal`
  - `withdrawal_reserve`
  - `withdrawal_release`
  - `payout_settlement`
  - `payout_adjustment`

### Contracted Write Path

The split assumes the following minimum contract:

1. Routing finalization writes one canonical metering event synchronously when any finalized pilot-mode request completes.
2. Wallet and earnings ledgers derive their entries from committed metering events, not directly from live routing output.
3. Ledger derivation is asynchronous but idempotent:
   - wallet projection is unique on `(metering_event_id, wallet_effect_type)`
   - earnings projection is unique on `(metering_event_id, earnings_effect_type)`
4. Manual wallet adjustments and payout actions bypass metering, but still write explicit ledger rows with actor and reason metadata.
5. Dashboard reads may join metering plus ledger tables, but must never re-run pricing or earnings math from raw request logs.

### Replay And Correction Rules

- Duplicate request finalization must not create duplicate money movement. The canonical metering insert is idempotent on `(request_id, attempt_no, finalization_kind)`.
- Late corrections and reversals create new canonical metering events referencing `source_metering_event_id`; they do not mutate the original event.
- If metering persistence succeeds but a downstream ledger projector fails, the system keeps the metering event as source of truth and retries projection until the wallet and earnings views reconcile.
- Partial failures between routing completion and metering persistence fail closed for financial visibility: the request is treated as operationally served but financially unfinalized until metering is recorded or an explicit operator correction is posted.

Correction and projection semantics:

- `served_request`
  - carries the finalized absolute metered quantities and derived debit/earnings amounts for that request
  - projects to:
    - `buyer_debit` when buyer amount is non-zero
    - `contributor_accrual` when earnings amount is non-zero
- `correction`
  - carries signed deltas relative to `source_metering_event_id`, not a full recomputed replacement row
  - projects to:
    - `buyer_correction` when buyer delta is non-zero
    - `contributor_correction` when earnings delta is non-zero
- `reversal`
  - carries the explicit negation of the referenced source event's financial effects
  - projects to:
    - `buyer_reversal` when the source event created a buyer ledger effect
    - `contributor_reversal` when the source event created an earnings ledger effect
- `self-free` rows may still create canonical metering events, but they project no wallet or earnings ledger effects unless later correction logic explicitly introduces a non-zero delta.

### Funding And Auto-Recharge Seam

- Workstream 4 owns the wallet admission contract and wallet-side allow/deny decision.
- Workstream 7 owns payment-method storage, processor integration, and the concrete auto-recharge adapter.
- Until Workstream 7 lands, the wallet treats auto-recharge as unavailable and admits paid work only on positive balance.
- After Workstream 7 lands, the wallet service may call the payments adapter before admission or after negative finalization, but the wallet service still owns admission and pause behavior.

Wallet-to-payments adapter contract:

- `attemptAutoRecharge(wallet_id, trigger)` accepts:
  - `wallet_id`
  - `trigger` in:
    - `admission_blocked`
    - `post_finalization_negative`
- and returns one of:
  - `not_configured`
  - `charge_succeeded(processor_effect_id)`
  - `charge_failed(processor_effect_id | null)`
  - `charge_pending(payment_attempt_id)`
- admission-time behavior:
  - only `charge_succeeded` allows the blocked admission to continue
  - `not_configured`, `charge_failed`, and `charge_pending` all fail the current paid admission clearly
- post-finalization negative-balance behavior:
  - `charge_succeeded` means Wallet records a `payment_credit` row from the returned `processor_effect_id` and may clear the pause
  - `charge_failed` and `not_configured` leave the wallet negative and paused
  - `charge_pending` leaves the wallet paused until webhook reconciliation posts a payment credit
- Payment-backed wallet credits are idempotent on `(processor_effect_id, wallet_effect_type)`.
- Wallet owns all wallet-ledger writes, including `payment_credit` rows.
- Payments owns processor calls, payment-attempt state, and webhook normalization, then invokes Wallet-owned payment-outcome recording with the normalized `processor_effect_id`.

### Withdrawal Request Lifecycle

Withdrawal requests are distinct from earnings balance buckets.

Allowed request states:

- `requested`
- `under_review`
- `approved`
- `rejected`
- `settlement_failed`
- `settled`

Legal transitions:

- `requested` -> `under_review`
- `under_review` -> `approved`
- `under_review` -> `rejected`
- `approved` -> `settled`
- `approved` -> `settlement_failed`
- `settlement_failed` -> `approved`
- `settlement_failed` -> `rejected`

### Projection And Reconciliation Ownership

- Foundation owns projector-state tables, shared retry metadata, and shared types only.
- Routing and canonical metering owns missing-metering detection, metering-write retry, and operator correction intake for unfinalized requests.
- Wallet and paid admission owns the wallet projector runner, stuck-wallet-projection retry, and operator visibility for wallet projection failures.
- Contributor earnings and withdrawals owns the earnings projector runner, stuck-earnings-projection retry, and operator visibility for earnings projection failures.
- Dashboard surfaces may display projection health but do not own retry or reconciliation logic.

Projector-state granularity:

- projection state is tracked per `(metering_event_id, projector)`
- allowed `projector` values are:
  - `wallet`
  - `earnings`
- each projector row independently transitions through:
  - `pending_projection`
  - `projected`
  - `needs_operator_correction`

### Ledger Rules

- Buyer balance comes from an append-only wallet ledger.
- Contributor balances come from an explicit earnings ledger.
- Adjustments, reversals, and payout-state changes are explicit ledger entries.
- Manual admin actions are ledger-backed with required reason metadata.

### Earnings Availability Model

Contributor earnings availability is derived from the append-only earnings ledger.

These are balance buckets, not mutable row states:

- `pending`
- `withdrawable`
- `reserved_for_payout`
- `settled`
- `adjusted`

Withdrawal requests are separate entities with their own request lifecycle defined above.

Availability transitions:

- new contributor accruals start in `pending`
- in this pilot, contributor earnings arise only from `team-overflow-on-contributor-capacity`
- because that mode has no buyer-wallet debit, `pending` becomes `withdrawable` once the finalized metering event is posted and the earnings projection succeeds
- creating a withdrawal request moves the requested amount from `withdrawable` to `reserved_for_payout`
- successful payout settlement moves funds from `reserved_for_payout` to `settled`
- rejected or failed settlement returns reserved funds to `withdrawable` unless an explicit adjustment entry says otherwise
- `adjusted` is a derived bucket from explicit adjustment and reversal ledger entries

### Critical Seams

Cross-workstream seams that must stay stable:

- Cutover -> Routing
  - `migrateReserveFloors(from_owner, to_owner, cutover_id)`
  - Cutover commits `cutover_record` only after this succeeds
- Routing -> Wallet
  - `ensurePaidAdmissionEligible(wallet_id, trigger)` for `paid-team-capacity`
- Payments -> Wallet
  - `recordPaymentOutcome(wallet_id, processor_effect_id, effect_type)` with wallet-owned idempotent ledger recording

### Routing Constraints That Survive The Split

- `innies claude` remains in the Claude lane only.
- `innies codex` remains in the Codex/OpenAI lane only.
- Provider preference applies only to OpenClaw and other model-agnostic traffic.
- Reserve-floor enforcement is fail-closed for newly sold contributor work.
- The dashboard split must still include reserve-floor controls, not just reserve-floor visibility.

## Workstreams

### 1. Foundation Contracts

**Purpose:** Define the DB and service seams that all other workstreams consume.

**Owned interfaces:**

- owns canonical table shapes, primary keys, idempotency keys, and projector-state storage
- owns shared types for canonical metering and ledger projection inputs
- owns the allowed enum/value sets for `finalization_kind`, `wallet_effect_type`, and `earnings_effect_type`
- owns the shared per-projector financial-finalization state model for `(metering_event_id, projector)` rows:
  - `pending_projection`
  - `projected`
  - `needs_operator_correction`
- defines `fnf` ownership schema and foreign-key contracts only
- defines `cutover_record` schema and foreign-key/read contracts only
- defines `rollback_record` schema and foreign-key/read contracts only
- does not own live org creation, migration execution, routing decisions, wallet business rules, earnings business rules, or dashboard rendering

**Primary ownership:**

- canonical metering event shape
- canonical metering idempotency and correction rules
- wallet-ledger entity shape
- earnings-ledger entity shape
- withdrawal-request entity shape
- read/write service interfaces used by downstream workstreams
- org/account ownership contract for `fnf`
- `cutover_record` schema/read contract
- `rollback_record` schema/read contract
- foreign-key contract to rate-card versions owned elsewhere

**Likely files:**

- `docs/migrations/*`
- `api/src/repos/tableNames.ts`
- new repositories and types under `api/src/repos` and `api/src/types`
- `api/src/services/metering/*`

**Definition of done:**

- schema lands for wallet, earnings, withdrawal, and any supporting ownership tables
- canonical metering persistence contract lands, including idempotency and correction fields
- service type definitions land for:
  - `recordFinalizedMeteringEvent(...)`
  - wallet projection from a metering event
  - earnings projection from a metering event
- other workstreams can build without redefining money or attribution contracts

**Dependency rule:** All first-wave workstreams depend on this one.

### 2. Darryn Cutover And Access

**Purpose:** Move Darryn into `fnf` without breaking his existing buyer key or connected accounts, and make the pilot dashboard accessible.

**Owned interfaces:**

- owns Darryn auth, allowlist access, org membership, and impersonation/session context
- owns live `fnf` org creation, buyer-key migration, and credential migration using Foundation contracts
- owns the auth/session contract used by pilot UI and API requests:
  - Darryn self-context
  - admin self-context
  - admin impersonating Darryn context
- exposes auth/session context consumed by downstream APIs and UI
- does not own wallet, earnings, routing, or payment logic

**Primary ownership:**

- `fnf` org creation/mapping
- buyer-key migration
- provider-credential ownership migration
- GitHub allowlist access for Darryn
- admin impersonation/context-switch backend behavior
- cutover and rollback runbook

**Likely files:**

- `api/src/routes/admin.ts`
- auth middleware and auth-related services
- onboarding/admin support docs
- possibly `ui/src/app` auth entrypoints

**Definition of done:**

- Darryn auth/session resolution works for pilot web routes and backend APIs
- the existing buyer key still authenticates and resolves to `fnf`
- Darryn's Claude/Codex credentials belong to `fnf` without reconnecting
- rollback instructions exist for broken cutover

**Depends on:** Foundation contracts.
**Depends on:** Foundation contracts. Cutover completion also depends on Routing and canonical metering.

### 3. Routing And Canonical Metering

**Purpose:** Teach the runtime to emit the three Darryn pilot modes truthfully and finalize canonical request-level money facts.

**Owned interfaces:**

- owns write-time canonical metering creation
- owns admin-managed rate-card source-of-truth tables and version lifecycle
- owns rate-card version lookup/application during metering finalization
- owns persistence of admission-time classification fields used by metering and replay
- owns durable backend read APIs for request history, routing attribution, and admin request explanations
- owns financially unfinalized request detection and retry/orchestration for missing canonical metering writes
- owns operator-visible correction intake for missing or failed metering finalization
- owns pricing/rate-card application at request finalization, including `rate_card_version_id`, derived buyer debit amount, and derived contributor earnings amount
- owns reserve-floor persistence plus reserve-floor read/write APIs consumed by dashboard and routing enforcement
- consumes the wallet paid-admission API for `paid-team-capacity` admissions once Workstream 4 lands
- consumes shared metering and projector-state types from Foundation
- does not own wallet balance, payment processor logic, or earnings withdrawal state

**Primary ownership:**

- explicit route-mode classification
- request finalization into canonical metering records
- admin-managed rate-card tables and versioning
- reserve-floor storage and read/write APIs
- reserve-floor migration into the post-cutover `fnf` ownership model using Cutover's ownership mapping
- reserve-floor and fail-closed sold-capacity enforcement
- attribution fields needed for support and dashboard drilldown
- Claude-vs-Codex lane isolation for CLI lanes
- OpenClaw/model-agnostic provider preference behavior where allowed

**Likely files:**

- `api/src/services/routingService.ts`
- `api/src/services/routerEngine.ts`
- `api/src/services/metering/usageMeteringWriter.ts`
- routing and metering repositories/tests

**Definition of done:**

- finalized requests land in exactly one allowed routing mode
- metering exists for all finalized pilot-mode requests, including `self-free`
- metering can distinguish free self-use from paid team capacity from contributor earnings
- support/admin surfaces can explain why fallback happened and why money did or did not move
- `innies claude` never spills into OpenAI/Codex
- `innies codex` never spills into Claude
- durable backend APIs exist for Darryn/admin request history and routing explanations
- canonical metering rows include applied rate-card version plus derived debit and earnings amounts
- reserve-floor persistence and read/write APIs exist for dashboard controls and routing enforcement
- Darryn's pre-cutover reserve-floor settings continue to govern sold-capacity routing immediately after cutover
- `paid-team-capacity` routing integrates with the wallet admission contract once Workstream 4 lands

**Depends on:** Foundation contracts. Full `paid-team-capacity` completion also depends on Wallet and paid admission.

### 4. Wallet And Paid Admission

**Purpose:** Make paid team-capacity usage economically real without requiring live card payments in the first wave.

**Owned interfaces:**

- owns wallet balance reads, wallet-ledger writes, and paid-admission decisions
- owns manual wallet adjustment commands and admin reason capture
- owns the wallet-side interface that may invoke an optional payments adapter
- owns wallet projection runners, retry/backlog handling, and operator visibility for stuck wallet projections
- consumes canonical metering events from Routing and canonical metering
- does not own payment methods, processor calls, webhook handling, or payment settings storage

**Primary ownership:**

- wallet ledger
- balance computation
- manual wallet credit/debit flows with reasons
- paid admission checks
- serialized wallet admission behavior
- negative-balance handling for already-admitted work
- the stable admission interface that payments will later call into

**Likely files:**

- new wallet repositories/services/routes in `api/src`
- admin wallet tooling in `api/src/routes/admin.ts`
- wallet-facing dashboard APIs

**Definition of done:**

- before Workstream 7 lands, paid admissions require positive balance
- after Workstream 7 lands, the wallet service may admit if a wallet-invoked auto-recharge attempt succeeds
- finalized paid metering produces wallet entries
- manual credits/debits are visible as ledger rows
- insufficient balance fails clearly before new paid admission
- the wallet service exposes one stable seam for later payment integration:
  - `ensurePaidAdmissionEligible(wallet_id, trigger)`
  - optional `attemptAutoRecharge(wallet_id, trigger)` adapter result handling owned by the wallet service
  - `recordPaymentOutcome(wallet_id, processor_effect_id, effect_type)` for normalized payment outcomes from Payments

**Depends on:** Foundation contracts, Routing and canonical metering.

### 5. Contributor Earnings And Withdrawals

**Purpose:** Make overflow onto Darryn capacity create visible, withdrawable earnings with manual settlement.

**Owned interfaces:**

- owns earnings balance reads, earnings-ledger writes, withdrawal requests, and payout state transitions
- owns withdrawal request commands and request-history reads
- owns earnings projection runners, retry/backlog handling, and operator visibility for stuck earnings projections
- consumes canonical metering events from Routing and canonical metering
- consumes shared projector-state primitives from Foundation
- does not own request-history APIs or payment processor integrations
- does not depend on Wallet for withdrawable-state promotion in this pilot, because earnings arise only from `team-overflow-on-contributor-capacity`

**Primary ownership:**

- earnings accrual from canonical metering
- derived earnings-availability buckets: `pending`, `withdrawable`, `reserved_for_payout`, `settled`, `adjusted`
- withdrawal request lifecycle:
  - `requested`
  - `under_review`
  - `approved`
  - `rejected`
  - `settlement_failed`
  - `settled`
- withdrawal request creation and review actions
- payout settlement and settlement-failed flows

**Likely files:**

- new earnings and withdrawal repositories/services/routes in `api/src`
- admin review actions in `api/src/routes/admin.ts`
- contributor-facing dashboard APIs

**Definition of done:**

- eligible overflow metering creates earnings entries
- Darryn can request withdrawal against withdrawable funds only
- admin can approve, reject, settle, or fail settlement with truthful ledger effects
- withdrawal history is backed by the explicit request-state lifecycle above

**Depends on:** Foundation contracts, Routing and canonical metering.

### 6. Darryn And Admin Dashboard Surfaces

**Purpose:** Give Darryn and admins one coherent place to understand balances, routing, connected accounts, reserve floors, and withdrawal state.

**Owned interfaces:**

- owns UI composition, page flows, forms, and display state for already-defined backend APIs
- owns reserve-floor controls in the web UI against backend-owned reserve-floor endpoints
- owns manual-funding visibility in the web UI against backend-owned wallet-ledger endpoints
- owns admin account-view pages and impersonation entry UI after Cutover provides backend session context
- does not own payment-method UI or auto-recharge settings UI until Workstream 7 lands
- does not own pricing, routing, ledger, or reconciliation logic

**Primary ownership:**

- Darryn wallet, spend, request, account-status, reserve-floor, earnings, and withdrawal views
- admin account-view pages, impersonation entry UI, and money/routing explanation views
- UI consumption of backend-owned dashboard endpoints
- reserve-floor controls for Claude `5h` / `1w` and Codex `5h` / `1w`
- funding controls already available in the current wave, limited to wallet balance and manual top-up visibility

**Likely files:**

- `ui/src/app/*`
- `ui/src/components/*`
- dashboard fetchers under `ui/src/lib/*`
- thin Next-side fetchers or route proxies only when required for auth/session handling

**Backend endpoint ownership:**

- backend workstreams own the durable API contracts for wallet, requests, reserve floors, earnings, withdrawals, funding controls, and admin review actions
- the dashboard workstream owns presentation, composition, and client-side state only
- the dashboard workstream must not create new pricing, earnings, or routing logic

**Definition of done:**

- Darryn can see wallet balance, ledger history, routing attribution, account status, reserve floors, earnings, and withdrawals
- Darryn can edit reserve floors for Claude `5h` / `1w` and Codex `5h` / `1w`
- Darryn can see manual top-ups immediately in wallet history
- admins can explain free vs paid vs earnings outcomes from dashboard data without going to raw DB rows

**Depends on:** Cutover and access, Routing and canonical metering, Wallet and paid admission, Contributor earnings and withdrawals.

### 7. Card Payments And Auto-Recharge

**Purpose:** Add live funding after the wallet ledger contract is already real.

**Owned interfaces:**

- owns payment-method storage, processor sessions, webhook reconciliation, and auto-recharge settings
- owns dashboard payment-method and auto-recharge controls
- exposes a payments adapter consumed by the wallet service
- does not own wallet-ledger balance rules or request routing

**Primary ownership:**

- payment processor integration
- stored payment method
- top-up flow
- webhook reconciliation into normalized payment outcomes consumed by Wallet
- auto-recharge before admission and after negative finalization
- storage and exposure of wallet funding settings
- refund/chargeback reversal handling through explicit wallet-ledger entries

**Likely files:**

- payment integration services/routes/webhooks in `api/src`
- dashboard payment-method UI in `ui/src`

**Definition of done:**

- successful payment outcomes are normalized and recorded through Wallet-owned idempotent ledger writes
- failed payments do not mutate balance
- auto-recharge attempts are serialized and visible
- duplicate or late webhooks do not double-credit the wallet
- refunds and chargebacks create explicit reversing ledger rows
- removing a payment method disables future auto-recharge cleanly
- dashboard funding controls reflect stored payment method and auto-recharge state

**Depends on:** Wallet and paid admission.

## Dependency Matrix

| Producer | Contract | Consumers |
|----------|----------|-----------|
| Foundation contracts | canonical metering types, projector-state tables, financial-finalization state model, ledger projection interfaces | all other workstreams |
| Cutover and access | `fnf` org identity, cutover-record writers, Darryn auth context, admin impersonation context | routing, dashboard surfaces |
| Routing and canonical metering | finalized metering write API, rate-card version application, request-history API, routing-explanation API, reserve-floor read/write API, metering-retry/correction flow | wallet, earnings, dashboard |
| Wallet and paid admission | wallet balance API, wallet ledger API, paid-admission decision API | routing, dashboard, payments |
| Contributor earnings and withdrawals | earnings summary API, earnings ledger API, withdrawal API, withdrawal-request status API, admin settlement API | dashboard |
| Card payments and auto-recharge | payment-method API, auto-recharge settings API, wallet-invoked recharge adapter with `not_configured` / `charge_succeeded(processor_effect_id)` / `charge_failed(processor_effect_id | null)` / `charge_pending(payment_attempt_id)` outcomes, normalized payment outcomes for Wallet recording | wallet, dashboard |

## Execution Waves

### Wave 0

- Foundation contracts

### Wave 1

- Darryn cutover and access
- Routing and canonical metering

These can start together once the foundation contract lands.
Routing must provide the admission-classification and reserve-floor contracts consumed at cutover completion.
Cutover completes only after that routing handshake succeeds.

### Wave 2

- Wallet and paid admission
- Contributor earnings and withdrawals

These both depend on request-level canonical metering and can proceed in parallel once that is stable.
The `paid-team-capacity` path becomes complete in this wave when Routing integrates the Wallet admission contract.

### Wave 3

- Darryn and admin dashboard surfaces

This should consume the already-landed API contracts instead of inventing them.

### Wave 4

- Card payments and auto-recharge

This remains intentionally last because it is coupled to wallet truth, not to routing truth.

Wave 4 is still required before the Darryn pilot is considered complete, because the pilot scope explicitly requires live card funding and auto-recharge in addition to manual wallet credits.

## Workspace Naming

Recommended workspace scopes:

- `darryn-phase2-foundation-contracts`
- `darryn-phase2-cutover-access`
- `darryn-phase2-routing-metering`
- `darryn-phase2-wallet-admission`
- `darryn-phase2-earnings-withdrawals`
- `darryn-phase2-dashboard-surfaces`
- `darryn-phase2-payments-recharge`

## Risks

- If the foundation workstream is too thin, later workspaces will still invent conflicting contracts.
- If dashboard work starts before the backend APIs settle, the UI workspace will either block or create unstable adapters.
- If payments starts before wallet-ledger semantics are proven, reconciliation bugs will be harder to unwind.

## Recommendation

Start with foundation contracts, then open separate workspaces for cutover/access and routing/metering. Do not start the payments workspace until the wallet ledger exists and manual credits/debits already reconcile cleanly.
