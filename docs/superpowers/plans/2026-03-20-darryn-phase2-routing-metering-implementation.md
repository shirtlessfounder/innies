# Routing And Canonical Metering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Darryn Phase 2 routing-and-canonical-metering workstream without touching pilot auth, cutover routes, or the merged cutover/access migration slice.

**Architecture:** Keep the cutover/access seam intact and replace the current raw `usageLedger` request-finalization writes with canonical metering finalization that persists routing mode, admission-time attribution, applied rate-card version, and derived financial amounts per finalized request. Expose routing/metering reads through existing `admin.ts` and `usage.ts` route seams, keep reserve-floor storage on token credentials, and wire the cutover reserve-floor migration helper only through `runtime.ts`.

**Tech Stack:** TypeScript, Express, Postgres repositories, Vitest, npm build

---

## Locked Interfaces

### Request-history APIs

- `GET /v1/usage/me/requests?limit=<1-100>&cursor=<opaque>`
  - Auth: `buyer_proxy` or `admin`
  - Scope: caller org only
  - Darryn-facing visibility: post-cutover requests only
  - Returns: request id, attempt no, admitted at/finalized at, session id, provider, model, `admission_routing_mode`, serving org, token credential id, rate-card version id, buyer debit minor, contributor earnings minor, request preview metadata, routing explanation summary

- `GET /v1/admin/requests?consumerOrgId=<uuid>&limit=<1-100>&cursor=<opaque>&historyScope=<post_cutover|all>`
  - Auth: `admin`
  - Scope: admin support view
  - `historyScope=post_cutover` matches Darryn-facing slice
  - `historyScope=all` may include pre-cutover internal history for admin-only troubleshooting

- `GET /v1/admin/requests/:requestId/explanation`
  - Auth: `admin`
  - Returns: canonical metering row, routing event metadata, reserve-floor/provider-usage exclusion reasons when present, why the request was `self-free` vs `paid-team-capacity` vs `team-overflow-on-contributor-capacity`, and whether wallet/earnings projections remain financially unfinalized

- `POST /v1/admin/metering/corrections`
  - Auth: `admin`
  - Purpose: operator correction intake for financially unfinalized or mis-finalized requests
  - Payload supports `served_request_retry`, `correction`, and `reversal` actions with actor/reason metadata

### Reserve-floor contract

- Storage remains on `in_token_credentials.five_hour_reserve_percent` and `in_token_credentials.seven_day_reserve_percent`
- Routing enforcement remains provider-aware and fail-closed for sold contributor work when provider-usage signals are missing, stale, or below the configured floor
- Read API:
  - `GET /v1/admin/token-credentials/:id/contribution-cap`
- Write API:
  - existing `PATCH /v1/admin/token-credentials/:id/contribution-cap`
- Cutover helper:
  - `tokenCredentialRepository.migrateReserveFloors({ fromOrgId, toOrgId, cutoverId })`
  - wired into `PilotCutoverService` only through the existing `runtime.ts` adapter

### Rate-card contract

- Add admin-managed immutable rate-card line items keyed by `(rate_card_version_id, provider, model_pattern, routing_mode)`
- Canonical metering finalization must persist:
  - `rate_card_version_id`
  - derived `buyer_debit_minor`
  - derived `contributor_earnings_minor`
- `self-free` requests still write canonical metering with zero debit and zero earnings

### File map

