# Phase 2 Implementation Scope (Friends & Family PMF)

## Objective
Ship an invite-only Friends & Family version of Innies that supports:
- self-serve buyer onboarding with prepaid credits and auto-recharge
- self-serve contributor onboarding for Claude and Codex accounts
- deterministic routing/accounting across team-owned and user-contributed capacity
- buyer and contributor dashboards with enough detail to understand spend, earnings, and request behavior
- manual-review payout operations backed by a real contributor earnings ledger

Product invariant:
- Buyer/admin API keys authenticate callers into Innies only.
- The upstream provider credentials Innies pools and rotates are OAuth/session tokens from Claude Code and Codex/OpenAI logins, not public provider API keys.

Phase 2 is invite-only and runs inside one Innies-managed shared org/workspace. It is not permissionless multi-tenant org creation.

## In Scope
1. Shared F&F account model
- Invite-only user onboarding into one Innies-managed shared workspace.
- One user account may act as both buyer and contributor.
- Web dashboard is the primary management surface for onboarding, billing, connected accounts, and dashboard visibility.

2. Buyer experience
- Buyer wallet with one blended credit balance.
- Prepaid top-ups and optional auto-recharge.
- Immediate stop when balance reaches zero and auto-recharge fails.
- Buyer key issuance and management.
- Buyer dashboard with:
  - balance
  - spend history
  - request history
  - provider attribution
  - paid fallback status
- Paid Innies-team capacity access for F&F users.

3. Contributor experience
- Web-first connect flows for both Claude and Codex accounts.
- Full contributor control panel with:
  - connect/disconnect account
  - sharing enabled/disabled
  - token/account status and health visibility
  - request/serve history
  - accrued earnings visibility
  - withdrawal request flow
- One contributor may connect both Claude and Codex accounts in Phase 2.

4. Contributor sharing controls
- Contributors define four reserve floors, expressed as percentage remaining:
  - Claude `5h`
  - Claude `1w`
  - Codex `5h`
  - Codex `1w`
- These floors are per user and per provider/window, not global across all providers.
- Innies may only admit newly sold work onto a contributed account while the provider-native remaining capacity is above the configured floor for every relevant window.
- If the owner burns their own usage down to the configured floor before Innies uses the account, Innies may not use that account again until the relevant window resets.
- No hard preemption in v1. Once a session is admitted, it completes; reserve floors gate new admission only.

5. Allowed capacity flows
- Innies team may use Innies-team pooled tokens for free.
- An F&F member may use their own contributed tokens for free.
- An F&F member may pay Innies to use Innies-team pooled excess capacity.
- Innies may use an F&F member's contributed excess capacity and must accrue earnings payable to that member.
- F&F-to-F&F resale is out of scope for Phase 2.

6. Routing policy rules
- `innies claude` stays in the Claude provider lane.
- `innies codex` stays in the Codex/OpenAI provider lane.
- Provider preference matters only for OpenClaw and other model-agnostic Innies usage.
- Paid fallback from a user's own unavailable capacity to Innies-team capacity is opt-in.
- When paid fallback is enabled, the same buyer-key provider preference/fallback model applies to paid Innies-team usage.
- Innies-team traffic may use F&F contributed excess capacity only when Innies-team capacity cannot serve.

7. Ledgers and economics
- Buyer pricing uses one blended credit balance.
- Contributor earnings accrue from admin-managed payout rate tables by provider/model.
- Buyer charging and contributor earnings must be derived from the same metering facts per served request.
- Required money/accounting surfaces:
  - buyer wallet ledger
  - contributor earnings ledger
  - admin-managed rate tables
  - withdrawal request queue
  - payout settlement records

8. Logging, diagnostics, and support
- Store full enough request/response logs to diagnose support issues.
- Retain full logs for 30 days.
- Raw diagnostic visibility is available to the account owner and Innies admins.
- Product surfaces must expose enough metadata to reconcile routing, spend, and earnings disputes.

9. F&F-compatible client support
- OpenClaw using Innies.
- `innies claude`
- `innies codex`
- Web dashboard for account/payment/token management and dashboard views.

10. Docs baseline for F&F
- Buyer onboarding docs for OpenClaw.
- `innies claude` and `innies codex` how-to guidance.
- Contributor onboarding docs for connecting Claude and Codex accounts.

