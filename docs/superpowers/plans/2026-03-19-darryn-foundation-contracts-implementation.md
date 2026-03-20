# Darryn Foundation Contracts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared Phase 2 Darryn pilot schema, enums, repository seams, and projection contracts so downstream cutover, routing, wallet, and earnings workstreams can build without redefining financial or attribution primitives.

**Architecture:** Add one contract-first migration wave for canonical metering, projector state, wallet and earnings ledgers, withdrawal requests, F&F ownership mappings, cutover/rollback records, and a minimal rate-card version FK seam. Keep all code in thin repositories and pure contract helpers; do not add cutover execution, routing policy, wallet business rules, earnings workflows, UI, or payment behavior.

**Tech Stack:** TypeScript, Vitest, Postgres SQL migrations, Express repo layer

---

## File Map

- Create: `docs/migrations/017_darryn_foundation_contracts.sql`
- Create: `docs/migrations/017_darryn_foundation_contracts_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`
- Create: `api/src/types/phase2Contracts.ts`
- Create: `api/src/repos/canonicalMeteringRepository.ts`
- Create: `api/src/repos/meteringProjectorStateRepository.ts`
- Create: `api/src/repos/walletLedgerRepository.ts`
- Create: `api/src/repos/earningsLedgerRepository.ts`
- Create: `api/src/repos/withdrawalRequestRepository.ts`
- Create: `api/src/repos/fnfOwnershipRepository.ts`
- Create: `api/src/repos/pilotCutoverRepository.ts`
- Create: `api/src/services/metering/ledgerProjectionContracts.ts`
- Test: `api/tests/phase2Contracts.test.ts`
- Test: `api/tests/canonicalMeteringRepository.test.ts`
- Test: `api/tests/meteringProjectorStateRepository.test.ts`
- Test: `api/tests/walletLedgerRepository.test.ts`
- Test: `api/tests/earningsLedgerRepository.test.ts`
- Test: `api/tests/withdrawalRequestRepository.test.ts`
- Test: `api/tests/fnfOwnershipRepository.test.ts`
- Test: `api/tests/pilotCutoverRepository.test.ts`

## Chunk 1: Shared Contract Values And Projection Inputs

### Task 1: Add failing tests for shared enum/value contracts and projection-input helpers

**Files:**
- Create: `api/tests/phase2Contracts.test.ts`
- Create: `api/src/types/phase2Contracts.ts`
- Create: `api/src/services/metering/ledgerProjectionContracts.ts`

- [ ] **Step 1: Write the failing shared-contract tests**

Cover:

- allowed `finalization_kind` values:
  - `served_request`
  - `correction`
  - `reversal`
- allowed `wallet_effect_type` values:
  - `buyer_debit`
  - `buyer_correction`
  - `buyer_reversal`
  - `manual_credit`
  - `manual_debit`
  - `payment_credit`
  - `payment_reversal`
- allowed `earnings_effect_type` values:
  - `contributor_accrual`
  - `contributor_correction`
  - `contributor_reversal`
  - `withdrawal_reserve`
  - `withdrawal_release`
  - `payout_settlement`
  - `payout_adjustment`
- allowed projector state values:
  - `pending_projection`
  - `projected`
  - `needs_operator_correction`
- allowed projector names:
  - `wallet`
  - `earnings`
- allowed withdrawal-request states and legal transitions from the split-design doc
- pure projection-contract helpers:
  - `served_request` with non-zero buyer amount yields `buyer_debit`
  - `served_request` with non-zero earnings amount yields `contributor_accrual`
  - `correction` yields correction effect types only for non-zero deltas
  - `reversal` yields reversal effect types only for non-zero deltas
  - zero-amount `self-free` rows yield no wallet or earnings projection inputs

- [ ] **Step 2: Run the focused contract test and verify RED**

Run: `npm test -- --run tests/phase2Contracts.test.ts`

Expected: FAIL because the new shared contract module and projection helpers do not exist.

- [ ] **Step 3: Implement the minimal shared contract module**

Add:

- stable exported readonly arrays for the allowed value sets
- TypeScript union types derived from those arrays
- typed transition guards for withdrawal-request states
- pure helper functions that convert a canonical metering event into wallet and earnings projection drafts without writing ledger rows

- [ ] **Step 4: Re-run the focused contract test and verify GREEN**

Run: `npm test -- --run tests/phase2Contracts.test.ts`

Expected: PASS.

## Chunk 2: Canonical Metering And Projector-State Persistence

### Task 2: Add failing tests for canonical metering persistence

**Files:**
- Create: `api/tests/canonicalMeteringRepository.test.ts`
- Create: `api/src/repos/canonicalMeteringRepository.ts`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing repository tests**

Cover:

- inserting a `served_request` canonical event writes:
  - request identity
  - `finalization_kind`
  - idempotency key derived from `(request_id, attempt_no, finalization_kind)`
  - admission classification fields
  - `rate_card_version_id`
  - token usage quantities
  - buyer debit and contributor earnings amounts
