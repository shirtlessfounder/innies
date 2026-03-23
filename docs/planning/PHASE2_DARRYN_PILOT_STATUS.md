# Phase 2 Darryn Pilot Status

Date: 2026-03-23

## Current Decision

The Darryn-specific Phase 2 pilot is parked.

The code added for the pilot remains in `main` because it is mostly additive infrastructure that is useful beyond Darryn. We are not treating the current state as approval to migrate Darryn yet. Near-term product focus should move to Phase 3: permissionless org creation, self-serve token onboarding, and simple billing/productization.

## What Is Completed On `main`

The following Phase 2 building blocks are implemented in the main branch:

- F&F org/accounting boundary contracts:
  - buyer-key ownership cutover
  - token-credential ownership cutover
  - cutover and rollback records
  - fail-closed cutover freeze behavior
- Pilot auth and admin access:
  - GitHub allowlist login
  - pilot session handling
  - admin discovery and impersonation/context switch
- Routing and accounting seams:
  - explicit pilot routing modes
  - canonical metering for finalized pilot-mode requests
  - admission-time routing attribution persistence
  - request-history and routing-explanation APIs
  - rate-card and reserve-floor storage/read-write seams
  - lane isolation across Claude and Codex/OpenAI traffic
- Wallet and earnings foundation:
  - wallet ledger-backed balance contract
  - manual wallet credits/debits
  - earnings ledger
  - withdrawal-request lifecycle and admin review actions
  - additive API-key attribution for admin payout/review actions
- Dashboard and payments surfaces:
  - pilot dashboard/account pages
  - admin pilot account surfaces
  - connected-account status surfaces
  - Stripe-backed card attach, top-up, and auto-recharge settings

## What Was Verified In Rehearsal

We ran sacrificial-user rehearsal work against production infrastructure rather than only relying on local tests.

Verified end-to-end:

- pilot dashboard access renders
- GitHub allowlist login works for the sacrificial F&F user
- Stripe test-mode card attach works
- Stripe test-mode manual top-up works
- auto-recharge settings persist
- sacrificial buyer-key cutover into `fnf` works
- sacrificial provider credential cutover into `fnf` works
- post-cutover live request admission and service work
- post-cutover canonical metering writes for the sacrificial flow work
- rollback restores the sacrificial assets to the source org

Operational gaps discovered during rehearsal and fixed:

- production env/runtime needed the pilot GitHub and Stripe secrets plus correct pilot/UI base URLs
- production DB role grants were missing for new Phase 2 tables
- `fnf` needed to be enabled in `TOKEN_MODE_ENABLED_ORGS`
- pilot UI/API fallback URLs needed hardening to avoid localhost redirects
- cutover/rollback needed a stricter fail-closed check so success markers are not written if requested base rows were not actually reassigned

## What This Does Not Prove

This work does not mean Darryn should be moved now.

Still intentionally unproven or paused:

- Darryn's real buyer key and real connected credentials have not been migrated
- Darryn-facing launch readiness has not been signed off
- long-running economic behavior has not been validated with real repeated usage
- broader self-serve F&F onboarding is not built
- final public product packaging is not done

## Why We Are Parking It

The original Darryn pilot question was useful because it forced the hard Phase 2 seams to exist. That objective was largely achieved:

- org/accounting isolation exists
- routing/metering seams exist
- wallet/payments/earnings/withdrawal seams exist
- pilot/admin dashboard surfaces exist
- sacrificial production rehearsal exposed and fixed real issues

At this point, continued Darryn-specific migration work has worse leverage than moving to self-serve productization. The more valuable next step is Phase 3 work that turns these seams into a general product surface instead of spending additional cycles on a one-off Darryn rollout.

## What Is Reusable For Phase 3

Phase 3 can build directly on the following shipped contracts:

- org boundary and ownership migration patterns
- GitHub-backed pilot/session flows
- admin impersonation and identity discovery seams
- canonical metering and request-history surfaces
- rate-card and reserve-floor contracts
- wallet ledger and manual adjustment contracts
- Stripe payment method, top-up, and auto-recharge flows
- earnings and withdrawal ledger/review flows
- pilot/account dashboard surface patterns

## Practical Guidance

- Leave the additive Phase 2 code in `main`.
- Do not continue polishing the Darryn-specific rollout unless a new decision explicitly revives it.
- Treat [DARRYN_PILOT_REHEARSAL_CHECKLIST.md](../ops/DARRYN_PILOT_REHEARSAL_CHECKLIST.md) as the safety checklist if this work is resumed later.
- Use this status document as the canonical reference when deciding what to salvage for Phase 3.
