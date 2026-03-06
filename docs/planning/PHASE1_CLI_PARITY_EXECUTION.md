# Phase 1 CLI Parity Execution

## Purpose
Execution document for Phase 1 feature `4) CLI support`.

This file turns the CLI parity scope into an explicit 3-agent work split with a shared contract checkpoint, merge order, and handoff boundaries.

## Planning Hierarchy
- `docs/planning/ROADMAP.md` remains the sequence/priority document.
- `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md` remains the Phase 1 source of truth.
- `docs/planning/PHASE1_CLI_PARITY_SCOPE.md` remains the isolated feature scope.
- This file is the execution split for that isolated feature scope.

## Execution Rule
Do not let the agents invent conflicting contracts in parallel.

Before deeper implementation, run one short shared checkpoint and lock:
- config read/write contract
- pinning/correlation contract
- validation proof contract

## Shared Contract Checkpoint

### 1) Config Contract
Lock before parallel work:
- existing `~/.innies/config.json` remains readable
- legacy `~/.headroom/config.json` remains readable
- provider-scoped model defaults are the new write target
- legacy single `defaultModel` remains a read-compatible fallback
- `innies login --model` remains supported

Primary files:
- `cli/src/config.js`
- `cli/src/commands/login.js`
- `cli/src/utils.js`

### 2) Pinning + Correlation Contract
Lock before parallel work:
- preferred path: wrapper-generated correlation id propagates to Innies as `x-request-id`
- acceptable fallback: an alternate explicit correlation path, if the upstream CLI cannot emit the preferred header shape directly
- wrapper traffic must carry a backend-recognized pin signal
- success criterion is Innies-side routing evidence with `cli_provider_pinned`
- if Codex cannot emit the preferred header shape directly, minimal request-shaping/API work is in scope

Primary files:
- `cli/src/commands/claude.js`
- `cli/src/commands/codex.js`
- `api/src/routes/proxy.ts`

### 3) Validation Proof Contract
Lock before parallel work:
- wrapper stdout is not sufficient proof
- canonical proof sources are:
  - server logs
  - `in_routing_events`
  - response headers when available
- real-env proof must connect wrapper execution to Innies-side evidence

Primary files:
- `cli/scripts/smoke.sh`
- `docs/CLI_UX.md`

## Agent Split

### Agent 1: Command + Config Parity
Owner:
- command surface
- config compatibility
- provider-scoped model defaults

Scope:
- add `innies codex` command to the CLI entrypoint
- update CLI usage/help text so both wrappers are first-class
- evolve config handling to support provider-scoped model defaults
- preserve read compatibility for:
  - current `.innies` config
  - legacy `.headroom` config
- define how `innies login --model` behaves during compatibility/migration

Primary files:
- `cli/src/index.js`
- `cli/src/config.js`
- `cli/src/commands/login.js`
- `cli/src/utils.js`

Deliverables:
- `innies codex` command is visible in usage/help
- config read path supports old and new shapes
- config write path supports provider-scoped defaults

Definition of done:
- both wrapper commands can load config successfully
- existing users do not need manual config edits
- provider-specific defaults have a clear write strategy

### Agent 2: Runtime Wiring + Pinning
Owner:
- wrapper runtime behavior
- binary resolution
- provider pinning
- correlation propagation
- native Codex ingress compatibility, if required by the chosen wrapper approach
- durable API contract updates when runtime/API behavior changes

Scope:
- implement `cli/src/commands/codex.js`
- keep `innies claude` aligned with the same wrapper contract where needed
- wire Codex base URL override and auth env behavior
- implement Codex binary resolution and recursion guard
- ensure both wrappers emit a recognized pin signal
- ensure both wrappers propagate request correlation in a validation-visible way
- add minimal API/request-shaping support if Codex cannot otherwise produce `cli_provider_pinned`
- add minimal native Codex ingress compatibility if the current `/v1/proxy/*` wrapper-body contract cannot accept the chosen Codex request shape directly
- update `docs/API_CONTRACT.md` for any shipped ingress, pinning, or correlation behavior changes

Primary files:
- `cli/src/commands/claude.js`
- `cli/src/commands/codex.js`
- `api/src/routes/proxy.ts`
- any minimal supporting API utility touched for pin/correlation handling
- `docs/API_CONTRACT.md` when runtime/API behavior changes

Deliverables:
- `innies claude` stays Anthropic-pinned
- `innies codex` stays Codex/OpenAI-pinned
- Innies routing evidence shows `cli_provider_pinned` for both lanes
- Codex ingress path is compatible with the actual request shape emitted by the shipped wrapper

Definition of done:
- both wrappers route into the intended provider lane
- pinned sessions do not flip providers
- correlation/pinning proof path is real, not implied

### Agent 3: Readiness + Validation + Docs
Owner:
- doctor parity
- smoke coverage
- proof workflow
- shipped CLI docs

Scope:
- expand `innies doctor` to report both Claude and Codex lane readiness
- keep lane-specific output and non-zero exit if either required lane is broken
- extend smoke coverage to exercise fake Claude and fake Codex binaries
- define and document the real-env proof workflow
- update CLI docs only after behavior is real

Primary files:
- `cli/src/commands/doctor.js`
- `cli/scripts/smoke.sh`
- `docs/CLI_UX.md`

Deliverables:
- doctor output is no longer Claude-only
- smoke suite covers both wrappers
- real-env proof steps are executable and explicit
- CLI docs match shipped behavior

Definition of done:
- validation surfaces cover both lanes
- docs no longer imply Claude is the only supported wrapper lane

## Cross-Agent Contract Checkpoint
Run before merge:
- config shape agreement:
  - read compatibility
  - write target
  - login behavior
- routing agreement:
  - exact pin signal
  - exact correlation propagation path
  - expected `cli_provider_pinned` evidence
- validation agreement:
  - where proof comes from
  - what counts as sufficient evidence

## Merge Order
Recommended merge sequence:
1. Agent 1
2. Agent 2
3. Agent 3

Reason:
- Agent 1 locks the config contract first.
- Agent 2 depends on the final runtime/config contract.
- Agent 3 should validate the actual merged command/runtime behavior, not a moving target.
- This is merge order into the feature branch, not separate shipped feature commits.
- Phase 1 still expects one atomic feature commit or equivalent atomic feature landing after validation.

## Validation Gate
Before feature signoff:
- local smoke covers both wrappers
- real-env proof exists for both wrappers
- request correlation can be tied to Innies-side evidence
- routing reason is `cli_provider_pinned` for both wrappers
- `innies doctor` fails when either lane is not ready
- Dylan completes at least one real local coding-session check per wrapper

## Non-Goals
- generic preference-routed CLI entrypoint
- `innies link codex` as a Phase 1 requirement
- OAuth onboarding productization
- dashboard or analytics work

## Handoff Notes
If the agents discover that Codex cannot emit the required headers through the documented config/env path, stop treating the remaining work as CLI-only. In that case, fold the minimum necessary API/request-shaping changes into Agent 2 and update `docs/planning/PHASE1_CLI_PARITY_SCOPE.md` before continuing.

If the agents discover that the current `/v1/proxy/*` wrapper-body ingress cannot accept the actual Codex request shape used by the shipped wrapper path, Agent 2 owns the minimum ingress compatibility work and the corresponding `docs/API_CONTRACT.md` update.