## Out of Scope
- Landing page work.
- Community/Discord/Telegram planning.
- Permissionless org creation.
- Separate org per F&F member.
- F&F-to-F&F resale marketplace behavior.
- Automatic contributor payout without review.
- Hard session preemption when a contributor starts using their own key.
- Provider-agnostic generic CLI entrypoints that replace `innies claude` or `innies codex`.

## Canonical User Rules (Locked)
1. Team and user free-use rules
- Innies team uses Innies-team pooled tokens for free.
- An F&F member uses their own contributed tokens for free.

2. Paid access rules
- An F&F member pays Innies to use Innies-team pooled excess capacity.
- Paid fallback from self-supplied capacity to Innies-team capacity is opt-in.
- Buyer preference routing applies only to OpenClaw/model-agnostic Innies usage, not to `innies claude` or `innies codex`.

3. Contributor compensation rules
- Innies pays an F&F member when Innies uses that member's contributed excess capacity.
- Contributor earnings accrue in a ledger and are withdrawn through a manual-review payout flow.
- Payout rates are controlled by admin-managed rate tables by provider/model.

4. Contributor reserve-floor rules
- Reserve floors are per user:
  - Claude `5h`
  - Claude `1w`
  - Codex `5h`
  - Codex `1w`
- Reserve floors are percentage-remaining floors, not Innies credits and not flat request/session caps.
- Innies may only admit new sold work while all relevant provider-native remaining windows are above the configured floor.
- If the owner reaches the floor first through self-use, Innies may not newly admit work on that account until reset.

5. Capacity resale boundaries
- F&F-to-F&F resale is not allowed in Phase 2.
- Innies-team traffic may use F&F contributed excess capacity only when team-owned capacity cannot serve.

## Cross-Workstream Contracts
Canonical entities/identifiers that Phase 2 work must share:
- `user_id`: the human account in the shared F&F workspace
- `team_consumer_id`: canonical Innies-team consumer identity for internal/team-origin traffic rollups
- `buyer_key_id`: the Innies credential used for paid buyer traffic
- `provider_account_id`: the connected Claude/Codex account owned by either team or user
- `token_credential_id`: the routable serving credential inside a provider account
- `capacity_owner_user_id`: nullable for team-owned supply; set for user-contributed supply
- `request_id`: per-request correlation identifier
- `session_id`: session/lease identifier for multi-request or long-lived traffic
- `routing_decision_id`: the routing-policy decision for a served request/session
- `metering_event_id`: canonical usage event produced from a served request/session
- `wallet_ledger_entry_id`: buyer charge/refund/adjustment record
- `earnings_ledger_entry_id`: contributor accrual/adjustment/payout record
- `rate_card_version_id`: immutable pricing snapshot identifier applied to metering

Required request-metering facts:
- Every served request that can affect money or attribution must emit a canonical metering event with:
  - consumer `user_id`
  - `team_consumer_id` for team-origin traffic rollups when applicable
  - `buyer_key_id` when paid buyer traffic is involved
  - serving `provider_account_id`
  - serving `token_credential_id`
  - `capacity_owner_user_id` or `team`
  - provider/model
  - usage quantity needed for debit/payout math
  - routing mode:
    - self-free
    - paid-team-capacity
    - team-overflow-on-contributor-capacity
  - `rate_card_version_id`
  - derived buyer debit amount, if any
  - derived contributor earnings amount, if any

Metering/finalization rule:
- The financial unit is the finalized served request, not the long-lived session.
- `session_id` groups related requests for dashboards/support, but wallet and earnings ledger entries are derived from finalized request-level metering events.
- Long-lived sessions may emit non-financial progress records, but only finalized request-level metering events may create wallet or earnings ledger entries.

Contract rule:
- Wallet entries, earnings entries, dashboards, and support views must reconcile back to canonical metering events instead of re-deriving money facts independently.

## Failure Semantics (Locked Defaults)
1. Reserve-floor signal failures
- Contributor reserve-floor enforcement is fail-closed for newly sold work.
- If either required provider-native remaining-capacity signal is missing, stale, or otherwise unavailable, the contributed account is ineligible for newly sold work until refreshed.
- If `5h` and `1w` windows disagree, the stricter window wins; all relevant windows must remain above the configured floor.
- These failures do not block the owner's own use of their account; they block Innies from newly selling that account's excess capacity.