- Modify: `api/src/routes/admin.ts`
- Modify: `api/src/routes/proxy.ts`
- Modify: `api/src/routes/usage.ts`
- Modify: `api/src/services/runtime.ts`
- Modify: `api/src/services/routingService.ts`
- Modify: `api/src/services/routerEngine.ts`
- Modify: `api/src/services/metering/usageMeteringWriter.ts`
- Modify: `api/src/repos/canonicalMeteringRepository.ts`
- Modify: `api/src/repos/meteringProjectorStateRepository.ts`
- Modify: `api/src/repos/requestLogRepository.ts`
- Modify: `api/src/repos/routingEventsRepository.ts`
- Modify: `api/src/repos/tableNames.ts`
- Modify: `api/src/repos/tokenCredentialRepository.ts`
- Modify: `api/src/types/phase2Contracts.ts`
- Create: `api/src/repos/rateCardRepository.ts`
- Create: `api/src/repos/routingAttributionRepository.ts`
- Create: `api/tests/rateCardRepository.test.ts`
- Create: `api/tests/routingAttributionRepository.test.ts`
- Create: `api/tests/usage.route.test.ts`
- Modify: `api/tests/admin.pilot.route.test.ts`
- Modify: `api/tests/canonicalMeteringRepository.test.ts`
- Modify: `api/tests/routingService.test.ts`
- Modify: `api/tests/proxy.sellerMode.route.test.ts`
- Modify: `api/tests/proxy.tokenMode.route.test.ts`
- Create: `docs/migrations/019_darryn_routing_metering.sql`
- Create: `docs/migrations/019_darryn_routing_metering_no_extensions.sql`

## Chunk 1: Persistence Contracts

### Task 1: Add routing/metering schema and repository coverage

**Files:**
- Create: `docs/migrations/019_darryn_routing_metering.sql`
- Create: `docs/migrations/019_darryn_routing_metering_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`
- Modify: `api/src/repos/canonicalMeteringRepository.ts`
- Modify: `api/src/repos/meteringProjectorStateRepository.ts`
- Create: `api/src/repos/rateCardRepository.ts`
- Create: `api/src/repos/routingAttributionRepository.ts`
- Modify: `api/src/repos/requestLogRepository.ts`
- Modify: `api/src/repos/routingEventsRepository.ts`
- Test: `api/tests/canonicalMeteringRepository.test.ts`
- Test: `api/tests/meteringProjectorStateRepository.test.ts`
- Test: `api/tests/rateCardRepository.test.ts`
- Test: `api/tests/routingAttributionRepository.test.ts`

- [ ] **Step 1: Write the failing repository tests**

Add tests for:
- canonical metering query/list methods that drive request history and explanation reads
- rate-card version activation and line-item lookup
- financially unfinalized request detection when a successful routed request lacks canonical metering
- admin/post-cutover filtering in request-history queries

- [ ] **Step 2: Run the targeted failing tests**

Run:
```bash
cd api && npm test -- canonicalMeteringRepository.test.ts meteringProjectorStateRepository.test.ts rateCardRepository.test.ts routingAttributionRepository.test.ts
```

Expected: FAIL with missing tables, missing repository methods, or missing query behavior

- [ ] **Step 3: Add the migration and minimal repository implementation**

Implement:
- rate-card line-item tables and indexes
- retry bookkeeping table/index support needed for missing-metering scans if existing projector-state columns are insufficient
- repository methods to:
  - read active rate-card version and line items
  - persist/read canonical metering history by org/request
  - list financially unfinalized finalized requests
  - join canonical metering + routing events + request previews for admin explanations

- [ ] **Step 4: Re-run the targeted repository tests**

Run:
```bash
cd api && npm test -- canonicalMeteringRepository.test.ts meteringProjectorStateRepository.test.ts rateCardRepository.test.ts routingAttributionRepository.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/migrations/019_darryn_routing_metering.sql docs/migrations/019_darryn_routing_metering_no_extensions.sql api/src/repos/tableNames.ts api/src/repos/canonicalMeteringRepository.ts api/src/repos/meteringProjectorStateRepository.ts api/src/repos/requestLogRepository.ts api/src/repos/routingEventsRepository.ts api/src/repos/rateCardRepository.ts api/src/repos/routingAttributionRepository.ts api/tests/canonicalMeteringRepository.test.ts api/tests/meteringProjectorStateRepository.test.ts api/tests/rateCardRepository.test.ts api/tests/routingAttributionRepository.test.ts
git commit -m "feat: add routing metering persistence"
```

## Chunk 2: Finalization And Routing Classification

