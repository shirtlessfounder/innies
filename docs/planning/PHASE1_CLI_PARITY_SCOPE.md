# Phase 1 CLI Parity Scope

## Purpose
Isolated planning scope for Phase 1 feature `4) CLI support`.

Use this file to plan and execute the provider-specific CLI wrapper work without mixing it with dashboard or analytics work. This is a feature-level scope document, not a replacement for the phase plan.

## Planning Hierarchy
- `docs/planning/ROADMAP.md` remains the sequence/priority document.
- `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md` remains the Phase 1 source of truth.
- This file is the isolated execution scope for Phase 1 feature `4) CLI support`.
- `docs/planning/PHASE1_CLI_PARITY_EXECUTION.md` is the 3-agent execution split for this feature.
- Durable shipped runtime behavior belongs in `docs/CLI_UX.md` and `docs/API_CONTRACT.md`.

If this file conflicts with the parent Phase 1 plan or the API contract, update this file to match the parent docs.

## Objective
Ship true wrapper parity for internal coding workflows:
- `innies claude`
- `innies codex`

Both wrappers should feel like provider-specific entrypoints into the same Innies-backed token pool:
- one shared Innies buyer token
- one shared CLI install
- deterministic provider pinning per wrapper
- normal coding-loop UX
- actionable troubleshooting when routing/auth/capacity issues happen

## Current State Snapshot (2026-03-06)
- `innies claude` exists.
- `innies codex` now exists as a provider-pinned Codex/OpenAI wrapper lane.
- `innies doctor` now reports Claude and Codex lane readiness separately.
- CLI help/usage text now exposes both wrapper entrypoints.
- Local smoke coverage now exercises the Claude wrapper path and basic Codex wrapper path.
- API routing can honor explicit provider-pin signals and emits `cli_provider_pinned` when a recognized pin signal is present.
- Claude already has backend-side pin recognition heuristics.
- Codex now has a wrapper-to-backend pinning/correlation contract via `env_http_headers`.
- Backend Codex/OpenAI token-mode support already exists, including ChatGPT Codex backend routing and refresh behavior.

## Desired User Outcome
Internal users should be able to:
1. Run `innies login --token ...` once.
2. Run `innies doctor` and see readiness for both Claude and Codex lanes.
3. Start a Claude coding session with `innies claude`.
4. Start a Codex coding session with `innies codex`.
5. Get routing that stays on the expected provider lane for the whole session.
6. Get useful hints when failures are caused by auth, capacity, or org token-mode setup.

## Scope

### Command Surface Required For Phase 1 Exit
- `innies login --token <in_token> [--base-url <url>] [--model <id>]`
- `innies doctor`
- `innies claude [-- <claude args...>]`
- `innies codex [-- <codex args...>]`
- `innies link claude`

### Command Surface Explicitly Not Required For This Slice
- `innies link codex`
- generic preference-routed entrypoints such as `innies chat`
- CLI-managed OAuth setup/productization such as `innies auth setup`
- install/update flows for Claude or Codex upstream binaries

### Wrapper Runtime Contract
Both wrappers must provide:
- argument passthrough after `--`
- TTY-preserving execution by default
- exit-code parity with the wrapped binary
- one-line runtime status output with proxy target and correlation/request id
- binary resolution that prefers the real upstream binary, not the Innies wrapper
- recursion guard to prevent wrapper loops
- clear startup failure when the expected upstream binary cannot be found

### Binary Resolution Contract
Claude lane:
- support `INNIES_CLAUDE_BIN`
- support recursion guard `INNIES_CLAUDE_WRAPPED`

Codex lane:
- support `INNIES_CODEX_BIN`
- support recursion guard `INNIES_CODEX_WRAPPED`

### Environment Wiring Contract
Shared Innies wiring:
- `INNIES_TOKEN`
- `INNIES_API_BASE_URL`
- `INNIES_PROXY_URL`
- `INNIES_MODEL`
- `INNIES_CORRELATION_ID`

Provider-native env wiring:
- Claude wrapper must set the provider-native env vars required for Claude CLI to route through Innies.
- Codex wrapper must set the provider-native env vars required for Codex CLI to route through Innies.

Implementation requirement:
- do not rely on buyer-key provider preference for wrapper routing
- wrappers must send or imply an explicit provider pin signal so routed traffic is recorded as `cli_provider_pinned`

Planning note:
- Codex binary env contract is resolved (see First Implementation Checkpoint below).
- Codex natively supports `OPENAI_BASE_URL`, bearer token injection, and custom headers via `env_http_headers`.
- Codex uses `wire_api = "responses"` (OpenAI Responses API) — traffic goes through `/v1/proxy/*`, not the compat translation layer.
- Pinning/correlation: wrapper sets env var → codex injects as request header via `env_http_headers` config.

