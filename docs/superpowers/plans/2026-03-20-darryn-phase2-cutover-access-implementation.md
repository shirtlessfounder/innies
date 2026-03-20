# Darryn Phase 2 Cutover And Access Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Darryn-specific cutover and access backend seam so `fnf` can be created, Darryn can authenticate via GitHub, admins can impersonate his pilot context, and buyer-key / token-credential ownership can move to `fnf` without transient dual-home admissions.

**Architecture:** Keep base-table `org_id` ownership authoritative after cutover so existing buyer keys and token credentials resolve to `fnf` without reconnects. Add one explicit admission-freeze layer for in-flight cutover/rollback windows, plus one signed pilot-session contract for Darryn GitHub auth and admin impersonation. Cutover orchestration owns the freeze lifecycle, ownership-table writes, base-table reassignments, and cutover/rollback record creation, but it only completes cutover after a reserve-floor migration adapter reports success.

**Tech Stack:** TypeScript, Express, Postgres SQL migrations, Vitest, signed HMAC session tokens, GitHub OAuth HTTP calls

---

## Contract

### Auth / session APIs

- `GET /v1/pilot/session`
  - Auth: signed pilot session token from `Authorization: Bearer <token>` or `innies_pilot_session` cookie
  - Response: `200` with `sessionKind` in `darryn_self | admin_self | admin_impersonation`, actor metadata, effective org context, and impersonation metadata when present
- `GET /v1/pilot/auth/github/start`
  - Query: optional `returnTo`
  - Response: `302` redirect to GitHub OAuth authorize URL with signed state
- `GET /v1/pilot/auth/github/callback`
  - Query: `code`, `state`
  - Behavior: exchange code, fetch GitHub user, enforce allowlist, ensure Darryn user + `fnf` membership exist, mint pilot session token, set `innies_pilot_session`, redirect to `returnTo`
- `POST /v1/pilot/session/logout`
  - Behavior: clear `innies_pilot_session`
- `POST /v1/admin/pilot/session`
  - Auth: existing admin API key
  - Body: `{ mode: 'self' }` or `{ mode: 'impersonation', targetUserId: string, targetOrgId?: string }`
  - Response: `200` with pilot session token and the same session payload returned by `GET /v1/pilot/session`

### Cutover / rollback APIs

- `POST /v1/admin/pilot/cutover`
  - Auth: existing admin API key
  - Body:
    - `sourceOrgId`
    - `targetOrgSlug`
    - `targetOrgName`
    - `targetUserEmail`
    - `targetUserDisplayName`
    - `buyerKeyIds[]`
    - `tokenCredentialIds[]`
    - optional `effectiveAt`
  - Behavior:
    - create / find `fnf` org
    - create / find Darryn user
    - ensure Darryn membership in `fnf`
    - create visible admission freezes for the migrating buyer keys and token credentials
    - inside one DB transaction: update base-table `org_id` ownership, upsert F&F ownership rows, call reserve-floor migration adapter, create committed cutover row
    - release freezes after success; retain failure details if the cutover aborts before commit
- `POST /v1/admin/pilot/rollback`
  - Auth: existing admin API key
  - Body:
    - optional `sourceCutoverId`
    - `targetOrgId`
    - `buyerKeyIds[]`
    - `tokenCredentialIds[]`
    - optional `effectiveAt`
  - Behavior:
    - freeze the same admission surfaces
    - move buyer keys and credentials back to the reverted target org
    - refresh F&F ownership rows to match the reverted state
    - create rollback row
    - release freezes after success

### Runtime seams

- Buyer-key admissions fail closed when an active buyer-key migration freeze exists.
- Token-credential sold admissions fail closed when an active token-credential migration freeze exists.
- Reserve-floor migration is an injected adapter:
  - `migrateReserveFloors({ fromOrgId, toOrgId, targetUserId, cutoverId, actorUserId })`
  - runtime default may be a not-configured adapter until routing lands

## Chunk 1: Freeze And Ownership Foundations

### Task 1: Add the cutover-access storage contract

**Files:**
- Create: `docs/migrations/018_darryn_cutover_access.sql`
- Create: `docs/migrations/018_darryn_cutover_access_no_extensions.sql`
- Test: `api/tests/darrynCutoverAccessMigrations.test.ts`

- [ ] **Step 1: Write the failing migration test**