2. Paid fallback disabled
- If a user's own capacity cannot serve and paid fallback is disabled, Innies must not route that traffic onto paid team capacity.
- The request must fail clearly with an explicit self-capacity-unavailable outcome rather than silently spilling into paid capacity.

3. Wallet admission and stop behavior
- Immediate stop at zero balance applies to new paid admissions, not to already-admitted in-flight work.
- Phase 2 uses a no-preauth wallet policy for paid usage:
  - Innies does not place a separate preauthorization/hold per request/session
  - paid usage is debited from actual metering after service
- A paid request/session may only be admitted if:
  - the buyer currently has a positive wallet balance, or
  - auto-recharge succeeds before admission continues
- If balance is exhausted and recharge fails before admission, the paid request/session is rejected before serving begins.
- Already-admitted in-flight work is not hard-killed solely because the wallet reaches zero during execution.
- Paid admission checks and auto-recharge attempts must be serialized per buyer wallet to avoid duplicate recharge attempts or inconsistent eligibility decisions.
- Phase 2 tolerates negative balances created by already-admitted concurrent work under the no-preauth model; the pause/stop rule applies after those finalized debits post.

4. Paid usage billing semantics
- Paid traffic is billed from actual metering after service, not from rough dashboard estimates.
- If a paid request/session fails before billable usage is produced, no buyer debit or contributor accrual should be created.
- If a paid request/session partially serves and then fails, billing and contributor accrual must reflect only the actual metered usage that was served.
- If final metering leaves the wallet at or below zero, future paid admissions stop until balance is restored or recharge succeeds.
- Negative wallet balances are allowed only as the result of already-admitted in-flight work finalizing above the remaining balance.
- If auto-recharge is enabled, Innies should attempt recharge immediately after finalization creates a negative wallet balance.
- If that recharge fails, the wallet remains negative, the account is paused for future paid admissions, and the negative amount is user-visible debt until a top-up succeeds.

5. Quarantine and paid-capacity denial
- If routing cannot find eligible team capacity or contributor overflow capacity under the locked routing rules, Innies must fail clearly instead of silently rerouting to a disallowed supply bucket.
- Billing must only occur for capacity actually admitted and served under an allowed routing mode.

## Money Movement Contract
- The buyer wallet ledger is the authoritative source of buyer balance.
- Payment-processor outcomes do not change balance directly; they create or reverse wallet-ledger entries.
- Every payment-processor event used for wallet changes must be processed idempotently using the processor event identifier plus the intended wallet effect.
- Top-up success creates a positive wallet-ledger entry.
- Top-up failure creates no positive wallet balance change.
- Reversal/chargeback/refund creates an explicit reversing wallet-ledger entry; it must never silently mutate historical wallet entries.
- Auto-recharge is attempted before paid admission when balance is non-positive and can also be attempted immediately after finalization creates a negative balance.
- The wallet service owns creation of wallet-ledger entries; the payment integration layer only proposes payment outcomes and reconciliation events.

## Earnings Availability Contract
- Contributor earnings start as `pending` when a metering event is recorded.
- Earnings become `withdrawable` once the finalized request-level metering event is posted and:
  - any linked buyer-wallet outcome for that same finalized request is recorded, or
  - no buyer-wallet outcome exists for that routing mode, such as team-overflow onto contributor capacity
- A withdrawal request moves the requested amount from `withdrawable` to `reserved_for_payout`.
- `reserved_for_payout` funds are not available for a second withdrawal request.
- A successful payout settlement moves funds from `reserved_for_payout` to `settled`.
- A rejected or failed payout returns reserved funds to `withdrawable` unless an explicit adjustment entry says otherwise.
- Reversals/adjustments must be represented as explicit earnings-ledger entries, not silent mutation of historical accruals.

## State Model Glossary
1. Earnings availability states
- `pending`
- `withdrawable`
- `reserved_for_payout`
- `settled`
- `adjusted`

2. Withdrawal request states
- `requested`
- `under_review`
- `approved`
- `rejected`
- `settlement_failed`
- `settled`

3. Provider-account lifecycle states
- `connected`
- `expired`
- `needs_reauth`
- `disconnected`
- `ineligible_for_sale`