### Routing Contract
- `innies claude` hard-pins the Anthropic lane for the session.
- `innies codex` hard-pins the Codex/OpenAI lane for the session.
- provider pin takes precedence over buyer-key provider preference
- no mid-session provider flip inside provider-specific wrappers
- validation evidence must show `cli_provider_pinned` routing, not preference-selected routing

### Pinning + Correlation Contract
Phase 1 exit requires a real Codex pinning path, not an assumed one.

Required outcomes:
- wrapper-driven Claude traffic can be identified as pinned
- wrapper-driven Codex traffic can be identified as pinned
- validation can correlate wrapper execution with Innies-side routing evidence

Preferred implementation:
- wrapper-generated correlation id propagates to Innies as `x-request-id`
- wrapper traffic carries an explicit pin signal Innies recognizes directly

Minimum acceptable fallback:
- if the upstream CLI cannot emit the preferred header/metadata shape, this feature must add an alternative wrapper-to-Innies correlation/pin path before claiming parity

Non-acceptable outcome:
- shipping `innies codex` without a backend-recognized mechanism that can produce `cli_provider_pinned`

### Config Contract
Stable requirements:
- config path remains `~/.innies/config.json`
- existing `~/.innies/config.json` configs must remain readable
- legacy `~/.headroom/config.json` configs must remain readable
- `innies login` remains the only required login/setup step for Phase 1

Allowed change:
- config shape may expand if needed for provider-specific model defaults, but any change must be backward-compatible with existing config written by current `innies login`

Planning constraint:
- do not silently break existing `version: 1` config files
- if config migration is introduced, it must be automatic or clearly documented before ship

Locked Phase 1 decision:
- CLI parity will adopt provider-scoped default models in config.
- Existing single-field `defaultModel` remains supported on read as a backward-compatible fallback.
- When a legacy config is read, that single `defaultModel` is treated as the fallback/default for both provider lanes until provider-scoped defaults are written.
- `innies login --model` remains supported and may seed the shared fallback or both provider defaults during migration/write paths, but the implementation must not require manual config surgery for existing users.
- Unknown model ids must not silently rewrite both provider defaults; if provider family cannot be inferred, preserve the value as fallback metadata only.

### Model Default Contract
- Anthropic wrapper uses the Anthropic default model
- Codex wrapper uses the Codex/OpenAI default model
- model selection remains config-driven, not hard-coded in the wrapper behavior contract
- provider-scoped model defaults are the target state for Phase 1 parity
- legacy single-model config is compatibility input, not the desired steady-state shape

### Doctor Contract
`innies doctor` must report readiness for both lanes separately.

Required checks:
- Innies config exists and is readable
- buyer token present
- Claude binary available in `PATH` or via override
- Codex binary available in `PATH` or via override
- Claude wrapper link presence remains warning-only

Not required:
- no `codex` link/wrapper warning is required for Phase 1

Exit semantics:
- `innies doctor` exits non-zero if either required wrapper lane is not ready
- output should remain lane-specific so the failing side is obvious

### Error UX Contract
Wrappers should produce actionable hints for:
- token mode not enabled for org
- unauthorized / invalid upstream credential
- likely expired upstream credential
- capacity unavailable / no eligible credential
- wrapper recursion
- missing upstream binary

Requirement:
- prefer short operator-style hints
- avoid opaque Innies-only jargon without a next action

## Work Packages

### 1) Command + Config Parity
Deliverables:
- add `innies codex` command
- update CLI usage/help text for both wrappers
- implement backward-compatible provider-scoped default model handling
- preserve read compatibility with existing `.innies` and legacy `.headroom` configs

Done when:
- both commands are visible in CLI usage
- both commands can load config successfully
- existing users with current config are not broken

### 2) Runtime Wiring + Pinning
Deliverables:
- codex wrapper runtime wiring
- codex binary resolution + recursion guard
- explicit pinned-provider routing signal for both wrappers
- minimal API/request-shaping work if needed so Codex traffic can actually produce `cli_provider_pinned`
- provider-specific default model selection behavior

Done when:
- both wrappers route into the intended provider lane
- pinned sessions do not flip providers
- routing evidence shows `cli_provider_pinned`

### 3) Readiness + Troubleshooting Parity
Deliverables:
- `innies doctor` parity across Claude and Codex lanes
- provider-specific startup and failure hints
- clear missing-binary and recursion errors

Done when:
- doctor output is no longer Claude-only
- common failure states point to an immediate next action

### 4) Validation Harness
Deliverables:
- local fake-binary smoke coverage for both wrappers
- real-env proof mode for both wrappers
- evidence capture format for request correlation and routing attribution

