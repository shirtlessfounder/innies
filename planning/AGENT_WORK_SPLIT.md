# Agent Work Split (C1 Concern Remediation)

Scope: only current open concerns. Keep changes minimal and MVP-focused.

## Agent 1 - Core API + Contracts

### Must Do
- [ ] Return provider-native non-streaming responses.
  - Preserve upstream status/body for successful and client-error responses.
  - Remove envelope response shape from proxy output path.
- [ ] Fix upstream 4xx propagation.
  - Do not wrap upstream 400/404/etc inside proxy HTTP 200.
  - Keep only intentional remaps (e.g., internal routing errors) as proxy-owned errors.
- [ ] Define streaming idempotency behavior and enforce it.
  - Choose deterministic C1 policy (replayable metadata response or explicit non-replayable contract).
  - Ensure code + API contract document match.
- [ ] Persist routing telemetry for failed attempts.
  - Write `routing_events` rows for each retry/failover attempt with error fields populated.
- [ ] Make global kill-switch contract explicit.
  - Enforce `scope='global' => targetId='*'` in admin endpoint validation.
- [ ] Add C1 endpoint `POST /v1/admin/replay-metering` (per scope).
- [ ] Ensure current API TypeScript build is clean after all Agent 1 changes.

### Files Likely Touched
- `api/src/routes/proxy.ts`
- `api/src/routes/admin.ts`
- `api/src/services/runtime.ts`
- `api/src/services/routingService.ts`
- `docs/API_CONTRACT.md`

### Exit Check
- `npm run build`
- `npm test`
- Manual proxy smoke: non-streaming 4xx and 2xx mirror upstream semantics.

---

## Agent 2 - CLI + Local UX

### Must Do
- [ ] Align CLI expectations to provider-native proxy behavior.
  - Ensure command/runtime handling works when proxy now returns raw provider status/body.
- [ ] Update smoke checks for status-shape compatibility.
  - Cover non-streaming 2xx/4xx pass-through semantics.

### Nice to Have
- [ ] Add one clear CLI diagnostic when proxy returns upstream 4xx (no envelope assumptions).

### Files Likely Touched
- `cli/src/commands/claude.js`
- `cli/scripts/smoke.sh`
- `docs/CLI_UX.md` (if needed)

### Exit Check
- `npm run build`
- `npm test`
- CLI smoke passes against updated API behavior.

---

## Agent 3 - Data/Jobs/Schema

### Must Do
- [ ] Implement real at-rest encryption for seller secrets.
  - Replace plain UTF-8 buffer storage with authenticated encryption.
  - Keep decrypt-in-process contract for routing.
- [ ] Replace brittle idempotency duplicate detection.
  - Detect unique constraint conflicts by postgres code (`23505`), not message text.
- [ ] Align proxy idempotency scope naming with DB privacy guard.
  - Use `proxy.*` scope format so metadata-only check applies.
- [ ] Improve streaming metering from zero-placeholder.
  - Parse available usage from stream completion/events, or deterministic estimate+reconcile marker.

### Follow-up (C1.5 if needed)
- [ ] Reconciliation source: replace self-referential expected/actual with provider-side pull adapter.
  - If deferred, add explicit TODO gate in docs and job logs.

### Files Likely Touched
- `api/src/repos/sellerKeyRepository.ts`
- `api/src/services/idempotencyService.ts`
- `api/src/repos/idempotencyRepository.ts`
- `api/src/routes/proxy.ts`
- `api/src/jobs/reconciliationDataSource.ts`

### Exit Check
- `npm run build`
- `npm test`
- Verify seller secrets are unreadable at rest in DB dump/sample.

---

## Integration Order
1. Agent 3: encryption + idempotency robustness primitives.
2. Agent 1: proxy semantics + kill-switch validation + failed-attempt telemetry + replay-metering endpoint.
3. Agent 2: CLI compatibility + smoke updates.
4. Final integration smoke across CLI -> API -> ledger writes.

## Definition of Done (C1)
- Proxy mirrors upstream semantics for non-streaming requests.
- 4xx propagation is correct and no false 200 wrapping remains.
- Seller secrets are encrypted at rest.
- Streaming path has non-placeholder metering behavior.
- Idempotency behavior is deterministic and resilient under concurrent duplicate requests.

---

## C1.5 (Defer)

- [ ] Runtime initialization hardening (lazy bootstrap for missing `DATABASE_URL`).
- [ ] Reconciliation provider-side pull adapter (replace self-referential source).
- [ ] Optional extra CLI diagnostics for upstream 4xx cases.