- correction and reversal rows require `source_metering_event_id`
- `served_request` rows reject `source_metering_event_id`
- repository SQL uses the new canonical table name and returns one row

- [ ] **Step 2: Run the focused metering repository test and verify RED**

Run: `npm test -- --run tests/canonicalMeteringRepository.test.ts`

Expected: FAIL because the repository and table names do not exist yet.

- [ ] **Step 3: Implement the minimal canonical metering repository**

Add:

- row and input types that match the shared contract
- a single insert path that enforces `served_request` vs correction/reversal source-event rules
- deterministic idempotency key generation from `(request_id, attempt_no, finalization_kind)`

- [ ] **Step 4: Re-run the focused metering repository test and verify GREEN**

Run: `npm test -- --run tests/canonicalMeteringRepository.test.ts`

Expected: PASS.

### Task 3: Add failing tests for per-projector state persistence

**Files:**
- Create: `api/tests/meteringProjectorStateRepository.test.ts`
- Create: `api/src/repos/meteringProjectorStateRepository.ts`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing projector-state tests**

Cover:

- upserting `(metering_event_id, projector)` rows
- default state is `pending_projection`
- marking a row `projected` stores `projected_at`
- marking a row `needs_operator_correction` stores shared retry metadata:
  - `retry_count`
  - `last_attempt_at`
  - `next_retry_at`
  - `last_error_code`
  - `last_error_message`
- repository reads rows by metering event id and by projector/state

- [ ] **Step 2: Run the focused projector-state test and verify RED**

Run: `npm test -- --run tests/meteringProjectorStateRepository.test.ts`

Expected: FAIL because the repository and shared retry metadata contract do not exist.

- [ ] **Step 3: Implement the minimal projector-state repository**

Add:

- typed row and write-input shapes
- `ensurePending(...)`
- `markProjected(...)`
- `markNeedsOperatorCorrection(...)`
- read helpers for downstream projector runners

- [ ] **Step 4: Re-run the focused projector-state test and verify GREEN**

Run: `npm test -- --run tests/meteringProjectorStateRepository.test.ts`

Expected: PASS.

## Chunk 3: Shared Ledger, Withdrawal, Ownership, And Cutover Repositories

### Task 4: Add failing tests for append-only wallet and earnings ledger repositories

**Files:**
- Create: `api/tests/walletLedgerRepository.test.ts`
- Create: `api/tests/earningsLedgerRepository.test.ts`
- Create: `api/src/repos/walletLedgerRepository.ts`
- Create: `api/src/repos/earningsLedgerRepository.ts`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing wallet-ledger tests**

Cover:

- append-only insert for projected buyer rows keyed by `(metering_event_id, wallet_effect_type)`
- append-only insert for manual wallet rows with actor and reason metadata
- payment-backed rows accept `processor_effect_id`
- repository exposes minimal reads by wallet id and metering event id

- [ ] **Step 2: Write the failing earnings-ledger tests**

Cover:

- append-only insert for projected contributor rows keyed by `(metering_event_id, earnings_effect_type)`
- append-only insert for manual payout-related rows with actor and reason metadata
- balance bucket column supports:
  - `pending`
  - `withdrawable`
  - `reserved_for_payout`
  - `settled`
  - `adjusted`
- repository exposes minimal reads by contributor owner and metering event id

- [ ] **Step 3: Run the focused ledger repository tests and verify RED**

Run:

- `npm test -- --run tests/walletLedgerRepository.test.ts`
- `npm test -- --run tests/earningsLedgerRepository.test.ts`

Expected: FAIL because the tables and repositories do not exist.

- [ ] **Step 4: Implement the minimal ledger repositories**

Add:

- append-only repository methods only
- no wallet admission logic
- no earnings availability orchestration
- only the shared row shapes, idempotent insert contracts, and basic reads

- [ ] **Step 5: Re-run the focused ledger tests and verify GREEN**

Run the same commands as Step 3.

Expected: PASS.

### Task 5: Add failing tests for withdrawal-request persistence

**Files:**
- Create: `api/tests/withdrawalRequestRepository.test.ts`
- Create: `api/src/repos/withdrawalRequestRepository.ts`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing withdrawal-request tests**

Cover:

- creating a request row with amount, currency, destination metadata, actor metadata, and initial status `requested`
- updating request status only within allowed transitions
- storing settlement failure reason and settlement reference fields without embedding payout logic
- reading requests by contributor owner and request id

- [ ] **Step 2: Run the focused withdrawal-request test and verify RED**

Run: `npm test -- --run tests/withdrawalRequestRepository.test.ts`

Expected: FAIL because the repository and table do not exist.

- [ ] **Step 3: Implement the minimal withdrawal-request repository**

Add:

- create
- status transition update with shared transition validation only
- read helpers for downstream earnings/admin work

- [ ] **Step 4: Re-run the focused withdrawal-request test and verify GREEN**

Run: `npm test -- --run tests/withdrawalRequestRepository.test.ts`