Done when:
- smoke suite covers both lanes
- real-env proof exists for both lanes

### 5) Docs Parity
Deliverables:
- `docs/CLI_UX.md` updated to reflect shipped command surface
- internal runbook examples for both wrappers
- troubleshooting section includes both lanes

Done when:
- CLI docs match shipped behavior
- no doc still implies Claude is the only supported wrapper lane

## Validation Plan

### Local Validation
- fake Claude binary smoke path
- fake Codex binary smoke path
- verify passthrough args
- verify env injection
- verify recursion guards
- verify doctor output
- verify actionable failure hint output

### Real-Env Validation
For each wrapper:
- run one successful routed request against `/v1/proxy/*`
- capture Innies-side correlation evidence
- capture token-credential attribution header or equivalent routing evidence
- verify pinned-provider routing reason is `cli_provider_pinned`

Canonical proof sources:
- server logs
- `in_routing_events`
- response headers when available

Validation rule:
- wrapper stdout alone is not sufficient proof
- preferred proof path is wrapper correlation id -> Innies `x-request-id` -> server-side evidence
- if direct `x-request-id` propagation is not feasible for Codex on the current binary contract, this feature must add another explicit correlation path before Phase 1 exit

### Live Session Validation
For each wrapper:
- at least one real coding-session check by Dylan on his local machine
- confirm no wrapper-induced stalls
- confirm session remains on the intended provider lane
- Phase 1 is internal-only — Dylan's machine is the validation surface, not a QA matrix

## Done Criteria
- `innies claude` and `innies codex` both exist and are usable
- both wrappers preserve normal CLI session behavior
- provider pinning is deterministic and observable
- `innies doctor` covers both lanes
- local smoke and real-env proof exist for both lanes
- CLI docs are updated only after behavior is real

## Out of Scope
- OpenClaw integration changes
- buyer-key preference routing changes for model-agnostic clients
- dashboard work
- per-token analytics work
- OAuth onboarding productization
- external/friends-and-family onboarding

## Early Discovery Tasks
These are discovery tasks inside the feature scope, not unresolved product-direction questions:
- prove the exact Codex env/base-url contract needed to route through Innies cleanly
- prove the exact Codex-side mechanism that can carry pinning and request correlation
- if the current Codex binary cannot carry the preferred header/metadata shape, define the minimum API/request-shaping support needed for parity
- confirm how provider-scoped defaults are written while preserving version 1 and legacy config readability

## First Implementation Checkpoint
Resolve these before coding deeper than command scaffolding:

### ✅ Codex binary env contract (RESOLVED 2026-03-06)
Source: https://developers.openai.com/codex/config-reference/, config-advanced/, config-sample/

**Base URL override:**
- `OPENAI_BASE_URL` env var overrides the default OpenAI endpoint. No config file change needed.
- Alternatively: `[model_providers.openai] base_url = "..."` in `~/.codex/config.toml`.

**Auth:**
- `experimental_bearer_token` in config for direct bearer token injection.
- `env_key` on model providers reads an API key from a named env var.
- Standard OpenAI OAuth auth is the default path.

**Custom headers:**
- `http_headers = { "X-Example" = "value" }` — static headers per model provider.
- `env_http_headers = { "Header-Name" = "ENV_VAR_NAME" }` — headers populated from env vars at runtime.
- This is the pinning/correlation mechanism: wrapper sets an env var, codex injects it as a request header.

**Wire API:**
- Codex uses `wire_api = "responses"` by default (OpenAI Responses API).
- `innies codex` is intended to use native OpenAI Responses semantics, NOT the Anthropic compat translation path.
- Current Innies proxy contract still uses the `/v1/proxy/*` wrapper-body ingress described in `docs/API_CONTRACT.md`.
- If the shipped Codex wrapper emits a request shape that does not fit that current ingress contract directly, minimum ingress-compatibility/API work is in scope for this feature.
- Translation only matters for `innies claude` → openai fallback scenarios.

**CLI overrides:**
- `codex --model gpt-5.4` — dedicated model flag.
- `codex --config key=value` — arbitrary TOML key override per run.
- `codex --profile <name>` — named config profile.

**Wrapper approach:** confirmed viable. `innies codex` sets `OPENAI_BASE_URL` + bearer token env vars, codex routes through innies transparently. Same pattern as `innies claude`.

### Remaining checkpoints
- Codex wrapper invocation contract (scaffolding can proceed based on resolved env contract above)
- pinned-routing implementation strategy: use `env_http_headers` to inject `x-request-id` or a custom pin header from `INNIES_CORRELATION_ID`
- provider-scoped config/default-model write strategy
- concrete server-side proof workflow for wrapped-session validation