Cover:
- active admission-freeze storage for `buyer_key` and `token_credential`
- indexes for active-freeze reads
- any support columns needed for failure metadata / release metadata

- [ ] **Step 2: Run the focused migration test and verify RED**

Run: `npm test -- --run tests/darrynCutoverAccessMigrations.test.ts`
Expected: FAIL because migration files do not exist yet

- [ ] **Step 3: Add the minimal migration pair**

Constraints:
- no routing reserve-floor storage here
- no wallet / earnings schema here
- only cutover-access-local operational storage

- [ ] **Step 4: Re-run the focused migration test and verify GREEN**

Run: `npm test -- --run tests/darrynCutoverAccessMigrations.test.ts`
Expected: PASS

### Task 2: Add repository seams for org/user/membership bootstrap and admission freezes

**Files:**
- Create: `api/src/repos/pilotIdentityRepository.ts`
- Create: `api/src/repos/pilotAdmissionFreezeRepository.ts`
- Modify: `api/src/repos/tableNames.ts`
- Test: `api/tests/pilotIdentityRepository.test.ts`
- Test: `api/tests/pilotAdmissionFreezeRepository.test.ts`

- [ ] **Step 1: Write the failing repository tests**

Cover:
- create/find org by slug
- create/find user by email
- ensure membership idempotently
- reassign API key org ids
- reassign token credential org ids
- activate and release admission freezes
- read active buyer-key freeze
- exclude released freezes from reads

- [ ] **Step 2: Run the focused repository tests and verify RED**

Run: `npm test -- --run tests/pilotIdentityRepository.test.ts tests/pilotAdmissionFreezeRepository.test.ts`
Expected: FAIL because the repos do not exist yet

- [ ] **Step 3: Implement the minimal repositories**

Requirements:
- use base tables for authoritative `org_id` reassignment
- keep F&F ownership tables as explicit mappings, not substitutes for base-table ownership
- keep freeze reads small and deterministic

- [ ] **Step 4: Re-run the focused repository tests and verify GREEN**

Run: `npm test -- --run tests/pilotIdentityRepository.test.ts tests/pilotAdmissionFreezeRepository.test.ts`
Expected: PASS

## Chunk 2: Cutover Service And Freeze Enforcement

### Task 3: Add the cutover / rollback orchestration service

**Files:**
- Create: `api/src/services/pilot/pilotCutoverService.ts`
- Modify: `api/src/repos/fnfOwnershipRepository.ts`
- Modify: `api/src/repos/pilotCutoverRepository.ts`
- Modify: `api/src/services/runtime.ts`
- Test: `api/tests/pilotCutoverService.test.ts`

- [ ] **Step 1: Write the failing service tests**

Cover:
- cutover success path creates org/user/membership, writes base-table ownership changes, upserts F&F ownership rows, calls reserve-floor migration adapter, creates committed cutover row, and releases freezes
- cutover failure before reserve-floor migration success leaves no committed cutover row and keeps admissions fail-closed
- rollback success reassigns ownership back, creates rollback row, and releases freezes
- actor user id is optional for admin API-key initiated operations

- [ ] **Step 2: Run the focused service test and verify RED**

Run: `npm test -- --run tests/pilotCutoverService.test.ts`
Expected: FAIL because the service does not exist yet

- [ ] **Step 3: Implement the minimal orchestration service**

Requirements:
- visible freeze rows are committed before migration work starts
- base-table ownership changes and cutover / rollback rows are inside one DB transaction
- cutover row is inserted only after `migrateReserveFloors(...)` succeeds
- no wallet, routing policy, or reserve-floor storage logic in this service

- [ ] **Step 4: Re-run the focused service test and verify GREEN**

Run: `npm test -- --run tests/pilotCutoverService.test.ts`
Expected: PASS

### Task 4: Enforce fail-closed freezes in auth and token routing

**Files:**
- Modify: `api/src/middleware/auth.ts`
- Modify: `api/src/repos/apiKeyRepository.ts`
- Modify: `api/src/repos/tokenCredentialRepository.ts`
- Modify: `api/src/services/runtime.ts`
- Test: `api/tests/auth.middleware.test.ts`
- Test: `api/tests/tokenCredentialRepository.test.ts`

- [ ] **Step 1: Write the failing freeze-enforcement tests**

