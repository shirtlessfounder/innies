# Headroom MVP Implementation Audit

Scope: practical C1 build fixes only. No heavyweight platform/security expansion.

## Agent 1 (Core API + Contracts)

### Keep
- Routing skeleton with weighted round-robin + queue constraints is a good base.
- API contract doc is present and usable.

### Must Fix (MVP)
1. Replace proxy placeholder with real upstream pass-through.
- `POST /v1/proxy/*` must actually call provider and return real upstream response.
- Add streaming passthrough for supported requests.

2. Add minimal auth/RBAC needed for C1.
- Protect proxy with buyer API key.
- Protect admin routes with admin auth.
- Do not trust `orgId` from request body; derive from auth context.

3. Implement missing C1 endpoints from scope.
- `POST /v1/seller-keys`
- `PATCH /v1/seller-keys/:id`
- `POST /v1/admin/kill-switch`
- `GET /v1/usage/me`

4. Wire idempotency + correlation in route flow.
- Accept/validate `Idempotency-Key` where required.
- Return stable replay behavior for duplicates.

5. Remove hardcoded in-memory seller key pool from runtime.
- `runtime.ts` seeds static keys and routing reads only process memory.
- C1 needs seller key state loaded from DB-backed records so restarts do not reset pool/capacity.

6. Enforce kill-switch + compatibility rules in hot path.
- Routing currently filters by provider/model/streaming/status only.
- C1 requires checks against current disable state and model compatibility before selecting a key.

### Suggested Next Steps
- Add a thin middleware chain: request ID, auth context, idempotency.
- Add integration tests for retry/failover matrix and queue behavior.

---

## Agent 2 (CLI + Local UX)

### Keep
- Command set is correct for C1 (`login`, `doctor`, `claude`, `link claude`).
- Smoke script is useful and currently passes.

### Must Fix (MVP)
1. Fix `link claude` recursion risk.
- Wrapper currently calls `headroom claude`, and `headroom claude` spawns `claude` by name.
- If PATH resolves back to wrapper first, this can loop.

2. Resolve real Claude binary explicitly.
- Store real Claude path in config (or detect each run with wrapper path exclusion).
- Spawn that explicit binary, not generic `claude`.

3. Improve runtime UX minimally.
- Print concise runtime status (proxy URL/model/request correlation) without noise.

4. Make `doctor` consistent with setup flow.
- Current expected setup runs `doctor` before `link claude`.
- Treat missing wrapper as warning unless you intentionally make link mandatory.

### Suggested Next Steps
- Add loop guard env var as fail-safe.
- Add one focused test for “wrapper does not recurse”.

---

## Agent 3 (Data/Jobs + Dashboard Shell)

### Keep
- Repo abstractions and metering writer structure are good.
- Job framework exists and is clear.
- Dashboard shell pages are sufficient for C1 shell UI.

### Must Fix (MVP)
1. Align repo SQL with migration table names.
- Repos use unprefixed names; migrations define `hr_*`.
- Pick one naming convention and make code/migrations match.

2. Support active no-extension mode.
- No-extension migration requires app-supplied UUIDs.
- Current inserts omit `id` and will fail.

3. Make reconciliation timing actually run at 02:00 UTC.
- Current 24h interval from process start can miss 02:00 permanently.
- Use clock-based next-run logic.

4. Fix incremental aggregate upsert correctness.
- Current incremental job rolls recent window then overwrites full-day totals on conflict.
- Use additive/delta merge or recompute full day before upsert.

5. Wire metering writes into live proxy flow.
- Persist routing + usage rows from real request path (not just abstractions/tests).

6. Start jobs in API runtime.
- Scheduler + jobs exist but are not wired in server startup.
- Ensure idempotency purge / aggregates / reconciliation actually run in-process for C1.

7. Implement idempotency persistence operations, not just purge.
- Current repository only deletes expired rows.
- C1 needs create/get/replay semantics backed by `hr_idempotency_keys` to make duplicate retries safe.

8. Provide a real reconciliation data source contract implementation for C1.
- Job interface expects `snapshot(runDate)` but there is no runtime implementation wired to actual provider usage reads.
- Even with scheduler enabled, reconciliation is not actionable until this source is implemented.

### Suggested Next Steps
- Create one shared DB naming constants file.
- Add integration test against migrated schema for usage write path.

---

## Cross-Agent MVP Integration Order
1. Agent 1: real proxy + auth + required endpoints.
2. Agent 3: schema/code alignment + metering write integration + jobs timing fix.
3. Agent 2: wrapper recursion fix + explicit Claude binary path.
4. End-to-end C1 smoke: CLI -> API proxy -> ledger writes -> pool health/usage reads.

## Definition of “Good for C1”
- Internal team can run real traffic via proxy.
- Failover/queue/kill-switch behavior works under basic failure tests.
- Usage and reconciliation data are written consistently enough for internal trust.
- CLI setup is reliable and does not recurse/hang.
