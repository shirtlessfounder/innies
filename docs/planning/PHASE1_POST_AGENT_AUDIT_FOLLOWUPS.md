# Phase 1 Post-Agent Audit Follow-Ups

Date: 2026-03-05
Status: open
Scope: cross-agent review after Codex support, buyer-key provider preference, and related validation/docs work

## Purpose
Capture the remaining issues after the latest multi-agent implementation pass, separate from the earlier planning queue.

This document is for patch sequencing and rollout safety, not for re-litigating already-merged decisions.

## Current State
- Agent 1 routing work is implemented and validated:
  - DB-backed buyer preference routing
  - `codex -> openai` canonicalization at proxy ingress
  - fallback on preferred-provider preflight failures
  - route decision metadata with explicit provider-selection reasons
- Agent 2 follow-up work is implemented and validated:
  - shared `BUYER_PROVIDER_PREFERENCE_DEFAULT` resolution now flows through admin and proxy runtime
  - pre-`009` buyer-preference reads fall back safely and writes fail with a deterministic `409` guard instead of `500`
- Agent 3 validation/docs/check work is landed:
  - preference canary validates exact expected provider identity and supports an optional second buyer-key scenario
  - checks runner backfills `DATABASE_URL`/`INNIES_ORG_ID` from `api/.env` when those values are missing from `scripts/.env.local`
  - OpenClaw matrix check uses the documented env shape and skips cleanly when compat mode or token-B coverage is unavailable
  - API/onboarding/query docs now describe the current route-decision and wrapper-resolution contract
- `cd api && npm test` passed (`85` tests)
- `cd api && npm run build` passed
- live checks passed against local API + DB:
  - `bash api/scripts/token_mode_manual_check.sh` (`usage_ledger_row_id` + `audit_log_row_id` confirmed)
  - `bash api/scripts/provider_preference_canary.sh` (`provider_preferred=anthropic`, `provider_effective=anthropic`, pinned-session guard passed)
  - broad script-runner validation previously passed before the script surface was reduced to focused commands

## Open Findings

### [High] CLI session pinning is not wired from the real wrapper into proxy routing
- Area: cli + api
- Summary: proxy runtime now pins only on compat mode or an explicit pin signal, but the actual `innies claude` wrapper only injects env vars and does not emit the pin signal that routing consumes.
- Evidence:
  - `cli/src/commands/claude.js:93`
  - `api/src/routes/proxy.ts:214`
  - `api/src/routes/proxy.ts:2182`
  - `docs/CLI_UX.md:21`
- Impact: real `innies claude` sessions do not actually hit the `cli_provider_pinned` path, so the “stay pinned for the session” contract is not implemented end-to-end for the shipped CLI.
- Required fix:
  - wire the wrapper/client path to emit `x-innies-provider-pin: true` or equivalent request metadata for pinned sessions
  - add an end-to-end smoke/integration check proving `innies claude` requests produce `cli_provider_pinned`
- Suggested owner: Agent 1 + Agent 3
- Validation:
  - run a real `innies claude` session through Innies
  - confirm routing events for that session emit `reason=cli_provider_pinned`

## Recommended Patch Order
1. Agent 1 + Agent 3: wire real CLI/session pin signals end-to-end so wrapper behavior matches routing policy.

## Exit Criteria
- Real `innies claude`/pinned-session traffic emits `cli_provider_pinned` in routing events.

## Notes
- Earlier findings about env-backed runtime preference, generic request-body pinning, `codex` routing parity, and preflight fallback handling are now addressed in code.
- Earlier finding about API-key auth lookup rollout risk is addressed for `findActiveByHash()`.
- Agent 2 follow-ups for default-provider runtime alignment and buyer-preference admin migration safety are now addressed in code and tests.
- Earlier follow-up about stale API/validation/query docs is addressed in the latest Agent 3 docs pass.
- Earlier follow-up about the preference canary missing the explicit pin signal is addressed in the latest Agent 3 check-script pass.
- Earlier follow-up about the preference canary not asserting expected provider identity is addressed in the latest Agent 3 canary pass.
- Earlier follow-up about broad check-runner / OpenClaw env compatibility was addressed before the script surface was reduced to focused commands.
- Earlier follow-up about Claude OAuth wrapper recursion and the null-session query bucket is addressed in the latest Agent 3 docs/query pass.
- This document tracks only the remaining follow-up work after the latest audit.