Expected: PASS.

### Task 6: Add failing tests for F&F ownership mapping and cutover/rollback read contracts

**Files:**
- Create: `api/tests/fnfOwnershipRepository.test.ts`
- Create: `api/tests/pilotCutoverRepository.test.ts`
- Create: `api/src/repos/fnfOwnershipRepository.ts`
- Create: `api/src/repos/pilotCutoverRepository.ts`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing ownership-mapping tests**

Cover:

- buyer-key ownership rows reference `in_api_keys` and target org/user ownership
- provider-credential ownership rows reference `in_token_credentials` and target org/capacity-owner ownership
- repositories expose read helpers used later by cutover and routing without implementing migration behavior

- [ ] **Step 2: Write the failing cutover/rollback contract tests**

Cover:

- cutover rows persist `effective_at`, source org, target org, buyer-key migration completion, credential migration completion, and reserve-floor migration completion
- rollback rows persist `effective_at`, reverted buyer-key target, reverted credential target, and optional source cutover reference
- repositories expose latest committed marker reads for downstream admission classification

- [ ] **Step 3: Run the focused ownership and cutover tests and verify RED**

Run:

- `npm test -- --run tests/fnfOwnershipRepository.test.ts`
- `npm test -- --run tests/pilotCutoverRepository.test.ts`

Expected: FAIL because the tables and repositories do not exist.

- [ ] **Step 4: Implement the minimal ownership and cutover repositories**

Add:

- read/write persistence only
- no cutover orchestration
- no routing reserve-floor migration logic
- no auth/session behavior

- [ ] **Step 5: Re-run the focused ownership and cutover tests and verify GREEN**

Run the same commands as Step 3.

Expected: PASS.

## Chunk 4: Migrations And Table Registration

### Task 7: Add the failing migration assertions, then implement the schema

**Files:**
- Create: `docs/migrations/017_darryn_foundation_contracts.sql`
- Create: `docs/migrations/017_darryn_foundation_contracts_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`
- Modify: repository tests above as needed to assert concrete table names and columns

- [ ] **Step 1: Extend the repository tests to assert the exact table names and key column names**

Assert the new SQL targets:

- `in_rate_card_versions`
- `in_canonical_metering_events`
- `in_metering_projector_states`
- `in_wallet_ledger`
- `in_earnings_ledger`
- `in_withdrawal_requests`
- `in_fnf_api_key_ownership`
- `in_fnf_token_credential_ownership`
- `in_cutover_records`
- `in_rollback_records`

- [ ] **Step 2: Run the focused repository suite and verify RED**

Run:

- `npm test -- --run tests/canonicalMeteringRepository.test.ts`
- `npm test -- --run tests/meteringProjectorStateRepository.test.ts`
- `npm test -- --run tests/walletLedgerRepository.test.ts`
- `npm test -- --run tests/earningsLedgerRepository.test.ts`
- `npm test -- --run tests/withdrawalRequestRepository.test.ts`
- `npm test -- --run tests/fnfOwnershipRepository.test.ts`
- `npm test -- --run tests/pilotCutoverRepository.test.ts`

Expected: FAIL until table names and migrations are implemented consistently.

- [ ] **Step 3: Implement the migration files and register the new table names**

Migration requirements:

- create stable enums for the shared value sets
- create placeholder `in_rate_card_versions` with only the columns needed for a real FK seam now
- create canonical metering with:
  - idempotent unique key on `(request_id, attempt_no, finalization_kind)`
  - nullable `source_metering_event_id` only for correction/reversal rows
  - admission classification fields
  - buyer and contributor amount fields
- create projector-state table with PK `(metering_event_id, projector)` and shared retry metadata
- create append-only wallet and earnings ledgers with idempotent unique constraints for metering-derived effects
- create withdrawal requests
- create F&F ownership mapping tables
- create cutover and rollback record tables plus the necessary FKs

- [ ] **Step 4: Re-run the focused repository suite and verify GREEN**

Run the same commands as Step 2.

Expected: PASS.

## Chunk 5: Broad Verification

### Task 8: Run the verification commands before closing the workspace

**Files:**
- Verify only

- [ ] **Step 1: Run the full new-test slice**

Run:

- `npm test -- --run tests/phase2Contracts.test.ts`
- `npm test -- --run tests/canonicalMeteringRepository.test.ts`
- `npm test -- --run tests/meteringProjectorStateRepository.test.ts`
- `npm test -- --run tests/walletLedgerRepository.test.ts`
- `npm test -- --run tests/earningsLedgerRepository.test.ts`
- `npm test -- --run tests/withdrawalRequestRepository.test.ts`
- `npm test -- --run tests/fnfOwnershipRepository.test.ts`
- `npm test -- --run tests/pilotCutoverRepository.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the API build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Inspect the diff for scope discipline**

Verify:

- only shared schema/contracts/types/projector-state work landed
- no cutover execution logic
- no routing policy changes
- no wallet admission or earnings business behavior
- no UI or payment code
