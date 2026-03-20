# Darryn Cutover And Access Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Darryn Phase 2 cutover-and-access backend so Darryn can authenticate into the pilot, admins can impersonate his context, and buyer-key or token-credential ownership flips only become live after an explicit committed cutover or rollback marker.

**Architecture:** Keep historical `in_api_keys` and `in_token_credentials` rows intact and layer pilot ownership through the landed Foundation repositories plus a narrow cutover-freeze table. Buyer-key auth resolves an effective org from committed cutover or rollback markers and fails closed while a migration freeze is active. Pilot web auth uses GitHub OAuth plus signed backend sessions, with explicit self-context and admin impersonation context routes.

**Tech Stack:** TypeScript, Express, Postgres SQL migrations, Vitest

---

## Chunk 1: Data Contracts And Freeze State

### Task 1: Add cutover-access persistence for GitHub identity and migration freeze state

**Files:**
- Create: `docs/migrations/018_darryn_cutover_access.sql`
- Create: `docs/migrations/018_darryn_cutover_access_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`
- Create: `api/src/repos/pilotIdentityRepository.ts`
- Create: `api/src/repos/pilotCutoverFreezeRepository.ts`
- Test: `api/tests/darrynCutoverAccessMigrations.test.ts`
- Test: `api/tests/pilotIdentityRepository.test.ts`
- Test: `api/tests/pilotCutoverFreezeRepository.test.ts`

- [ ] **Step 1: Write the failing migration and repository tests**

Cover:
- GitHub identity storage for allowlisted pilot users
- durable freeze rows for `cutover` and `rollback`
- active-freeze lookup by buyer key and token credential

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:
```bash
cd api && npm test -- darrynCutoverAccessMigrations pilotIdentityRepository pilotCutoverFreezeRepository
```

- [ ] **Step 3: Add the minimal schema and repositories**

Implement:
- `in_github_identities`
- `in_pilot_cutover_freezes`
- `in_pilot_cutover_freeze_credentials`
- focused repository methods only for this workstream

- [ ] **Step 4: Re-run the targeted tests and keep them green**

Run:
```bash
cd api && npm test -- darrynCutoverAccessMigrations pilotIdentityRepository pilotCutoverFreezeRepository
```

## Chunk 2: Cutover Resolution And Admin Operations

### Task 2: Implement effective-org resolution, fail-closed freeze behavior, and committed cutover or rollback writes

**Files:**
- Modify: `api/src/repos/apiKeyRepository.ts`
- Modify: `api/src/repos/tokenCredentialRepository.ts`
- Modify: `api/src/types/express.d.ts`
- Modify: `api/src/middleware/auth.ts`
- Modify: `api/src/services/runtime.ts`
- Create: `api/src/services/pilotAccessService.ts`
- Modify: `api/src/routes/admin.ts`
- Test: `api/tests/pilotAccessService.test.ts`
- Test: `api/tests/auth.middleware.test.ts`
- Test: `api/tests/admin.pilotCutover.route.test.ts`

- [ ] **Step 1: Write failing service and route tests**

Cover:
- buyer key resolves to `fnf` only after committed cutover
- rollback returns future admissions to historical `innies`
- active freeze blocks new admissions before marker commit
- cutover commit fails closed if reserve-floor migration handshake is unavailable or fails
- admin cutover and rollback routes write committed records only after the correct sequencing

- [ ] **Step 2: Run the targeted tests to verify the red state**

Run:
```bash
cd api && npm test -- pilotAccessService auth.middleware admin.pilotCutover.route
```

- [ ] **Step 3: Implement the minimal cutover service and admin routes**

Implement:
- effective buyer-key and token-credential ownership resolution from Foundation mapping plus latest committed cutover or rollback
- active migration freeze checks
- `fnf` org ensure flow and Darryn membership bootstrap
- admin cutover and rollback endpoints
- a fail-closed routing reserve-floor migrator seam in runtime

- [ ] **Step 4: Re-run the targeted tests and keep them green**

Run:
```bash
cd api && npm test -- pilotAccessService auth.middleware admin.pilotCutover.route
```

## Chunk 3: GitHub Allowlist Sessions And Runbook

### Task 3: Expose pilot auth and session context for Darryn self, admin self, and admin impersonation

**Files:**
- Modify: `api/src/types/express.d.ts`
- Modify: `api/src/services/runtime.ts`
- Create: `api/src/services/pilotSessionService.ts`
- Create: `api/src/routes/pilot.ts`
- Modify: `api/src/server.ts`
- Create: `docs/ops/DARRYN_PILOT_CUTOVER_ROLLBACK_RUNBOOK.md`
- Test: `api/tests/pilotSessionService.test.ts`
- Test: `api/tests/pilot.route.test.ts`

- [ ] **Step 1: Write failing session tests first**

Cover:
- Darryn GitHub callback only succeeds for the allowlisted login
- admin GitHub callback yields admin self-context
- admin impersonation switches active context to Darryn without losing actor identity
- session read endpoint returns the downstream contract for pilot web and API callers

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:
```bash
cd api && npm test -- pilotSessionService pilot.route
```

- [ ] **Step 3: Implement the minimal session flow and rollback runbook**

Implement:
- GitHub OAuth callback exchange plus allowlist check
- signed pilot session cookie or bearer contract
- impersonation enter/clear routes
- session introspection route
- rollback runbook with freeze, verification, rollback, and post-rollback checks

- [ ] **Step 4: Re-run the targeted tests and keep them green**

Run:
```bash
cd api && npm test -- pilotSessionService pilot.route
```

## Final Verification

- [ ] **Step 1: Run the full API test suite**

Run:
```bash
cd api && npm test
```

- [ ] **Step 2: Re-read the required source docs and verify the implementation against them**

Check:
- `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- `docs/planning/PHASE2_IMPLEMENTATION_SCOPE.md`
- `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- `docs/superpowers/plans/2026-03-19-darryn-pilot-workspace-launch.md`

- [ ] **Step 3: Commit and open the PR**

Run:
```bash
git add docs/migrations docs/ops api/src api/tests docs/superpowers/plans/2026-03-20-darryn-cutover-access-implementation.md
git commit -m "feat: add darryn cutover access flow"
gh pr create --base main --title "feat: add darryn cutover access flow" --body-file .context/pr-body.md
```
