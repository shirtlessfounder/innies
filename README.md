# Innies

API proxy and credential router for LLM providers. Pool OAuth tokens from Claude and Codex, route requests to the best available credential, and let buyers use a single API key without managing provider auth themselves.

## What it does

- **Token pooling** — Multiple OAuth credentials (Claude, Codex) in a shared pool. Innies picks the best available credential per request.
- **Automatic failover** — If a credential is rate-limited, expired, or maxed, Innies routes to the next one. If an entire provider's pool is exhausted, falls back to the other provider.
- **Buyer preference** — Buyers set a preferred provider (anthropic or openai). Innies honors it when possible, falls back transparently when not.
- **Anthropic compat mode** — Clients like OpenClaw send standard Anthropic Messages API requests. Innies handles everything behind that interface, including cross-provider translation (in progress).
- **Credential lifecycle** — Auto-quarantine failing credentials, reprobe and reactivate when healthy, track per-token usage and yield.

## Architecture

```
Buyer (OpenClaw, CLI, etc.)
  │
  ├─ POST /v1/messages  (Anthropic compat mode)
  └─ POST /v1/proxy/*   (native proxy mode)
        │
     Innies API
        │
        ├─ Auth (buyer key → org → preference)
        ├─ Provider selection (preference → fallback → credential)
        ├─ Token credential pool (active/maxed/probe lifecycle)
        │
        ├─ Anthropic upstream (api.anthropic.com)
        └─ Codex upstream (chatgpt.com/backend-api)
```

## Repo structure

```
api/          Express API server
  src/
    routes/     proxy.ts (core routing), anthropicCompat.ts, admin.ts
    middleware/  auth, rate limiting
    repos/      DB repositories (credentials, keys, usage)
    services/   runtime, token lifecycle
    jobs/       credential health probes
    utils/      OAuth, provider helpers
cli/          CLI wrappers (innies claude, innies codex) [Phase 1]
ui/           Internal dashboard [Phase 1]
docs/         API contract, onboarding, planning, specs
scripts/      Operator scripts (add/rotate tokens, check preference)
```

## Setup

### Requirements
- Node.js 22+
- PostgreSQL
- OAuth tokens from Claude and/or Codex

### Environment
```bash
cp scripts/innies-env.example .env
# Fill in DATABASE_URL, admin secret, and at least one OAuth token
```

### Run
```bash
cd api && npm install && npm run dev
```

### Add a token
```bash
./scripts/innies-add-token.sh
```

### Set buyer preference
```bash
./scripts/innies-set-preference.sh
```

## API

### `POST /v1/messages` (Anthropic compat)
Drop-in replacement for Anthropic's Messages API. Authenticate with `x-api-key: in_live_...` header. Innies routes to the best available credential based on buyer preference.

### `POST /v1/proxy/*` (native proxy)
Direct proxy with explicit provider selection. Used by CLI wrappers.

### Admin endpoints
Token management, buyer key management, preference configuration. See `docs/API_CONTRACT.md`.

## Docs

- [API Contract](docs/API_CONTRACT.md)
- [Roadmap](docs/planning/ROADMAP.md)
- [OpenClaw Onboarding](docs/onboarding/OPENCLAW_ONBOARDING.md)
- [Codex OAuth Guide](docs/onboarding/CLAUDE_CODEX_OAUTH_TOKENS.md)
- [Phase 1 Scope](docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md)

## Current status

**Phase 0 complete.** Anthropic token routing is live. OAuth credential lifecycle (quarantine, reprobe, reactivation) is operational.

**Phase 1 in progress.** Codex token support, buyer preference routing, compat-mode provider translation, CLI wrappers, internal dashboard.

## License

Private. Internal use only.
