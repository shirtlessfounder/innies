# Headroom MVP Technical Scope

## Objective
Build a two-checkpoint MVP for a capacity-sharing AI proxy marketplace.

- Checkpoint 1: free internal use for a 4-person team.
- Checkpoint 2: paid external marketplace (buyers + sellers + payouts).

Use the same deployment pattern as `percent`:
- `ui`: Next.js app (Vercel)
- `api`: long-running backend service (Node/TypeScript)
- PostgreSQL + Redis + external integrations

---

## Product Summary
Fixed-cap AI subscriptions waste unused capacity for some users and force others to buy a second account. Headroom creates a pooled proxy:

- Sellers contribute unused capacity from their subscription keys.
- Buyers route overflow requests through pooled capacity.
- Platform meters usage, enforces limits, and handles settlement.

Unit economics target:
- Seller receives: $0.50 / $1 retail-equivalent capacity sold
- Buyer pays: $0.75 / $1 retail-equivalent capacity consumed
- Platform keeps: $0.25 / $1 transacted

---

## MVP Guardrails & Operability

### Provider policy risk plan (required before Checkpoint 1 exit)
- Decision owner: founder/CEO + legal reviewer.
- Decision record: explicit `go/no-go` on provider key-sharing/proxy policy compatibility.
- Fallback if `no-go`: pivot to bring-your-own-key relay mode (no pooled resale), pause seller onboarding, and disable marketplace payouts.
- Re-attestation: sellers must periodically attest they are authorized to use contributed keys this way.

### Ledger correctness model
- Usage and billing are append-only ledgers.
- No in-place edits to economic events.
- Corrections happen via explicit adjustment/reversal entries linked to original event IDs.
- Billing lock: invoiced periods become immutable except for post-lock adjustments.

### Idempotency contract
- Required `Idempotency-Key` for all metered proxy writes and admin mutation endpoints.
- Format: UUIDv7 (preferred) or 32+ char opaque token.
- Retention window: 7 days in Redis + DB dedupe index.
- Duplicate behavior: return original result; never double-write ledger entries.

### Kill switches and emergency controls
- One-click disable at four levels: seller key, buyer org, model, global proxy.
- Per-key circuit breaker on consecutive failures/abuse flags.
- Degraded mode: serve explicit `capacity_unavailable`/`suspended` errors with retry guidance.

### Security, privacy, and retention
- Default policy: do not store raw prompts/responses.
- Store metadata only: request IDs, org/key IDs, model, token usage, latency, status, billing units.
- Any "raw request logs" are metadata-only logs and must not include prompt/response bodies by default.
- Prompt/response body capture is break-glass only for incident debugging, must be explicitly enabled, redacted, time-bounded, and audited.
- Redaction: strip known secrets/PII from error logs.
- Retention: raw request logs 14 days, routing/usage events 13 months, billing records 7 years.

### SLO and error budget
- Proxy availability target: 99.5% monthly (Checkpoint 1), 99.9% target after Checkpoint 2 hardening.
- Proxy overhead target: p95 < 300ms, p99 < 800ms (excluding upstream model latency).
- Error budget trigger: >1% 5xx for 15 minutes or >3% failed routed requests over 1 hour pages on-call.

### Reconciliation ownership
- Owner: designated finance/ops reviewer.
- Daily check: provider usage vs internal usage ledger by key and org.
- Investigation threshold: absolute delta >2% daily or >$100 equivalent variance.

### Disaster recovery baseline
- DB backups: daily snapshots + PITR where available.
- Restore drill: at least monthly for Checkpoint 2 readiness.

### Explicit MVP non-goals
- No multi-provider optimization engine in MVP.
- No dynamic auction pricing in MVP.
- No long-term prompt/content storage or analytics from prompt text.
- No mobile app.

---

## C1 Decision Lock (Implementation Defaults)

These decisions are locked for Checkpoint 1 implementation. Any change requires explicit scope update.

### 1. Canonical `usage_units` formula + versioning
- Canonical C1 formula:
  - `usage_units = input_tokens + output_tokens`
- Persist `metering_version` with each usage write (start with `v1`).
- Persist raw token counts from provider response where available.
- If provider omits token counts, mark usage row with `estimate=true` and use deterministic estimator, then reconcile later.

