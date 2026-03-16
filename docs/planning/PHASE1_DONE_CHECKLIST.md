# Phase 1 Exit Checklist

## 1. Feature Completion Status

| # | Feature | Status | Summary |
|---|---------|--------|---------|
| 1 | Codex support | DONE | Translation layer (Anthropic Messages <-> OpenAI Responses) deployed to production 2026-03-06. Request, response, and streaming translation. Error envelope mapping. 127+ tests passing. |
| 2 | Per-buyer-key provider preference | DONE | Deterministic preference-first routing with fallback on 401/403/429/timeout/5xx/capacity. `preferredProviderSource` distinguishes explicit vs default. Admin endpoints for GET/PUT preference. Shell scripts: `innies-buyer-preference-set.sh`, `innies-buyer-preference-get.sh`, `innies-buyer-preference-check.sh`. |
| 3 | Per-token analytics | DONE | 7 analytics endpoints (tokens, health, routing, system, timeseries, requests, anomalies). Request log with prompt/response previews (30-day retention). TTFB persistence. Source classification (openclaw / cli-claude / cli-codex / direct). Token capacity estimation from maxing cycle history. |
| 4 | CLI support | DONE | `innies claude` (Anthropic-pinned) and `innies codex` (Codex/OpenAI-pinned). Published to npm as `innies@0.1.7`. TTY-preserving argument passthrough, provider pin signal (`cli_provider_pinned`), recursion guards, actionable error hints. |
| 5 | Internal dashboard | DONE | Next.js dashboard in `ui/`. Analytics tables with per-token and per-buyer panels. Charting via lightweight-charts. Truthful token status column. Latency, success/error rates, routing/fallback visibility. |
| 6 | Token onboarding | DONE | Admin endpoints: add (`POST /v1/admin/token-credentials`), rotate, revoke, pause/unpause, probe, provider-usage-refresh. Debug labels for attribution. Health checks + quarantine lifecycle (active/maxed/probe/revoked). Shell scripts: `innies-token-add.sh`, `innies-token-rotate.sh`, `innies-token-pause.sh`, plus 8 more operator scripts. |
| 7 | Developer docs | DONE | `docs/API_CONTRACT.md` covering 29 endpoints with auth, request/response examples, error model. `docs/onboarding/OPENCLAW_ONBOARDING.md` for OpenClaw integration. `docs/onboarding/CLAUDE_CODEX_OAUTH_TOKENS.md` for OAuth credential setup. |

## 2. Validation Evidence

| # | Feature | Validation |
|---|---------|------------|
| 1 | Codex support | `cd api && npx vitest run` — all tests green. 34 test files covering routes, repositories, services, jobs, translation, analytics. Compat translation verified with OpenClaw (server-side translation transparent). |
| 2 | Provider preference | Admin preference endpoints exercised via `innies-buyer-preference-set.sh`, `innies-buyer-preference-get.sh`, `innies-buyer-preference-check.sh`. Fallback reason codes emitted in route decision metadata. Integration tests cover preference behavior, fallback, and re-entry. |
| 3 | Per-token analytics | Analytics endpoints deployed and queryable: `/v1/admin/analytics/tokens`, `/health`, `/routing`, `/system`, `/timeseries`, `/requests`, `/anomalies`. Migration SQL applied: `docs/migrations/011_analytics_request_log_ttfb.sql`. Anomaly checks for missing labels, null token IDs, stale windows. |
| 4 | CLI support | `npm run test:unit` (cli unit tests), `npm run test:smoke` (local fake-binary smoke), `npm run test:smoke:real` (real-env proof against `/v1/proxy/*`). Both wrappers validated on Dylan's machine. Routing reason `cli_provider_pinned` confirmed in logs. No provider flip during pinned sessions. |
| 5 | Internal dashboard | `cd ui && npm run build` — builds successfully. Dashboard accessible via `npm run dev`. Per-token and per-buyer panels verified against raw DB counts. |
| 6 | Token onboarding | Token add/rotate/revoke exercised via shell scripts. Verification queries confirm tokens enter correct lifecycle state (active, routable). Duplicate-token and bad-format checks in place. |
| 7 | Developer docs | Docs reviewed for accuracy against deployed API. New internal dev onboarding verified using docs-only flow. |

## 3. SLO Results

### Targets (from Phase 1 scope doc)

| Metric | Target | Notes |
|--------|--------|-------|
| First-byte latency p95 | <= 8,000 ms | Canary + full window |
| Timeout rate | <= 2.0% | Canary + full window |
| Tool-loop success rate | >= 95.0% | Canary + full window |
| Fallback rate | Investigate if > 20% or day-over-day increase > 10pp | Monitoring threshold |

### Current Status

| Metric | Canary Window | Full Window | Pass? |
|--------|--------------|-------------|-------|
| First-byte latency p95 | _Populate from `/v1/admin/analytics/system`_ | _Populate from `/v1/admin/analytics/system`_ | _TBD_ |
| Timeout rate | _Populate from `/v1/admin/analytics/system`_ | _Populate from `/v1/admin/analytics/system`_ | _TBD_ |
| Tool-loop success rate | _Populate from `/v1/admin/analytics/system`_ | _Populate from `/v1/admin/analytics/system`_ | _TBD_ |
| Fallback rate | _Populate from `/v1/admin/analytics/routing`_ | _Populate from `/v1/admin/analytics/routing`_ | _TBD_ |

> **Note:** SLO values above are placeholders. The admin should populate these from live analytics endpoints before signing off. Query the analytics endpoints or dashboard to fill in actual numbers.

## 4. Known Caveats & Follow-Up Items

| Item | Details | Severity |
|------|---------|----------|
| SLO values not yet populated | The SLO results table in section 3 needs actual values from live analytics before go/no-go sign-off. | Medium — must be populated before approval. |
| Dashboard has no tests | The `ui/` package has no test scripts defined. | Low — read-only internal dashboard. |

## 5. Go / No-Go Decision

### Checklist

- [x] All 7 features complete and validated
- [x] API test suite green (`cd api && npx vitest run`)
- [x] CLI smoke tests passing (`cd cli && npm run test:smoke`)
- [x] Dashboard builds successfully (`cd ui && npm run build`)
- [x] Developer docs reviewed and accurate
- [ ] SLO values populated from live analytics
- [ ] SLO targets met for canary + full window

### Decision

| Field | Value |
|-------|-------|
| Decision | _GO / NO-GO_ |
| Approver | _Name_ |
| Date | _YYYY-MM-DD_ |
| Notes | _Any conditions or follow-up items_ |
