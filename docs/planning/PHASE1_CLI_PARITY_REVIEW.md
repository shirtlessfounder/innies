# Phase 1 CLI Parity Review

Review date: 2026-03-06

Scope:
- post-implementation audit of CLI parity work across Agent 1 / 2 / 3
- focus on regressions, contract mismatches, validation gaps, and doc drift

## Findings

### 1) High: config migration/write path still breaks provider parity for Codex
The current config compatibility strategy can feed Anthropic-oriented legacy values directly into the Codex lane.

Evidence:
- [cli/src/config.js](/Users/dylanvu/innies/cli/src/config.js#L34) treats legacy `defaultModel` as the fallback for both provider lanes
- [cli/src/config.js](/Users/dylanvu/innies/cli/src/config.js#L89) writes explicit `login --model` values into both `providerDefaults.anthropic` and `providerDefaults.openai`
- [cli/src/commands/codex.js](/Users/dylanvu/innies/cli/src/commands/codex.js#L46) always injects the resolved OpenAI/Codex model into the Codex wrapper argv
- this violates the backward-compatible provider-default contract in [PHASE1_CLI_PARITY_SCOPE.md](/Users/dylanvu/innies/docs/planning/PHASE1_CLI_PARITY_SCOPE.md#L138)

Confirmed local reproductions:
- legacy `.headroom/config.json` with `defaultModel: "innies/default"` made `innies codex` launch with `--model innies/default`
- `innies login --model claude-opus-4-6` made `innies codex` launch with `--model claude-opus-4-6`

Impact:
- existing users can land in a broken Codex lane after upgrade with no manual action
- `login --model` currently seeds an Anthropic model into the OpenAI/Codex wrapper path
- this breaks the “no manual config surgery” goal for parity rollout

### 2) High: CLI smoke gate is currently failing
The advertised CLI validation gate is red.

Evidence:
- `bash cli/scripts/smoke.sh` fails with `smoke: token auth failure hint missing or unclear`
- [cli/scripts/smoke.sh](/Users/dylanvu/innies/cli/scripts/smoke.sh#L157) still expects the old wording:
  - `Innies hint: Token auth failed: token mode is not enabled for this org.`
- [cli/src/commands/wrapperRuntime.js](/Users/dylanvu/innies/cli/src/commands/wrapperRuntime.js#L84) now emits different shared guidance text:
  - `Innies hint: Token mode is not enabled for this org. Ask an operator to add the org to TOKEN_MODE_ENABLED_ORGS.`

Impact:
- branch does not currently pass its own smoke gate
- pilot readiness is overstated until smoke expectations are updated or guidance text is aligned

### 3) Medium: `innies codex` does not properly detect `--model=<id>` overrides
[cli/src/commands/codex.js](/Users/dylanvu/innies/cli/src/commands/codex.js#L15) only detects explicit model flags when they appear as separate argv tokens (`-m` or `--model`).

Evidence:
- [cli/src/commands/codex.js](/Users/dylanvu/innies/cli/src/commands/codex.js#L29) still injects `--model <default>` when the user passes `--model=<id>`
- reproduced wrapper argv included both:
  - `--model gpt-5.4`
  - `--model=gpt-4.1-mini`

Impact:
- user-provided model override may be ignored
- Codex may error on duplicate/conflicting model flags depending on its parser behavior

### 4) Medium: smoke coverage still does not execute the Codex wrapper path
The smoke suite now checks Codex binary readiness through `doctor`, but it does not actually invoke `innies codex`.

Evidence:
- [cli/scripts/smoke.sh](/Users/dylanvu/innies/cli/scripts/smoke.sh#L66) creates a fake `codex` binary
- [cli/scripts/smoke.sh](/Users/dylanvu/innies/cli/scripts/smoke.sh#L79) only uses it indirectly via `innies doctor`
- there is no wrapped Codex session covering:
  - [cli/src/commands/codex.js](/Users/dylanvu/innies/cli/src/commands/codex.js#L19) arg rewriting
  - [cli/src/commands/codex.js](/Users/dylanvu/innies/cli/src/commands/codex.js#L59) env wiring
  - [cli/src/commands/codex.js](/Users/dylanvu/innies/cli/src/commands/codex.js#L73) capture/error path

Impact:
- the new Codex lane can regress without the smoke suite noticing
- the `--model=<id>` bug above slipped through for exactly this reason

### 5) Low: durable docs are behind shipped behavior
Several docs still describe `innies codex` as unimplemented even though the runtime now exists.

Evidence:
- [docs/CLI_UX.md](/Users/dylanvu/innies/docs/CLI_UX.md#L50) still says `innies codex` exits with a scaffold message
- [docs/onboarding/CLI_ONBOARDING.md](/Users/dylanvu/innies/docs/onboarding/CLI_ONBOARDING.md#L10) still warns Codex may only show a scaffold message
- [docs/planning/PHASE1_CLI_PARITY_SCOPE.md](/Users/dylanvu/innies/docs/planning/PHASE1_CLI_PARITY_SCOPE.md#L29) still says `innies codex` does not exist yet

Impact:
- reviewers and internal users get an inaccurate picture of what is actually shipped
- planning and durable UX docs now disagree with runtime reality

## Verification

Commands run:

```bash
bash cli/scripts/smoke.sh
cd api && npx vitest run tests/proxy.tokenMode.route.test.ts
```

Results:
- CLI smoke: failed on token-mode hint string mismatch
- token-mode proxy tests: passed (`24/24`)

Additional manual probe:
- executed `innies codex` with a fake `codex` binary
- confirmed wrapper env/argv injection works at a basic level
- reproduced legacy-config Codex launch with `--model innies/default`
- reproduced `login --model claude-opus-4-6` causing Codex launch with `--model claude-opus-4-6`
- reproduced duplicate model flags when passing `--model=<id>`

## Recommended Follow-Up
1. Fix the config compatibility/write strategy so the Codex lane cannot inherit Anthropic-only model ids from legacy configs or `login --model`.
2. Fix the smoke mismatch so the branch passes its own gate again.
3. Harden Codex model-override detection to handle `--model=<id>` and equivalent forms.
4. Add real wrapped-session smoke coverage for `innies codex`.
5. Update durable docs once the current Codex behavior is the intended shipped contract.