### 2. Streaming billing rules
- Billable event requires upstream acceptance + at least one streamed content chunk delivered by upstream.
- Client disconnect after upstream acceptance:
  - record partial usage as billable based on observed tokens/chunks.
- Upstream timeout before first content chunk:
  - mark non-billable, no primary usage row.
- Upstream timeout after at least one content chunk:
  - record partial billable usage, status `partial_timeout`.
- Reconciliation job may append correction/reversal rows if final provider usage differs.

### 3. Retry matrix + idempotency interaction
- Retries use same (`org_id`, `request_id`) identity and same idempotency key.
- Retry policy:
  - 429: retry with exponential backoff + jitter, then key failover.
  - 5xx: immediate key failover + bounded retries.
  - network/DNS/connect timeout: bounded retry, then failover.
  - 4xx auth/permission/model-invalid: no retry on same key; failover only if error is key-specific.
- Idempotency guarantees one primary usage row per (`org_id`, `request_id`, `attempt_no`) and one primary usage event overall for successful execution path.

### 4. Capacity exhaustion policy
- Per-org bounded queue: max 20 pending requests.
- Queue wait timeout: 8 seconds, then fail fast with `capacity_unavailable`.
- Fairness policy: weighted round-robin across org queues with per-org concurrency cap (default 3).
- No unbounded buffering in API process.
- Latency UX principle: queueing must preserve near-native Claude Code feel; if queue delay exceeds threshold, fail fast instead of long hanging waits.

### 5. Minimum secrets lifecycle details (C1)
- `encrypted_secret` decrypted only inside `headroom/api` routing service process memory.
- Decryption key material must come from runtime secret manager/env, never stored in DB.
- Secrets never logged; redact on all error paths.
- Compromise response (C1 manual runbook):
  - mark seller key `revoked`
  - trigger kill switch for key
  - invalidate active routing selection cache
  - notify operator and require seller re-provision.

### 6. Job schedule + ownership
- Idempotency TTL purge: every hour.
- Daily aggregates refresh: every 5 minutes incremental + nightly full compaction.
- Reconciliation run: daily at 02:00 UTC.
- Job ownership:
  - primary: backend on-call owner
  - secondary: product/finance reviewer for reconciliation deltas.
- Alert thresholds:
  - purge job failure > 2 consecutive runs pages on-call
  - reconciliation delta > 2% or > $100 equivalent opens investigation task.

### 7. No-extension DB mode requirements (C1 active)
Because C1 uses a no-extension migration variant, the application must enforce the following:
- UUID generation in app layer:
  - all inserts to `hr_*` tables must include explicit UUIDs (no DB default UUID generation).
- Email normalization in app layer:
  - store `email` lowercased before insert/update.
  - uniqueness behavior must be treated as case-insensitive (`lower(email)` index in DB).
- Compatibility-window overlap checks in app layer:
  - writes to `hr_model_compatibility_rules` must reject overlapping active windows for same (`provider`, `model`).
- Migration portability:
  - keep code paths compatible with future extension-enabled migration upgrades, but do not require extensions for C1.

---

## Target Architecture

### Services
1. `headroom/ui`
- Next.js dashboard and onboarding.
- Seller key management UI.
- Buyer endpoint/API key UI.
- Usage and billing views.

2. `headroom/api`
- Proxy endpoint compatible with Claude Code usage flow.
- Pool manager + routing + health checks.
- Streaming response support parity for supported provider endpoints.
- Usage metering and ledger writes.
- Billing and payout jobs (Checkpoint 2).

3. Data + infra
- PostgreSQL: source of truth (users, keys, usage ledger, billing ledger, audit logs).
- Redis: hot-path routing state, rate limits, health state, short-window counters, idempotency cache.
- Stripe Connect (Checkpoint 2): buyer billing + seller payouts.

### Initial provider/model compatibility rules (single-provider)
- Maintain a provider/model capability matrix used by router.
- Track at minimum: streaming support, max context/input limits, tool use support, rate-limit behavior.
- Router must not assign a key/model combination that fails compatibility checks.
- In Checkpoint 1, this matrix covers only the initial provider/model set; expansion happens per-provider onboarding in Checkpoint 2.

