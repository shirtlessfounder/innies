# Innies CLI UX (Checkpoint 1)

## Commands

### `innies login --token <in_token> [--base-url <url>] [--model <id>]`
Persists local Innies config in `~/.innies/config.json`.

- validates token format (`in_...`)
- stores token + API base URL + default model
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
- loop-safe binary resolution:
  - prefers non-wrapper Claude binary from `which -a claude`
  - supports `INNIES_CLAUDE_BIN` override
- recursion guard via `INNIES_CLAUDE_WRAPPED`
- prints one-line runtime status (model/proxy/request-id)

### `innies codex [-- <codex args...>]`
Current branch behavior:
- command is present in CLI help/usage
- loads Innies config and resolves the OpenAI/Codex provider default model
- exits non-zero with a scaffold message until Codex runtime wiring is implemented

### `innies link claude`
Creates wrapper shim at `~/.local/bin/claude`:
- `exec innies claude "$@"`

This allows normal `claude` usage to route through Innies if `~/.local/bin` appears before other Claude paths in `PATH`.

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
- Codex readiness probe is covered through `innies doctor`; wrapped Codex-session smoke begins once runtime wiring exists
- link command writes wrapper shim
- token-mode route marker is injected (`INNIES_ROUTE_MODE=token`)
- non-streaming proxy compatibility check validates provider-native 2xx/4xx pass-through semantics
- idempotency policy compatibility check validates deterministic non-envelope replay error contract
- token auth failure class emits actionable CLI hint (`not-enabled` case)
- CLI keeps interactive TTY behavior by default (capture mode is opt-in for smoke)

Required for pilot signoff: real backend token-route proof

Current scope note:
- the real-env smoke path below is direct proxy/token-route evidence
- wrapped-session proof is currently executable for `innies claude`
- wrapped-session proof for `innies codex` starts after Codex runtime wiring ships

Run in pilot/staging env with valid API credentials:

```bash
cd cli
INNIES_SMOKE_API_URL=https://gateway.innies.ai \
INNIES_SMOKE_API_KEY=in_live_<api_key> \
INNIES_SMOKE_IDEMPOTENCY_KEY=11111111-1111-7111-8111-111111111111 \
npm run test:smoke:real
```

Expected proof: response includes `x-innies-token-credential-id` header.

## Token-Mode Runbook (C1)
Daily path for internal pilot users:

```bash
innies login --token in_live_<redacted> --base-url https://gateway.innies.ai
innies doctor
innies claude -- --version
innies claude -- "summarize this repo"
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
