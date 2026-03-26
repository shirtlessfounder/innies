# Innies

Innies is a hosted router and org dashboard for pooling Claude Code and Codex OAuth tokens behind a single buyer key.

Hosted version: [innies.computer](https://innies.computer)  
API base: [api.innies.computer](https://api.innies.computer)

## Links

- Product: [innies.computer](https://innies.computer)
- API: [api.innies.computer](https://api.innies.computer)
- Guides: [innies.computer/onboard](https://innies.computer/onboard)
- Telegram: [t.me/innies_hq](https://t.me/innies_hq)
- X / Twitter: [x.com/innies_computer](https://x.com/innies_computer)
- GitHub: [github.com/shirtlessfounder/innies](https://github.com/shirtlessfounder/innies)

## What Innies Does

- Pools Claude Code and Codex OAuth tokens into a shared org-managed supply.
- Issues buyer keys so end users can route through Innies without handling upstream provider auth directly.
- Routes requests to the best available token, with automatic failover when a token is maxed, paused, expired, or unhealthy.
- Supports org onboarding flows for creating orgs, inviting members, accepting invites, and revealing per-org buyer keys.
- Exposes live analytics and management UI for tokens, buyers, request volume, latency, error rate, and routing health.

## Core Product Surfaces

- Hosted web app at [`innies.computer`](https://innies.computer)
- Hosted API at [`api.innies.computer`](https://api.innies.computer)
- Anthropic-compatible messages endpoint for model-agnostic clients like OpenClaw
- Provider-pinned CLI entrypoints like `innies claude` and `innies codex`
- Org dashboard for token management, reserve controls, probing, invites, and buyer-key operations

## High-Level Flow

```text
Buyer / client
  -> Innies buyer key
  -> Innies API
  -> provider selection + token routing
  -> Claude Code or Codex upstream session token
```

Innies sits between your clients and your pooled upstream OAuth/session tokens. Org owners add tokens, manage reserve floors and caps, and control who can access the org. Buyers use Innies keys instead of raw upstream credentials.

## Repo Structure

```text
api/      Express API server and routing logic
ui/       Next.js web app for onboarding, org dashboards, and analytics
cli/      CLI wrappers and local entrypoints
docs/     onboarding docs, API docs, specs, plans, and ops notes
scripts/  operator scripts and local install helpers
```

## Local Development

### Requirements

- Node.js 22+
- PostgreSQL
- OAuth/session credentials for Claude Code and/or Codex

### Basic Setup

```bash
mkdir -p ~/.config/innies
cp scripts/innies-env.example ~/.config/innies/.env
```

Fill in the required env vars, including your database config and API secrets.

### Run The API

```bash
cd api
npm install
npm run dev
```

### Run The UI

```bash
cd ui
pnpm install
pnpm dev
```

## Docs

- [API Contract](docs/API_CONTRACT.md)
- [OpenClaw Onboarding](docs/onboarding/OPENCLAW_ONBOARDING.md)
- [CLI Onboarding](docs/onboarding/CLI_ONBOARDING.md)
- [Claude / Codex OAuth Token Guide](docs/onboarding/CLAUDE_CODEX_OAUTH_TOKENS.md)
- [Innies Beta Decisions](docs/onboarding/INNIES_BETA_DECISIONS.md)

## Status

Innies is live as a hosted product at [innies.computer](https://innies.computer). This repo contains the API, web app, onboarding flows, routing logic, analytics surfaces, and operator tooling behind the hosted service.

## License

[MIT](LICENSE)