---

## Checkpoint 1: Team-of-4 Internal (Free)

### Goal
Prove end-to-end utility and reliability with no money movement.

### Scope
1. Proxy + routing
- Build versioned `POST /v1/proxy/*` pass-through endpoint.
- Select seller key using weighted round-robin.
- Enforce per-key caps and per-buyer caps.
- Add retry/fallback to alternate key on upstream failure.
- Support streaming/chunked responses where applicable.
- Define pool exhaustion behavior: bounded queue + fast-fail after timeout.

2. Seller key management (team-only)
- Add keys via dashboard/API.
- Encrypt keys at rest.
- Key status lifecycle: `active`, `paused`, `quarantined`, `invalid`.
- Manual pause/resume.
- Emergency revoke and blast-radius playbook for leaked/compromised keys.

3. Health checks + safety controls
- Periodic synthetic checks per key.
- Automatic quarantine after threshold failures.
- Cooldown + optional auto-recovery.
- Per-key circuit breaker and global kill switch.

4. Metering + immutable ledger
- Record per request:
  - buyer identity
  - seller key used
  - upstream model
  - request/response token counts (or best available usage units)
  - latency/status
  - retail-equivalent value
- Idempotent writes via required idempotency key.
- Write append-only usage events; adjustments are separate entries.

5. Team auth and controls
- Admin-managed users (4 team members).
- Buyer API keys for proxy usage.
- Basic RBAC (`admin`, `seller`, `buyer`).
- Admin audit logging for all sensitive actions.

6. Minimal dashboard + ops console
- Seller view: contributed cap, used capacity, key health.
- Buyer view: endpoint, API key, usage totals.
- Admin view: pool utilization, failures, manual controls.
- Manual ops actions:
  - force pause key
  - emergency disable buyer
  - replay failed metering write

7. CLI onboarding and runtime UX (required in C1)
- Ship a `headroom` CLI with:
  - `headroom login --token <hr_token>`
  - `headroom doctor`
  - `headroom claude` (proxy-routed Claude Code entrypoint)
  - `headroom link claude` (optional local convenience alias/link)
- One-copy setup flow from dashboard must use these commands.
- Runtime messaging must show lightweight connection/pool/cap status.

8. Observability and reconciliation
- Correlation ID through request -> routing -> usage ledger.
- Baseline metrics, logs, traces for proxy and router.
- Daily usage reconciliation job (internal even in C1).
- Basic anomaly alerts (velocity spikes, unusual per-key failure rates).

### Data Model (minimum)
- `users`
- `api_keys`
- `seller_keys`
- `routing_events`
- `usage_ledger`
- `billing_ledger_adjustments`
- `audit_log_events`
- `daily_aggregates`

### API Surface (minimum)
- `POST /v1/proxy/*`
- `POST /v1/seller-keys`
- `PATCH /v1/seller-keys/:id`
- `POST /v1/admin/kill-switch`
- `POST /v1/admin/replay-metering`
- `GET /v1/usage/me`
- `GET /v1/admin/pool-health`

### Non-functional targets
- Proxy availability: 99.5% monthly.
- Added proxy overhead (excluding upstream model latency):
  - p50 < 75ms
  - p95 < 200ms
  - p99 < 400ms
- Streaming first-byte delay delta vs direct baseline:
  - p95 < 150ms
- End-to-end latency parity:
  - median total response time within 10% of direct Claude Code baseline on fixed prompt suite.
- Metering drift within +/-2% vs provider-reported usage.
- No manual routing intervention during normal operation.

### Checkpoint 1 Exit Criteria
- 4 internal users route real traffic for >= 2 weeks.
- Stable routing with automated quarantine/recovery and tested kill switches.
- Usage dashboard trusted by team for decision-making.
- CLI onboarding commands (`login`, `doctor`, `claude`, `link claude`) are working and used by internal testers.
- Latency parity validation passes:
  - A/B benchmark (direct Claude Code vs Headroom-routed) on fixed prompt suite and fixed time windows.
  - Above non-functional latency thresholds are met for at least 2 consecutive days.
- Load and chaos tests pass for:
  - key failure storm
  - Redis outage/degradation
  - DB write lag
  - upstream 429/5xx burst
