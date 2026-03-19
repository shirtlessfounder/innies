# Phase 2 Darryn Pilot Scope

Date: 2026-03-19

## Objective
Ship the first real Phase 2 slice as a Darryn-only Friends & Family pilot that answers the core PMF question:

- if Darryn is moved out of implicit internal-team treatment and into explicit F&F economics, does he keep using Innies or churn?

The pilot must feel like a real product, not an internal simulation. It needs live buyer payments, real routing/accounting behavior, a Darryn-facing dashboard, contributor earnings visibility, and a real withdrawal-request flow.

## Why This Is Phase 2 First
- It measures the real product question sooner than a generic F&F build.
- It forces the core marketplace loop to work end to end:
  - user-owned supply
  - paid team fallback
  - team overflow onto user supply
  - wallet debits
  - contributor accruals
  - user-facing visibility
- It avoids overbuilding broad self-serve F&F onboarding before proving that an existing friend still wants the product once the economics are explicit.

## Pilot Boundary

### Org model
- Keep the current `innies` org as the internal team org.
- Create a new `fnf` org for Darryn.
- `fnf` is the product/accounting boundary for:
  - Darryn's buyer identity
  - Darryn's connected Claude/Codex credentials
  - Darryn's wallet
  - Darryn's earnings and withdrawal requests
  - Darryn-facing dashboard views

### Migration rules
- Preserve Darryn's existing Innies buyer key.
- Migrate that buyer key from `innies` into `fnf`.
- Preserve Darryn's existing connected Claude and Codex credentials.
- Move those credentials into `fnf` without requiring Darryn to reconnect accounts.
- After cutover, the existing buyer key must keep working, but usage is governed by `fnf` economics and dashboard visibility.
- Financial and pilot history starts fresh at cutover. Prior `innies` history remains historical only and does not backfill into the new F&F wallet/earnings views.

### Access model
- Darryn logs into the pilot dashboard with GitHub.
- Access is allowlisted to Darryn's GitHub account.
- Innies admins can also view or impersonate Darryn's dashboard context from the admin side.

## Money Movement Contract

### Buyer funding
The pilot must support two funding paths:

1. Card-backed wallet funding
- live payment processor integration
- stored payment method
- auto-recharge

2. Manual wallet credits
- admins can add wallet credits manually for off-platform payments such as USDC
- manual wallet debits must also exist for corrections/reversals

### Wallet rules
- The wallet ledger is the authoritative source of buyer balance.
- Manual credits/debits are first-class wallet ledger entries, not raw balance mutations.
- Paid admissions use the Phase 2 no-preauth model:
  - admit paid work only if balance is positive or auto-recharge succeeds
  - debit from finalized request metering after service
  - allow negative balances only from already-admitted in-flight work finalizing above remaining balance
- If auto-recharge fails and balance is non-positive before admission, paid work must fail clearly.

### Contributor payout rules
- Darryn gets real contributor earnings accrual visibility.
- Darryn gets a real withdrawal-request flow.
- Withdrawal settlement remains manual in the pilot:
  - Darryn submits a request
  - admin reviews it
  - admin sends payout manually, including USDC if desired
  - system records the payout outcome and updates reserved/settled balances accordingly
- Earnings and payout adjustments must be explicit ledger entries, not silent balance edits.

## Routing And Economic Contract

The pilot must support all allowed bidirectional paths from day 1, for both Claude and Codex.

### 1. `self-free`
- Darryn uses his own `fnf` credentials for free.
- No wallet debit.
- No contributor earnings entry for self-consumption.

### 2. `paid-team-capacity`
- If Darryn's own eligible capacity cannot serve, Innies may route onto team-owned capacity in `innies`.
- This is paid usage.
- Buyer wallet entries are derived from finalized request metering.

### 3. `team-overflow-on-contributor-capacity`
- If team-owned capacity cannot serve internal traffic, Innies-team traffic may route onto Darryn's eligible contributed capacity.
- This creates contributor earnings for Darryn.
- This does not create a buyer debit for Darryn.

### Routing constraints
- Cross-org routing must be explicit and mode-specific, not implicit shared-pool behavior.
- Darryn's reserve floors continue to govern when Innies may newly sell his excess capacity.
- Reserve-floor enforcement is fail-closed for sold contributor work.
- `innies claude` stays in the Claude lane.
- `innies codex` stays in the Codex/OpenAI lane.
- Provider preference matters only for OpenClaw and other model-agnostic Innies usage.

### Accounting rule
- The financial unit is the finalized served request.
- Every financially relevant request must emit canonical metering facts that identify:
  - consumer org/user
  - serving org/capacity owner
  - serving credential
  - provider/model
  - routing mode
  - buyer debit amount, if any
  - contributor earnings amount, if any
- Wallet ledger entries, earnings ledger entries, dashboards, and support views must reconcile to those same metering facts.

## Product Surfaces

### Darryn-facing dashboard
The pilot dashboard must give Darryn one coherent account surface with:

- wallet balance
- manual top-up visibility
- card/payment-method management
- auto-recharge controls
- request history with routing attribution
- spend history
- connected Claude/Codex account status
- Claude `5h` / `1w` reserve-floor controls
- Codex `5h` / `1w` reserve-floor controls
- earnings summary
- earnings history
- withdrawal-request flow
- withdrawal-request history/status

### Admin surfaces
Admins need:

- Darryn account view / impersonation
- manual wallet credit/debit tools with required reason metadata
- withdrawal-request review actions:
  - approve
  - reject
  - mark settled
  - mark settlement failed
- routing/metering visibility sufficient to explain:
  - why a request was free vs paid
  - why fallback happened
  - why contributor earnings did or did not accrue

## Cutover And Operations
- Migration must be a deliberate cutover, not a partial dual-home state.
- We need an explicit rollback/runbook in case cutover breaks:
  - buyer-key routing
  - wallet admission
  - dashboard access
  - credential ownership/eligibility
- The pilot should be operationally honest but still flexible:
  - card payments can be live
  - USDC/manual funding can be represented through manual wallet credits
  - manual payout settlement is acceptable as long as the ledger state stays truthful

## Success Criteria
- Darryn can keep using Innies through his existing buyer key after cutover.
- Darryn can use both Claude and Codex lanes in the `fnf` org.
- Darryn can clearly see when he is:
  - using his own free capacity
  - paying for team capacity
  - earning from team overflow onto his contributed capacity
- Card funding and auto-recharge work.
- Manual wallet credits work and are visible in the wallet ledger.
- Withdrawal requests work and manual settlement reconciles correctly.
- Team overflow onto Darryn capacity accrues contributor earnings correctly.
- The team can observe whether Darryn keeps using Innies or churns after economics become explicit.

## Out Of Scope For This Pilot
- General multi-user F&F onboarding
- Permissionless org creation
- F&F-to-F&F resale
- Fully automated contributor payout settlement
- Requiring Darryn to reconnect Claude/Codex accounts from scratch
- Backfilling old `innies` history into the new F&F wallet/earnings views
- Separate F&F deployment/environment
