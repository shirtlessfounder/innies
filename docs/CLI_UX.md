# Innies CLI UX (Checkpoint 1)

## Commands

### `innies login --token <in_token> [--base-url <url>] [--model <id>]`
Persists local Innies config in `~/.innies/config.json`.

- validates token format (`in_...`)
- stores token + API base URL + fallback model + provider-scoped defaults
- `--model <id>` seeds the matching provider lane when the model family is recognized
- unknown model ids are preserved as fallback metadata and do not rewrite provider defaults
- file mode target: user-only (`0600`)

### `innies doctor`
Performs local health checks and exits non-zero on failure.

Exit behavior:
- exits non-zero if any required local lane dependency is missing
- output stays per-check so the failing lane is obvious

Checks:
- local config exists and is readable
- token present
- `claude` command available in `PATH` or via `INNIES_CLAUDE_BIN`
- `codex` command available in `PATH` or via `INNIES_CODEX_BIN`
- `~/.local/bin/claude` wrapper presence (warning only; optional convenience link)

Config summary:
- prints Claude and Codex proxy endpoints
- prints fallback model
- prints provider defaults for `anthropic` and `openai`

### `innies claude [-- <claude args...>]`
Wraps Claude CLI execution and injects Innies env wiring.

Injected environment:
- `INNIES_TOKEN`
- `INNIES_API_BASE_URL`
- `INNIES_PROXY_URL`
- `INNIES_MODEL`
- `INNIES_CORRELATION_ID`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

Behavior:
- forwards all args to `claude`
- exits with the same exit code as `claude`
- prints actionable error if `claude` cannot start
- starts a loopback HTTP bridge and points `ANTHROPIC_BASE_URL` at it
- bridge injects `x-api-key` and `x-innies-provider-pin: true` for forwarded Innies requests
- bridge preserves Claude-supplied `x-request-id` when present; otherwise it mints a unique per-request id scoped to the wrapped session
- bridge strips Claude.ai OAuth `Authorization` before forwarding to Innies so active claude.ai sessions do not break buyer-key auth
- bridge rewrites Anthropic compat request bodies to the wrapped session model so Claude subagents stay on the same pinned model lane
- loop-safe binary resolution:
  - prefers non-wrapper Claude binary from `which -a claude`
  - supports `INNIES_CLAUDE_BIN` override
- recursion guard via `INNIES_CLAUDE_WRAPPED`
- prints one-line runtime status (model/proxy/request-id) to stderr so stdout stays clean for `-p` / exact-output flows

### `innies codex [-- <codex args...>]`
Wraps Codex CLI execution and injects Innies env/config wiring for the Codex/OpenAI lane.

Injected environment:
- `INNIES_TOKEN`
- `INNIES_API_BASE_URL`
- `INNIES_PROXY_URL`
- `INNIES_MODEL`
- `INNIES_CORRELATION_ID`
- `INNIES_PROVIDER_PIN`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

Behavior:
- forwards all args to `codex`
- exits with the same exit code as `codex`
- prints actionable error if `codex` cannot start
- prepends Codex config overrides for:
  - `model_provider="innies"` (custom Codex provider id; avoids the built-in `openai` provider path)
  - `model_providers.innies.base_url="<innies>/v1/proxy/v1"`
  - `model_providers.innies.env_key="OPENAI_API_KEY"`
  - `model_providers.innies.wire_api="responses"`
  - `model_providers.innies.requires_openai_auth=false`
  - `model_providers.innies.supports_websockets=false`
  - `responses_websockets_v2=false`
  - `model_providers.innies.env_http_headers."x-request-id"="INNIES_CORRELATION_ID"`
  - `model_providers.innies.env_http_headers."x-innies-provider-pin"="INNIES_PROVIDER_PIN"`
- injects the provider default OpenAI/Codex model when no explicit `-m`, `--model <id>`, or `--model=<id>` override is supplied
- loop-safe binary resolution:
  - prefers non-wrapper Codex binary from `which -a codex`
  - supports `INNIES_CODEX_BIN` override
- recursion guard via `INNIES_CODEX_WRAPPED`
- prints one-line runtime status (model/proxy/request-id) to stderr so stdout stays clean for exact-output flows

### `innies link claude`
Creates wrapper shim at `~/.local/bin/claude`:
- `exec innies claude "$@"`

This allows normal `claude` usage to route through Innies if `~/.local/bin` appears before other Claude paths in `PATH`.

Safety behavior:
- refuses to overwrite an existing non-Innies `~/.local/bin/claude`
- if `~/.local/bin/claude` is already occupied by a real Claude install, use `innies claude` directly or move the original binary before linking

### `innies unlink claude`
Removes the managed `~/.local/bin/claude` wrapper created by `innies link claude`.

Safety behavior:
- refuses to remove a non-Innies `~/.local/bin/claude`
- if the wrapper is already absent, exits cleanly and reports the path

## Error UX
- Missing login: `Run: innies login --token <in_token>`
- Missing token flag: `Missing --token`
- Invalid token format: `Token must start with in_`
- Missing/invalid config: points user to login

## Smoke Test
Run:

```bash
cd cli
npm run test:smoke
```

Smoke test validates:
- login writes config
- doctor reports OK for fake Claude and Codex binaries
- claude wrapper forwards args and injects env
- codex wrapper forwards args and injects env/config overrides
- link command writes wrapper shim
- token-mode route marker is injected (`INNIES_ROUTE_MODE=token`)
- non-streaming proxy compatibility check validates provider-native 2xx/4xx pass-through semantics
- idempotency policy compatibility check validates deterministic non-envelope replay error contract
- token auth failure class emits actionable CLI hint (`not-enabled` case) for both wrappers
- CLI keeps interactive TTY behavior by default (capture mode is opt-in for smoke)

Required for pilot signoff: real backend token-route proof

Current scope note:
- local fake-binary smoke executes wrapped Claude and Codex sessions
- the real-env smoke path below is direct proxy/token-route evidence
- real wrapped-session pilot checks are still recommended per wrapper

Run in pilot/staging env with valid API credentials:

```bash
cd cli
INNIES_SMOKE_API_URL=https://api.innies.computer \
INNIES_SMOKE_API_KEY=in_live_<api_key> \
INNIES_SMOKE_IDEMPOTENCY_KEY=11111111-1111-7111-8111-111111111111 \
npm run test:smoke:real
```

Expected proof: response includes `x-innies-token-credential-id` header.

## Token-Mode Runbook (C1)
Daily path for internal pilot users:

```bash
innies login --token in_live_<redacted> --base-url https://api.innies.computer
innies doctor
innies claude -- --version
innies codex -- --help
innies claude -- "summarize this repo"
innies codex -- "summarize this repo"
```

Expected:
- runtime line shows proxy URL + request id
- requests route to `/v1/proxy/*` via token-mode path
- on token auth issues, CLI prints one of:
  - expired token guidance
  - unauthorized token guidance
  - token-mode not-enabled guidance

## 4-User Pilot Checklist (Daily)
- Run `innies doctor`
- Run one non-streaming `innies claude -- "<task>"`
- Run one non-streaming `innies codex -- "<task>"`
- Run `npm run test:smoke:real` once per pilot day in staging/prod-like env and archive output
- If failure occurs, record:
  - timestamp
  - request id from runtime line
  - CLI hint text (expired/unauthorized/not-enabled)
  - org + model used

## UI Shell Runtime
Minimal dashboard shell now runs as a standalone Next.js app:

```bash
cd ui
npm install
npm run dev
```