4. Routing outcomes
- `self_free`
- `paid_team_capacity`
- `team_overflow_on_contributor_capacity`
- `rejected_no_allowed_capacity`

## Buyer Preference Contract
- Applies only to OpenClaw and other model-agnostic Innies usage.
- Does not apply to `innies claude` or `innies codex`; those remain provider-pinned.
- Input:
  - buyer key explicit preferred provider, if set
  - provider default order, if no explicit preference is set
- Default provider order for Phase 2:
  - Codex first
  - Claude second
- Output:
  - deterministic provider-lane order for routing attempts
- Rules:
  - explicit preference emits `[preferred_provider, alternate_provider]`
  - no explicit preference emits the platform default order `[codex, claude]`
  - routing only considers providers allowed by the current client path and locked runtime decision order

## Runtime Decision Order (Locked)
1. F&F user traffic on `innies claude`
- Stay in Claude lane only.
- Try the user's own eligible Claude-contributed capacity first.
- If self-capacity cannot serve and paid fallback is enabled, try eligible Innies-team Claude capacity.
- If neither can serve, fail clearly.

2. F&F user traffic on `innies codex`
- Stay in Codex/OpenAI lane only.
- Try the user's own eligible Codex-contributed capacity first.
- If self-capacity cannot serve and paid fallback is enabled, try eligible Innies-team Codex capacity.
- If neither can serve, fail clearly.

3. F&F user traffic on OpenClaw/model-agnostic Innies usage
- Build the provider-lane order from the buyer preference contract.
- For each provider lane in order:
  - try the user's own eligible capacity in that lane first
  - if self-capacity cannot serve and paid fallback is enabled, try eligible Innies-team capacity in that lane
- Do not use another F&F member's contributed capacity for F&F user traffic in Phase 2.
- If no allowed lane can serve, fail clearly.

4. Innies-team traffic
- Try eligible Innies-team capacity first.
- If team capacity cannot serve, try eligible F&F contributed excess capacity in the same provider lane.
- If neither can serve, fail clearly.

## Capacity-Signal Contract
- The provider-account health/capacity subsystem owns refresh of provider-native remaining-capacity signals.
- Routing does not derive remaining-capacity windows itself; it consumes a provider-account capacity snapshot with at least:
  - provider/account identifier
  - remaining `5h` signal
  - remaining `1w` signal
  - `observed_at`
  - freshness/eligibility status
  - ineligible reason when blocked
- A provider-account capacity snapshot is stale once it exceeds the configured freshness threshold for that provider.
- The exact freshness thresholds are follow-on implementation-plan inputs, but the routing contract is fixed now:
  - routing only admits newly sold work when both required windows are fresh and above the configured floors
  - otherwise routing treats the account as ineligible and emits an explicit reason such as `capacity_signal_stale` or `capacity_below_floor`

## Architecture Workstreams

### A) Identity, Invites, and Account Model
Deliverables:
- Invite-only F&F account onboarding in one shared Innies workspace
- User identity model that supports one account acting as both buyer and contributor
- Account-role and permission model for:
  - F&F user
  - Innies admin
  - payout reviewer/operator

Acceptance:
- A trusted F&F user can join via invite and access all buyer/contributor surfaces from one account.

### B) Token Ownership and Sharing Model
Deliverables:
- Ownership model for provider accounts/credentials:
  - `team`
  - `user_contributed`
- Provider-account sharing controls:
  - sharing enabled/disabled
  - payout eligibility
  - reserve-floor settings
- Support for both Claude and Codex contributed accounts in Phase 2 day 1

Acceptance:
- Every serving credential can be attributed to a capacity owner and sharing policy.
- If an account is payout-disabled/admin-blocked, it is ineligible for newly sold work and does not accrue new sold-use earnings while blocked; owner self-use may remain eligible.

### C) Routing Policy and Reserve-Floor Enforcement
Deliverables:
- Routing policy layer that chooses which supply bucket is eligible before normal credential selection
- Three allowed serving modes:
  - owner-self free use on own contributed capacity
  - paid use of Innies-team capacity
  - team overflow onto F&F contributed excess capacity
- OpenClaw preference behavior on paid team-capacity usage
- Reserve-floor enforcement using provider-native remaining `5h` / `1w` windows
- Explicit fail-closed handling for stale/missing remaining-capacity signals
- Clear rejection outcomes when paid fallback is disabled or no eligible supply bucket exists

