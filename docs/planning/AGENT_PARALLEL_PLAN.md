# Headroom Parallel Build Plan (3 Agents)

## Purpose
Coordinate 3-agent parallel execution for Checkpoint 1 implementation while DB extension permissions are pending.

---

## Agent 1 (Core API + Contracts)

### Scope
1. Scaffold `headroom/api` service structure.
2. Implement core routing engine:
- weighted round-robin
- health states
- retry/failover matrix
- capacity queue policy (queue=20, wait timeout=8s, per-org concurrency=3)
3. Define and implement HTTP contracts:
- `POST /v1/proxy/*`
- `GET /v1/admin/pool-health`
- standard error codes + response schemas
4. Add streaming passthrough plumbing + correlation IDs.

### Deliverables
- `headroom/api/...` core service code
- `headroom/docs/API_CONTRACT.md`
- unit tests for router/failover/queue logic

---

## Agent 2 (CLI + Local UX)

### Scope
1. Build `headroom` CLI commands:
- `headroom login --token <hr_token>`
- `headroom doctor`
- `headroom claude`
- `headroom link claude`
2. Implement local config storage/loading and env wiring.
3. Implement Claude wrapper invocation behavior.
4. Add CLI smoke tests and user-facing status/error messaging.

### Deliverables
- `headroom/cli/...`
- `headroom/docs/CLI_UX.md`
- smoke test script for local command flow

---

## Agent 3 (Data/Jobs + Dashboard Shell)

### Scope
1. Build DB repository layer + SQL wrapper interfaces (ready for migration-enabled DB).
2. Build metering write path abstractions:
- usage row creation
- correction/reversal row creation
3. Build job framework + schedule wiring:
- idempotency purge (hourly)
- daily aggregates (5 min incremental + nightly compaction)
- reconciliation (daily 02:00 UTC)
4. Build minimal dashboard shell pages with mock adapters:
- seller keys
- buyer usage
- pool health

### Deliverables
- `headroom/api/repos/...`
- `headroom/api/jobs/...`
- `headroom/ui/...` shell pages/components
- `headroom/docs/JOBS_AND_DATAFLOW.md`

---

## Shared Contracts and Rules

1. Contract source of truth
- `headroom/docs/API_CONTRACT.md` is the canonical API interface for all agents.

2. File ownership boundaries
- Agent 1 owns: `api/routes`, `api/services/router`, `docs/API_CONTRACT.md`
- Agent 2 owns: `cli/*`
- Agent 3 owns: `api/repos`, `api/jobs`, `ui/*`

3. Cross-edit policy
- Do not edit files owned by another agent unless explicitly coordinated.

4. Cross-cutting standards
- Use shared correlation/request IDs across CLI -> API -> jobs/repo logs.
- Use identical error code taxonomy from API contract.
- Keep runtime behavior aligned with `TECHNICAL_SCOPE.md` C1 decision lock.

---

## Merge/Integration Order

1. Agent 1 lands API contract + routing core.
2. Agent 3 integrates repos/jobs to the published contract.
3. Agent 2 integrates CLI against running API endpoints.
4. Final integration pass verifies:
- routing + failover
- CLI onboarding/runtime UX
- metering/job pipelines
- baseline dashboard rendering

---

## C1 Completion Criteria for Parallel Track

- API contract stable and implemented.
- CLI commands usable by internal testers.
- Routing/failover/queue policies working per scope defaults.
- Metering/event writing path functional with append-only behavior.
- Job scheduler running with expected cadence.
- Dashboard shell available for keys/usage/pool health.