Cover:
- buyer-key auth rejects requests when the key has an active migration freeze
- token credential routing excludes actively frozen credentials
- released freezes no longer block admissions

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run tests/auth.middleware.test.ts tests/tokenCredentialRepository.test.ts`
Expected: FAIL on the new freeze cases

- [ ] **Step 3: Implement the minimal enforcement**

Requirements:
- buyer-key failures use an explicit fail-closed application error
- token-credential filtering does not mutate existing provider-lane or contribution-cap logic

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Run: `npm test -- --run tests/auth.middleware.test.ts tests/tokenCredentialRepository.test.ts`
Expected: PASS

## Chunk 3: Pilot Session And Route Wiring

### Task 5: Add signed pilot-session and GitHub auth services

**Files:**
- Create: `api/src/services/pilot/pilotSessionService.ts`
- Create: `api/src/services/pilot/pilotGithubAuthService.ts`
- Modify: `api/src/types/express.d.ts`
- Test: `api/tests/pilotSessionService.test.ts`
- Test: `api/tests/pilotGithubAuthService.test.ts`

- [ ] **Step 1: Write the failing auth/session tests**

Cover:
- session token sign/verify for `darryn_self`, `admin_self`, and `admin_impersonation`
- cookie or bearer extraction for session reads
- GitHub callback allowlists by login / verified email
- successful callback ensures Darryn membership in `fnf`

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run tests/pilotSessionService.test.ts tests/pilotGithubAuthService.test.ts`
Expected: FAIL because the services do not exist yet

- [ ] **Step 3: Implement the minimal services**

Requirements:
- keep the session payload small and explicit
- use one signing secret
- do not add server-side session storage unless tests force it

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Run: `npm test -- --run tests/pilotSessionService.test.ts tests/pilotGithubAuthService.test.ts`
Expected: PASS

### Task 6: Wire the pilot and admin routes plus runbook docs

**Files:**
- Create: `api/src/routes/pilot.ts`
- Modify: `api/src/routes/admin.ts`
- Modify: `api/src/server.ts`
- Modify: `docs/ops/RUNBOOK.md`
- Test: `api/tests/pilot.route.test.ts`
- Test: `api/tests/admin.pilot.route.test.ts`

- [ ] **Step 1: Write the failing route tests**

Cover:
- GitHub auth start / callback / logout
- `GET /v1/pilot/session`
- `POST /v1/admin/pilot/session`
- `POST /v1/admin/pilot/cutover`
- `POST /v1/admin/pilot/rollback`
- route-level validation and auth failures

- [ ] **Step 2: Run the focused route tests and verify RED**

Run: `npm test -- --run tests/pilot.route.test.ts tests/admin.pilot.route.test.ts`
Expected: FAIL because the routes do not exist yet

- [ ] **Step 3: Implement the minimal route wiring and runbook updates**

Runbook must cover:
- safe cutover sequence
- reserve-floor adapter dependency
- rollback sequence
- freeze cleanup when a cutover attempt aborts

- [ ] **Step 4: Re-run the focused route tests and verify GREEN**

Run: `npm test -- --run tests/pilot.route.test.ts tests/admin.pilot.route.test.ts`
Expected: PASS

## Chunk 4: Verification And Integration

### Task 7: Run verification and capture the remaining dependency seam cleanly

**Files:**
- Read: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Read: `docs/planning/PHASE2_IMPLEMENTATION_SCOPE.md`
- Read: `docs/superpowers/specs/2026-03-19-darryn-pilot-workspace-split-design.md`
- Read: `docs/superpowers/plans/2026-03-19-darryn-pilot-workspace-launch.md`

- [ ] **Step 1: Run the targeted cutover/access suite**

Run: `npm test -- --run tests/darrynCutoverAccessMigrations.test.ts tests/pilotIdentityRepository.test.ts tests/pilotAdmissionFreezeRepository.test.ts tests/pilotCutoverService.test.ts tests/auth.middleware.test.ts tests/pilotSessionService.test.ts tests/pilotGithubAuthService.test.ts tests/pilot.route.test.ts tests/admin.pilot.route.test.ts`
Expected: PASS

- [ ] **Step 2: Run the full backend suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Build the backend**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Verify the requirements checklist**

Confirm:
- base-table buyer-key and token-credential ownership can move to `fnf`
- active migration windows fail closed
- committed cutover and rollback rows are created explicitly
- Darryn GitHub auth and admin impersonation session seams exist
- reserve-floor migration is an explicit dependency seam, not hidden routing logic in this branch