- Daily reconciliation runs with no unresolved variance over threshold.

---

## Checkpoint 2: External + Paid Marketplace

### Goal
Enable public onboarding, charging buyers, and paying sellers.

### Scope Additions
1. Multi-tenant onboarding
- Organization model with member roles.
- Self-serve signup for buyers/sellers.
- Admin approval flow for seller key contribution.
- Geo/tax eligibility gating during onboarding.

2. Billing + payouts (Stripe Connect)
- Metered buyer billing from usage ledger.
- Monthly invoice generation and collection.
- Seller earnings ledger + monthly payout batch.
- Refund/adjustment support.
- Funds-flow state model: `pending`, `posted`, `settled`, `paid`, `reversed`.

3. Pricing engine
- Encode split policy:
  - seller_rate = 0.50 * retail_equivalent
  - buyer_rate = 0.75 * retail_equivalent
  - platform_margin = 0.25 * retail_equivalent
- Versioned rate cards with effective dates.

4. Limits and risk controls
- Seller monthly contribution caps.
- Buyer monthly spend caps + hard cutoffs.
- Abuse detection (velocity spikes, anomalous usage).
- Manual review queue and temporary hold controls.

5. Ops hardening
- KMS-backed key encryption and key rotation process.
- Compromise response procedure and key rotation cadence.
- Reconciliation jobs:
  - usage -> invoice consistency
  - earnings -> payout consistency
- Alerting and incident runbooks.
- Backup cadence and restore drill verification.

6. Disputes and finance controls
- Dispute workflow with owner and SLA.
- Explicit ledger adjustment path for disputes/refunds.
- Month-end close checklist and signoff.

### Additional Data Model
- `orgs`
- `memberships`
- `pricing_plans`
- `rate_cards`
- `billing_accounts`
- `usage_invoices`
- `invoice_line_items`
- `seller_earnings_ledger`
- `payout_batches`
- `adjustments`
- `refunds`
- `disputes`
- `reconciliation_runs`

### Compliance/Safety Gates (before external beta)
- Legal review of proxy/key-sharing model against provider terms (go/no-go recorded).
- Platform Terms and acceptable use policy.
- Seller key-use attestation flow active.
- Tax and payout compliance setup for supported geographies.
- Security baseline: RBAC, audit logs, encryption, rate limits.

### Checkpoint 2 Exit Criteria
- External buyer can onboard, use endpoint, and be billed.
- External seller can onboard, contribute keys, and receive payout.
- Dispute workflow tested with adjustment and reversal flows.
- Month-end financial close can run from ledgers without spreadsheets.
- Restore drill and incident simulation completed successfully.

---

## Operational Readiness (Required Before Each Checkpoint Exit)
- Runbooks exist for incident classes: upstream outage, key compromise, billing mismatch, DB outage.
- On-call owner assigned and paging thresholds configured.
- Alert playbooks include first 30-minute actions and escalation paths.
- Recovery drills completed and documented.
- Data retention enforcement job active and verified.
- Reconciliation signoff checklist completed for trailing 7 days.

---

## Recommended Build Sequence
1. Implement Checkpoint 1 end-to-end (proxy -> routing -> metering -> dashboard).
2. Run internal pilot and validate reliability + economics.
3. Add Checkpoint 2 billing/payout and tenant controls.
4. Launch invite-only external beta with conservative caps.
5. Open broader onboarding after compliance and risk gates are passed.

---

## Initial Milestone Plan (Suggested)

### Milestone A: Core Proxy (Week 1)
- Proxy endpoint with versioned API contract.
- Basic key pool + round-robin + streaming support.
- Request logging + usage ledger write path + idempotency.

### Milestone B: Reliability + Team UI (Week 2)
- Health checks + quarantine + kill switches.
- Team auth + API keys + audit logging.
- Minimal dashboards + manual ops console.

### Milestone C: Internal Pilot (Week 3)
- Real team traffic.
- Metering validation and daily reconciliation.
- Load/chaos testing and bug fixes.
- Freeze Checkpoint 1 acceptance.

### Milestone D: Billing Foundations (Week 4+)
- Stripe Connect integration.
- Invoice + payout ledgers + rate cards.
- External onboarding and controls.