Acceptance:
- Requests only use capacity allowed by the locked user rules.
- New sold work is blocked once reserve floors are hit.
- Stale or missing capacity signals block newly sold work on contributed accounts until refreshed.
- `innies claude` and `innies codex` remain in their pinned provider lanes.

### D) Buyer Wallet Ledger
Deliverables:
- Wallet ledger model for:
  - top-ups
  - debits
  - refunds/adjustments
  - auto-recharge attempts/results
- Blended credit balance presentation
- Spend attribution from served requests
- Balance guardrails on paid team-capacity usage
- Admission-time wallet policy for zero-balance and recharge failure behavior
- Reconciliation between canonical metering events and wallet ledger entries

Acceptance:
- Every buyer debit is explainable from request-metering records.
- Zero balance plus failed auto-recharge stops paid usage immediately.
- In-flight paid work is not hard-killed solely by wallet exhaustion.

### E) Contributor Earnings Ledger and Withdrawal Ops
Deliverables:
- Contributor earnings accrual model
- Earnings entries derived from served-request metering
- Withdrawal request workflow
- Admin payout review and settlement records
- Reconciliation between canonical metering events and contributor earnings entries
- Withdrawal/payout state machine:
  - `requested`
  - `under_review`
  - `approved`
  - `rejected`
  - `settled`
  - `settlement_failed`
- Idempotent payout-settlement records for retries/manual review

Acceptance:
- Contributors can see accrued earnings and request withdrawal.
- Admins can settle payouts without off-ledger ambiguity.
- `pending`, `withdrawable`, `reserved_for_payout`, `settled`, and `adjusted` earnings are visible as separate balances/states.

### F) Pricing and Rate Tables
Deliverables:
- Admin-managed rate tables for:
  - buyer blended pricing inputs
  - contributor payout rates by provider/model
- Immutable rate-card versions/effective-at timestamps
- Rule for which rate-card snapshot governs each metered request
- Change management for pricing/rate updates

Acceptance:
- Buyer charging and contributor payout math come from explicit rate tables, not ad-hoc runtime logic.
- Billing and payout reconstruction remain reproducible after rate changes.

### G) Logging, Retention, and Support Diagnostics
Deliverables:
- High-fidelity request/response diagnostic storage for Phase 2 traffic
- 30-day retention policy
- Visibility model for account owner and Innies admins
- Data-classification and redaction rules for:
  - upstream auth/session artifacts
  - buyer/admin API keys
  - payment instrument details
  - sensitive request metadata not needed for debugging
- Support surfaces for correlating:
  - request history
  - routing outcome
  - wallet debit
  - contributor earnings

Acceptance:
- Support can diagnose request failures or billing disputes without raw database spelunking.
- Diagnostic visibility does not expose raw secrets or payment artifacts.

Locked visibility rules:
- Account owners may see:
  - their own request/response content
  - their own request metadata
  - their own routing/billing/earnings records
- Account owners may not see:
  - upstream OAuth/session tokens
  - Innies buyer/admin API keys
  - another user's request/response content
  - raw payment instrument details beyond safe payment-processor display metadata
- Innies admins may see:
  - support/debug request content needed for diagnosis
  - routing/accounting/ledger correlation metadata
- Innies admins may not see raw payment secrets, OAuth/session tokens, or full key material in product surfaces.

### H) Buyer, Contributor, and Admin Surfaces
Deliverables:
- Buyer dashboard:
  - balance
  - spend history
  - request history
  - provider attribution
  - paid fallback status
  - minimum drilldowns/filters:
    - date range
    - provider
    - routing mode
    - per-request debit and failure reason
- Contributor dashboard:
  - connected accounts
  - reserve-floor settings
  - current sell eligibility
  - serve history
  - accrued earnings
  - withdrawal requests
  - minimum drilldowns/filters:
    - date range
    - provider/account
    - earnings state (`pending`, `withdrawable`, `reserved_for_payout`, `settled`, `adjusted`)
    - ineligible-for-sale reason
- Admin views:
  - rate tables
  - payout queue
  - ledger adjustments
  - diagnostic log access
  - minimum drilldowns/filters:
    - user/account
    - provider
    - routing mode
    - payout state
    - request -> wallet -> earnings correlation path