### Task 2: Convert finalized requests to canonical metering

**Files:**
- Modify: `api/src/services/metering/usageMeteringWriter.ts`
- Modify: `api/src/services/runtime.ts`
- Modify: `api/src/services/routingService.ts`
- Modify: `api/src/services/routerEngine.ts`
- Modify: `api/src/routes/proxy.ts`
- Modify: `api/src/types/phase2Contracts.ts`
- Modify: `api/src/repos/tokenCredentialRepository.ts`
- Test: `api/tests/usageMeteringWriter.test.ts`
- Test: `api/tests/routingService.test.ts`
- Test: `api/tests/proxy.sellerMode.route.test.ts`
- Test: `api/tests/proxy.tokenMode.route.test.ts`

- [ ] **Step 1: Write the failing behavior tests**

Add tests for:
- `self-free` canonical metering on user-owned token-credential traffic
- `paid-team-capacity` canonical metering on team-capacity admissions
- `team-overflow-on-contributor-capacity` canonical metering on internal traffic served by user-contributed capacity
- lane isolation: `innies claude` never spills into OpenAI/Codex, `innies codex` never spills into Claude
- missing/stale reserve-floor provider signals failing closed for sold contributor capacity
- reserve-floor migration helper moving contribution-cap values during cutover adapter invocation

- [ ] **Step 2: Run the failing behavior tests**

Run:
```bash
cd api && npm test -- usageMeteringWriter.test.ts routingService.test.ts proxy.sellerMode.route.test.ts proxy.tokenMode.route.test.ts
```

Expected: FAIL because canonical metering finalization, route-mode classification, lane-isolation assertions, and reserve-floor migration helper are not implemented yet

- [ ] **Step 3: Implement the minimal runtime seam**

Implement:
- `UsageMeteringWriter` as the canonical metering writer instead of the old `usageLedger` wrapper
- request-finalization input carrying:
  - `admission_org_id`
  - `admission_cutover_id`
  - `admission_routing_mode`
  - serving org/credential attribution
  - applied `rate_card_version_id`
  - derived debit/earnings amounts
- `proxy.ts` updates so every finalized pilot-mode request writes exactly one canonical metering event
- `runtime.ts` wiring for:
  - rate-card repo
  - routing attribution repo
  - reserve-floor migration adapter for cutover service
- narrow `routingService.ts` / `routerEngine.ts` changes only where needed to expose the locked routing modes and lane-isolation reasons

- [ ] **Step 4: Re-run the behavior tests**

Run:
```bash
cd api && npm test -- usageMeteringWriter.test.ts routingService.test.ts proxy.sellerMode.route.test.ts proxy.tokenMode.route.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/services/metering/usageMeteringWriter.ts api/src/services/runtime.ts api/src/services/routingService.ts api/src/services/routerEngine.ts api/src/routes/proxy.ts api/src/types/phase2Contracts.ts api/src/repos/tokenCredentialRepository.ts api/tests/usageMeteringWriter.test.ts api/tests/routingService.test.ts api/tests/proxy.sellerMode.route.test.ts api/tests/proxy.tokenMode.route.test.ts
git commit -m "feat: finalize canonical routing metering"
```

## Chunk 3: Read APIs, Corrections, And Reserve-Floor Reads

### Task 3: Expose request history, admin explanations, and operator correction intake

**Files:**
- Modify: `api/src/routes/admin.ts`
- Modify: `api/src/routes/usage.ts`
- Modify: `api/src/services/runtime.ts`
- Modify: `api/src/repos/routingAttributionRepository.ts`
- Modify: `api/src/repos/rateCardRepository.ts`
- Test: `api/tests/admin.pilot.route.test.ts`
- Test: `api/tests/admin.tokenCredentials.route.test.ts`
- Test: `api/tests/usage.route.test.ts`

- [ ] **Step 1: Write the failing route tests**

