# Phase 1 CLI Parity Review

Status: historical audit artifact. The issues recorded during parity bring-up were resolved on the current branch.

Canonical docs:
- `docs/CLI_UX.md`
- `docs/onboarding/CLI_ONBOARDING.md`
- `docs/planning/PHASE1_CLI_PARITY_SCOPE.md`

Resolved items:
- config migration/write behavior no longer poisons the Codex lane with Anthropic-only or sentinel model ids
- `innies codex` no longer injects a duplicate default model when the user passes `--model=<id>`
- local fake-binary smoke now exercises both wrapper lanes and the shared token-mode hint path
- durable CLI docs now reflect the shipped Codex wrapper behavior

Verification:

```bash
cd cli && npm run test:unit
cd cli && bash scripts/smoke.sh
cd api && npx vitest run tests/proxy.tokenMode.route.test.ts
```

Latest verification outcome on this branch:
- CLI unit tests passing
- CLI smoke passing
- proxy token-mode route tests passing (`24/24`)