Acceptance:
- Buyer, contributor, and admin roles can answer common operational questions from product surfaces.
- `2C` planning may assume these minimum drilldowns are in scope; it does not need to rediscover dashboard scope from scratch.

### I) F&F Onboarding and Docs
Deliverables:
- Buyer onboarding for OpenClaw
- `innies claude` and `innies codex` guidance for F&F users
- Contributor onboarding for connecting Claude and Codex accounts via web-first flows

Acceptance:
- A trusted F&F user can onboard without continuous admin hand-holding.

### J) Payment Processor Integration
Deliverables:
- Wallet top-up integration
- Auto-recharge integration
- Payment success/failure reconciliation into the buyer wallet ledger
- Safe payment-method display metadata for dashboard/account surfaces
- Idempotent processing of asynchronous payment-processor events
- Explicit handling for delayed success/failure and reversal/chargeback outcomes

Acceptance:
- Wallet balance changes reconcile cleanly with payment-processor outcomes.

### K) Provider Connect Lifecycle
Deliverables:
- Web-first Claude/Codex connect flows
- Connected-account lifecycle contract with explicit routing consequences:
  - `connected`
    - owner self-use: eligible
    - sold use: eligible only if sharing is enabled, capacity signals are fresh, above reserve floors, and no other sale block exists
  - `expired`
    - owner self-use: ineligible
    - sold use: ineligible
  - `needs_reauth`
    - owner self-use: ineligible
    - sold use: ineligible
  - `disconnected`
    - owner self-use: ineligible
    - sold use: ineligible
  - `ineligible_for_sale`
    - owner self-use: may remain eligible
    - sold use: ineligible
- Reauth/disconnect behavior that preserves routing/accounting clarity
- Explicit trigger reasons for `ineligible_for_sale`, including:
  - sharing disabled
  - reserve floor reached
  - stale/missing capacity signals
  - payout-disabled/admin-blocked state
- In-flight lifecycle-change behavior:
  - if an already-admitted request/session later sees `expired`, `needs_reauth`, or `disconnected`, allow in-flight work to continue best-effort
  - do not admit new work on that account after the lifecycle change
  - do not mid-session reroute solely because of the lifecycle change
  - if the in-flight work fails after the lifecycle change, bill/accrue only actual finalized metered usage and surface the auth/lifecycle failure clearly

Acceptance:
- Connected accounts become eligible or ineligible through explicit lifecycle states instead of hidden auth drift.
- Historical attribution remains stable even after later lifecycle-state changes.

## Milestones

### Phase 2A: Marketplace Foundations
Scope:
- shared F&F account model
- team vs user-contributed ownership model
- reserve-floor settings model
- routing policy layer for the three allowed serving modes
- buyer wallet ledger
- contributor earnings ledger
- admin-managed rate tables
- withdrawal-request workflow
- logging/retention/access foundations

Required planning split:
- `2A.1` identity, ownership, routing-mode, and metering contracts
- `2A.2` buyer wallet ledger and admission/charging rules
- `2A.3` contributor earnings ledger, withdrawals, and payout settlement records
- `2A.4` logging, retention, redaction, and support-correlation foundations

Execution rule:
- `2A.1` must land first and lock the shared contracts before implementation planning begins for `2A.2`, `2A.3`, or `2A.4`.
- `2A.2`, `2A.3`, and `2A.4` should be separate follow-on implementation plans, not one combined foundation build.

Exit gate:
- every request path is attributable to both a consumer and a capacity owner
- buyer debit and contributor earnings math are deterministic from raw metering facts
- reserve-floor eligibility is enforced correctly

### Phase 2B: Self-Serve Onboarding and Account Management
Scope:
- invite flow and account creation
- web-first Claude + Codex connect flows
- contributor controls:
  - sharing toggle
  - reserve-floor editing
  - account status/health visibility
- buyer controls:
  - add funds
  - auto-recharge
  - buyer key management
  - paid fallback toggle
  - OpenClaw provider preference
- baseline F&F docs

Required planning split:
- `2B.1` invite/account creation and shared-workspace identity surfaces
- `2B.2` provider connect flows and connected-account lifecycle handling
- `2B.3` buyer billing setup, buyer keys, fallback controls, and OpenClaw preference controls
- `2B.4` F&F onboarding docs and first-run guidance