Add tests for:
- `GET /v1/usage/me/requests` returning only post-cutover caller-visible history
- `GET /v1/admin/requests` supporting `historyScope=post_cutover|all`
- `GET /v1/admin/requests/:requestId/explanation` returning routing + metering + projector-state explanation
- `GET /v1/admin/token-credentials/:id/contribution-cap` returning current reserve floors
- `POST /v1/admin/metering/corrections` enforcing reason metadata and action-specific validation

- [ ] **Step 2: Run the failing route tests**

Run:
```bash
cd api && npm test -- admin.pilot.route.test.ts admin.tokenCredentials.route.test.ts usage.route.test.ts
```

Expected: FAIL with missing endpoints or missing response fields

- [ ] **Step 3: Implement the route handlers**

Implement:
- request-history pagination and filtering in `usage.ts`
- admin history/explanation/correction endpoints in `admin.ts`
- reserve-floor read endpoint in `admin.ts`
- runtime wiring for any new repositories/services these handlers need

- [ ] **Step 4: Re-run the route tests**

Run:
```bash
cd api && npm test -- admin.pilot.route.test.ts admin.tokenCredentials.route.test.ts usage.route.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/admin.ts api/src/routes/usage.ts api/src/services/runtime.ts api/src/repos/routingAttributionRepository.ts api/src/repos/rateCardRepository.ts api/tests/admin.pilot.route.test.ts api/tests/admin.tokenCredentials.route.test.ts api/tests/usage.route.test.ts
git commit -m "feat: add routing history and explanations"
```

## Chunk 4: Retry, Verification, And Build

### Task 4: Finish missing-metering retry flow and verify the slice

**Files:**
- Modify: `api/src/routes/admin.ts`
- Modify: `api/src/repos/meteringProjectorStateRepository.ts`
- Modify: `api/src/repos/routingAttributionRepository.ts`
- Test: `api/tests/admin.pilot.route.test.ts`
- Test: `api/tests/meteringProjectorStateRepository.test.ts`

- [ ] **Step 1: Write the failing retry/correction tests**

Add tests for:
- financially unfinalized request detection returning requests missing canonical metering
- retry endpoint re-finalizing a missing request idempotently
- correction endpoint emitting `correction` and `reversal` events without mutating source rows

- [ ] **Step 2: Run the failing tests**

Run:
```bash
cd api && npm test -- admin.pilot.route.test.ts meteringProjectorStateRepository.test.ts
```

Expected: FAIL with missing retry orchestration or missing operator correction behavior

- [ ] **Step 3: Implement the minimal retry/correction orchestration**

Implement:
- scan/query helpers for financially unfinalized requests
- admin retry path that replays canonical metering finalization idempotently
- correction/reversal writes that preserve source-event linkage and projector-state visibility

- [ ] **Step 4: Run focused verification**

Run:
```bash
cd api && npm test -- canonicalMeteringRepository.test.ts meteringProjectorStateRepository.test.ts rateCardRepository.test.ts routingAttributionRepository.test.ts usageMeteringWriter.test.ts routingService.test.ts proxy.sellerMode.route.test.ts proxy.tokenMode.route.test.ts admin.pilot.route.test.ts admin.tokenCredentials.route.test.ts usage.route.test.ts
cd api && npm run build
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/admin.ts api/src/repos/meteringProjectorStateRepository.ts api/src/repos/routingAttributionRepository.ts api/tests/admin.pilot.route.test.ts api/tests/meteringProjectorStateRepository.test.ts
git commit -m "feat: add metering retry and correction flows"
```

## Remaining Dependency On Later Wallet Work

- `paid-team-capacity` must persist the canonical `rate_card_version_id`, debit amount, and admission-time routing mode now, but wallet admission and wallet-ledger projection remain downstream consumers of that fact.
- This workstream must not invent wallet balance rules, preauth behavior, or payment integration. It only exposes the seam that Workstream 4 consumes.
- Admin explanations should surface when a request is financially finalized in canonical metering but still awaiting downstream wallet projection so later wallet work can reconcile without changing routing behavior.