Exit gate:
- a trusted F&F user can onboard as both buyer and contributor with minimal admin help
- connected accounts become routable and observable through product surfaces

### Phase 2C: Dashboards, Support, and Payout Operations
Scope:
- buyer dashboard
- contributor dashboard
- admin ledger/rate/payout views
- request/billing/earnings drilldown
- withdrawal review and settlement workflow

Required planning split:
- `2C.1` buyer dashboard/reporting surfaces
- `2C.2` contributor dashboard/reporting surfaces
- `2C.3` admin payout/reconciliation/support surfaces

Exit gate:
- buyers can understand spend and provider-serving behavior
- contributors can understand earnings and request payout
- admins can diagnose disputes and process payouts from the product

### Phase 2D: Runtime Hardening for F&F Traffic
Scope:
- pool-exhaustion UX
- bad-key/quarantine guardrails tied to billing behavior
- clear behavior for failed wallet recharge and paid-capacity denial
- validation across OpenClaw, `innies claude`, `innies codex`, and dashboard/accounting surfaces
- runbooks for launch and incident handling

Required planning split:
- `2D.1` runtime failure modes and user-facing rejection semantics
- `2D.2` cross-client contract validation across API, CLI, and dashboard/accounting paths
- `2D.3` runbooks and launch-readiness checks

Exit gate:
- failure modes degrade clearly, not ambiguously
- billing, routing, and support behavior stay consistent under stress/failure

## Exit Criteria for Phase 2
- Invite-only F&F users can onboard as buyers and contributors from one account.
- Claude and Codex contributed accounts can be connected and governed by reserve-floor settings.
- Team vs contributed capacity ownership is explicit in routing and accounting.
- OpenClaw paid usage respects buyer preference routing; `innies claude` and `innies codex` remain provider-pinned.
- Buyer wallet balance, spend, and recharge behavior are observable and correct.
- Contributor earnings accrual and withdrawal requests are observable and correct.
- High-fidelity diagnostic logs are stored for 30 days, with redacted product-surface visibility for account owners and Innies admins under the locked visibility rules.
- The product clearly explains whether a request used self-capacity, paid team capacity, or contributor excess capacity.

## Priority Order
1. Marketplace foundations (`2A`)
2. Self-serve onboarding/account management (`2B`)
3. Dashboards/support/payout ops (`2C`)
4. Runtime hardening (`2D`)

Rule:
- Do not treat dashboard polish as Phase 2 progress if ledger/metering/routing truth is still ambiguous.

## Risks
- Provider-native `5h` / `1w` remaining-capacity signals may be noisy or stale, creating reserve-floor enforcement edge cases.
- Money movement spans two ledgers; metering mistakes can create both buyer overcharge and contributor underpayment.
- Full diagnostic logging increases privacy/support obligations and must not remain an afterthought.
- Team-overflow onto contributed capacity can create routing/accounting complexity if not modeled explicitly from the start.
- Web-first connect flows for Claude and Codex may expose provider-specific OAuth/session quirks not present in internal flows.
- Rate changes can make historical billing/payout reconstruction impossible if version snapshots are not locked into metering.

## Dependencies
- Stable invite/auth account model for F&F access.
- Existing provider-lane behavior for `innies claude`, `innies codex`, and OpenClaw routing.
- Reliable provider account health/remaining-capacity signals for Claude and Codex.
- Payment processor integration for wallet top-ups and auto-recharge.
- Admin surface capable of operating rate tables and payout review.

## Follow-On Planning Docs
Phase 2 will likely need separate implementation plans for:
- routing policy + reserve-floor enforcement
- cross-workstream identity/metering/rate contracts
- buyer wallet ledger + payment integration
- contributor earnings ledger + payout workflow
- F&F dashboard/account surfaces
- logging/privacy/retention operations

Implementation-start rule:
- Do not start implementation from this umbrella scope doc alone.
- Start implementation only from a follow-on implementation plan covering one split milestone/workstream at a time.

## Canonical Planning Rule
- `docs/planning/ROADMAP.md` remains the phase-order and priority document.
- `docs/planning/PHASE2_IMPLEMENTATION_SCOPE.md` is the Phase 2 umbrella source of truth.
- Durable runtime behavior belongs in `docs/API_CONTRACT.md` and any future billing/routing contract docs once the Phase 2 implementation is underway.
