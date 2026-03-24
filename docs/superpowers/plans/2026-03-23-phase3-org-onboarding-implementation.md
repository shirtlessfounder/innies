# Phase 3 Org Onboarding MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first self-serve org product so users can sign in with GitHub, create orgs, invite GitHub users, accept invites at `/{orgSlug}`, receive one org-scoped buyer key per active membership, manage org-borrowed Claude/Codex tokens, and view org-scoped analytics.

**Architecture:** Land one additive backend foundation first: schema, org invite/membership repos, org buyer-key provisioning, org web session/auth services, and runtime wiring for the new repo/service seams. Then layer route/UI generalization on top of that foundation: split Express org subrouters, org-scoped analytics filters, new Next `/{orgSlug}` pages, and parameterized analytics clients. Keep pilot routes alive and move the internal analytics home to `/innies` instead of trying to delete old surfaces in the same pass.

**Tech Stack:** TypeScript, Express, Next.js App Router, Postgres SQL migrations, Vitest, Node test runner, signed HMAC cookies/sessions

---

## File Map

### Backend Foundation

- Create: `docs/migrations/022_phase3_org_onboarding.sql`
- Create: `docs/migrations/022_phase3_org_onboarding_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`
- Create: `api/src/repos/orgInviteRepository.ts`
- Create: `api/src/repos/orgAccessRepository.ts`
- Create: `api/src/repos/orgBuyerKeyRepository.ts`
- Create: `api/src/services/org/orgSlug.ts`
- Create: `api/src/services/org/orgSessionService.ts`
- Create: `api/src/services/org/orgSessionCookie.ts`
- Create: `api/src/repos/orgTokenRepository.ts`
- Create: `api/src/services/org/orgGithubAuthService.ts`
- Create: `api/src/services/org/orgMembershipService.ts`
- Create: `api/src/services/org/orgTokenManagementService.ts`
- Modify: `api/src/services/runtime.ts`

### Backend Routes

- Create: `api/src/routes/org.ts`
- Create: `api/src/routes/orgAuth.ts`
- Create: `api/src/routes/orgAccess.ts`
- Create: `api/src/routes/orgManagement.ts`
- Create: `api/src/routes/orgAnalytics.ts`
- Create: `api/src/routes/adminOrgs.ts`
- Modify: `api/src/repos/analyticsRepository.ts`
- Modify: `api/src/server.ts`
- Modify: `api/src/types/express.d.ts`

### UI Surface

- Create: `ui/src/lib/org/types.ts`
- Create: `ui/src/lib/org/server.ts`
- Create: `ui/src/lib/org/sessionCookie.ts`
- Create: `ui/src/components/org/OrgCreationForm.tsx`
- Create: `ui/src/components/org/InviteAcceptanceCard.tsx`
- Create: `ui/src/components/org/OrgDashboardTokens.tsx`
- Create: `ui/src/components/org/OrgDashboardMembers.tsx`
- Modify: `ui/src/lib/analytics/client.ts`
- Modify: `ui/src/hooks/useAnalyticsDashboard.ts`
- Modify: `ui/src/hooks/useAnalyticsSeries.ts`
- Modify: `ui/src/app/analytics/AnalyticsDashboardClient.tsx`
- Create: `ui/src/components/org/OrgDashboardSections.tsx`
- Create: `ui/src/components/org/orgDashboard.module.css`
- Create: `ui/src/app/[orgSlug]/page.tsx`
- Create: `ui/src/app/innies/page.tsx`
- Modify: `ui/src/app/analytics/page.tsx`
- Modify: `ui/src/app/page.tsx`

### Next API Handlers

- Create: `ui/src/app/api/orgs/create/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/analytics/dashboard/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/analytics/timeseries/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/invites/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/invites/accept/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/invites/revoke/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/leave/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/members/[memberUserId]/remove/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/tokens/add/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/tokens/[tokenId]/refresh/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/tokens/[tokenId]/remove/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/reveal/dismiss/route.ts`
- Create: `ui/src/app/api/orgs/session/logout/route.ts`

### Tests

- Create: `api/tests/phase3OrgOnboardingMigrations.test.ts`
- Create: `api/tests/orgSlug.test.ts`
- Create: `api/tests/orgSessionService.test.ts`
- Create: `api/tests/orgSessionCookie.test.ts`
- Create: `api/tests/orgInviteRepository.test.ts`
- Create: `api/tests/orgAccessRepository.test.ts`
- Create: `api/tests/orgBuyerKeyRepository.test.ts`
- Create: `api/tests/orgTokenRepository.test.ts`
- Create: `api/tests/orgGithubAuthService.test.ts`
- Create: `api/tests/orgMembershipService.test.ts`
- Create: `api/tests/orgTokenManagementService.test.ts`
- Create: `api/tests/org.route.test.ts`
- Create: `api/tests/admin.orgs.route.test.ts`
- Modify: `api/tests/analyticsRepository.test.ts`
- Create: `ui/tests/orgDashboard.test.mjs`
- Create: `ui/tests/orgApiHandlers.test.mjs`
- Modify: `ui/tests/pilotDashboard.test.mjs`

### Suggested Workspace Split

- Workspace A: Chunk 1 only. This is the contract/foundation branch and should merge first.
- Workspace B: Chunk 2 after Chunk 1 merges.
- Workspace C: Chunk 3 after Chunk 1 merges. Chunk 3 can run in parallel with Chunk 2 if it consumes the landed backend contracts instead of inventing its own.

## Chunk 1: Backend Foundation

### Task 1: Add the additive Phase 3 schema

**Files:**
- Create: `docs/migrations/022_phase3_org_onboarding.sql`
- Create: `docs/migrations/022_phase3_org_onboarding_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`
- Test: `api/tests/phase3OrgOnboardingMigrations.test.ts`

- [ ] **Step 1: Write the failing migration test**

Cover:
- both `022_phase3_org_onboarding.sql` and `022_phase3_org_onboarding_no_extensions.sql`
- `in_users.github_login`
- `in_orgs.owner_user_id`
- `in_memberships.ended_at`
- `in_api_keys.membership_id`
- new `in_org_invites` table with `pending | revoked | accepted`
- invite creator attribution on `in_org_invites.created_by_user_id`
- preserve one membership row per `(org_id, user_id)` so rejoin reactivates the existing row
- partial uniqueness for one pending invite per `(org_id, github_login)`
- partial uniqueness for one active buyer key per membership

- [ ] **Step 2: Run the focused migration test and verify RED**

Run: `cd api && npm test -- phase3OrgOnboardingMigrations.test.ts`
Expected: FAIL because migration `022` does not exist yet

- [ ] **Step 3: Add the migration pair**

Use an additive DDL shape like:

```sql
alter table in_users add column github_login text;
alter table in_orgs add column owner_user_id uuid references in_users(id);
alter table in_memberships add column ended_at timestamptz;
alter table in_api_keys add column membership_id uuid references in_memberships(id);

create table in_org_invites (
  id uuid primary key,
  org_id uuid not null references in_orgs(id),
  github_login text not null,
  created_by_user_id uuid not null references in_users(id),
  status text not null check (status in ('pending', 'revoked', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz null,
  revoked_at timestamptz null,
  accepted_by_user_id uuid null references in_users(id),
  revoked_by_user_id uuid null references in_users(id)
);
```

Also add the partial indexes/constraints required by the spec and `TABLES.orgInvites`, while preserving the existing one-row-per-`(org_id, user_id)` membership invariant.
Pin them explicitly in the migration test and SQL:
- preserve the existing unique membership constraint on `(org_id, user_id)`
- add a partial unique index for one pending invite per `(org_id, github_login)` where `status = 'pending'`
- add a partial unique index for one active buyer key per `membership_id` where `membership_id is not null and revoked_at is null`

- [ ] **Step 4: Re-run the focused migration test and verify GREEN**

Run: `cd api && npm test -- phase3OrgOnboardingMigrations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/migrations/022_phase3_org_onboarding.sql docs/migrations/022_phase3_org_onboarding_no_extensions.sql api/src/repos/tableNames.ts api/tests/phase3OrgOnboardingMigrations.test.ts
git commit -m "feat: add phase 3 org onboarding schema"
```

### Task 2: Add slug/session/reveal primitives

**Files:**
- Create: `api/src/services/org/orgSlug.ts`
- Create: `api/src/services/org/orgSessionService.ts`
- Create: `api/src/services/org/orgSessionCookie.ts`
- Test: `api/tests/orgSessionCookie.test.ts`
- Test: `api/tests/orgSlug.test.ts`
- Test: `api/tests/orgSessionService.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Cover:
- slug normalization rules from the spec
- reserved slug rejection
- deterministic slug generation
- signed session issue/read
- `buildOrgSessionCookie()` / `buildClearOrgSessionCookie()` mirror the pilot cookie-domain behavior
- short-lived reveal cookie encrypt/read/clear behavior
- reveal cookie is `HttpOnly`, short-lived, scoped to `/{orgSlug}`, and survives until explicit dismissal

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd api && npm test -- orgSlug.test.ts orgSessionService.test.ts orgSessionCookie.test.ts`
Expected: FAIL because the services do not exist yet

- [ ] **Step 3: Implement the minimal primitives**

Use explicit interfaces:

```ts
export function normalizeOrgSlug(name: string): string
export function assertOrgSlugAllowed(slug: string): void

export type OrgWebSession = {
  actorUserId: string
  githubLogin: string
  issuedAt: string
  expiresAt: string
}

export type IssueOrgWebSessionInput = {
  actorUserId: string
  githubLogin: string
}

export class OrgSessionService {
  issueSession(input: IssueOrgWebSessionInput): string
  readSession(token: string): OrgWebSession | null
}
```

`orgSessionCookie.ts` should mirror the pilot cookie-domain logic instead of inventing a different cookie policy, and it should own both the org web-session cookie helpers and the org reveal-cookie helpers:

```ts
export function buildOrgSessionCookie(token: string): string
export function buildClearOrgSessionCookie(): string
export function readOrgSessionTokenFromRequest(req: {
  header(name: string): string | undefined
}): string | null
export function buildOrgRevealCookie(input: {
  orgSlug: string
  buyerKey: string
  reason: 'org_created' | 'invite_accepted'
}): string
export function readOrgRevealCookie(input: {
  orgSlug: string
  cookieHeader: string | null
}): { buyerKey: string; reason: 'org_created' | 'invite_accepted' } | null
export function buildClearOrgRevealCookie(orgSlug: string): string
```

Lock the reveal-cookie contract here:
- encrypt and authenticate the plaintext reveal payload; do not just base64-encode it
- mark it `HttpOnly`
- scope it to `Path=/{orgSlug}`
- give it `Max-Age=600`
- clear it only on the explicit reveal-dismissal POST
- leave it intact after a failed page load so the next authenticated GET to `/{orgSlug}` can still reveal the key once
- read the request token with bearer precedence over cookie, mirroring `PilotSessionService.readTokenFromRequest()`
- use `process.env.ORG_SESSION_SECRET || 'dev-insecure-org-session-secret'` for session signing, matching the pilot secret pattern
- use `process.env.ORG_REVEAL_SECRET || 'dev-insecure-org-reveal-secret'` for reveal-cookie encryption/authentication

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Run: `cd api && npm test -- orgSlug.test.ts orgSessionService.test.ts orgSessionCookie.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/services/org/orgSlug.ts api/src/services/org/orgSessionService.ts api/src/services/org/orgSessionCookie.ts api/tests/orgSlug.test.ts api/tests/orgSessionService.test.ts api/tests/orgSessionCookie.test.ts
git commit -m "feat: add org session and slug primitives"
```

### Task 3: Add org access, invite, buyer-key, and token repo seams

**Files:**
- Create: `api/src/repos/orgInviteRepository.ts`
- Create: `api/src/repos/orgAccessRepository.ts`
- Create: `api/src/repos/orgBuyerKeyRepository.ts`
- Create: `api/src/repos/orgTokenRepository.ts`
- Modify: `api/src/services/runtime.ts`
- Test: `api/tests/orgInviteRepository.test.ts`
- Test: `api/tests/orgAccessRepository.test.ts`
- Test: `api/tests/orgBuyerKeyRepository.test.ts`
- Test: `api/tests/orgTokenRepository.test.ts`

- [ ] **Step 1: Write the failing repository tests**

Cover:
- create/find org by slug
- list orgs for admin discovery
- create/update user github login with trim + lowercase normalization before persistence and lookup
- create owner membership
- persist every Phase 3 membership, including the owner, with role `buyer`
- resolve auth state by `(orgSlug, githubLogin)` as exactly one of:
  - `active_membership`
  - `pending_invite`
  - `no_access`
- pending invite refresh keeps one active pending row per login
- re-whitelisting a revoked or accepted login creates a fresh pending invite row
- reject invite creation for an already-active member as `already_a_member`
- reactivate ended membership without creating a second active row
- create one active buyer key per membership
- revoke the active buyer key idempotently
- list members with owner flag
- list pending invites with creator attribution
- list org buyer keys with membership/user attribution
- list org token inventory with creator attribution and reserve percentages
- list member tokens
- mark invites accepted/revoked
- revoke a buyer key by `apiKeyId`
- rotate a membership buyer key
- remove member tokens by `(orgId, createdByUserId)`

- [ ] **Step 2: Run the focused repository tests and verify RED**

Run: `cd api && npm test -- orgInviteRepository.test.ts orgAccessRepository.test.ts orgBuyerKeyRepository.test.ts orgTokenRepository.test.ts`
Expected: FAIL because the repos/methods do not exist yet

- [ ] **Step 3: Implement org access/discovery repo wiring**

Use focused contracts instead of growing `ApiKeyRepository`, `PilotIdentityRepository`, or `tokenCredentialRepository` into catch-alls:

```ts
export type OrgAuthResolution =
  | {
      kind: 'active_membership'
      orgId: string
      orgSlug: string
      orgName: string
      userId: string
      membershipId: string
      isOwner: boolean
    }
  | {
      kind: 'pending_invite'
      orgId: string
      orgSlug: string
      orgName: string
      inviteId: string
    }
  | {
      kind: 'no_access'
      orgId: string | null
      orgSlug: string
      orgName: string | null
    }

class OrgAccessRepository {
  createOrgWithOwner(input: {
    orgId: string
    orgName: string
    orgSlug: string
    ownerUserId: string
    ownerMembershipId: string
  }): Promise<void>
  upsertGithubLogin(userId: string, githubLogin: string): Promise<void>
  listOrgs(): Promise<Array<{ id: string; slug: string; name: string; ownerUserId: string }>>
  findOrgBySlug(orgSlug: string): Promise<{ id: string; slug: string; name: string; ownerUserId: string } | null>
  findAuthResolutionBySlugAndGithubLogin(input: {
    orgSlug: string
    githubLogin: string
  }): Promise<OrgAuthResolution>
  activateMembership(input: {
    orgId: string
    userId: string
    membershipId: string
  }): Promise<{ membershipId: string; reactivated: boolean }>
  endMembership(input: {
    orgId: string
    userId: string
  }): Promise<{ membershipId: string }>
  listMembers(orgId: string): Promise<Array<{
    userId: string
    githubLogin: string | null
    membershipId: string
    isOwner: boolean
  }>>
}
```

`OrgAccessRepository` stays bounded to org discovery, GitHub-login persistence, auth resolution, membership lifecycle, and member listing. Keep invite, buyer-key, and token logic out of this file.

- [ ] **Step 4: Implement invite and buyer-key repositories**

```ts

class OrgInviteRepository {
  createOrRefreshPendingInvite(input: {
    inviteId: string
    orgId: string
    githubLogin: string
    createdByUserId: string
  }): Promise<{ inviteId: string; createdFresh: boolean }>
  listPendingByOrg(orgId: string): Promise<Array<{
    inviteId: string
    githubLogin: string
    createdAt: string
    createdByUserId: string
  }>>
  markRevoked(input: {
    inviteId: string
    revokedByUserId: string
  }): Promise<void>
  markAccepted(input: {
    inviteId: string
    acceptedByUserId: string
  }): Promise<void>
}

class OrgBuyerKeyRepository {
  createMembershipBuyerKey(tx: TxSql, input: {
    membershipId: string
    orgId: string
    userId: string
  }): Promise<{
    apiKeyId: string
    plaintextKey: string
  }>
  revokeMembershipBuyerKey(tx: TxSql, membershipId: string): Promise<void>
  revokeBuyerKeyById(apiKeyId: string): Promise<void>
  rotateMembershipBuyerKey(input: {
    membershipId: string
    orgId: string
    userId: string
  }): Promise<{
    apiKeyId: string
    plaintextKey: string
  }>
  listOrgKeysWithMembers(orgId: string): Promise<Array<{
    apiKeyId: string
    membershipId: string
    userId: string
    githubLogin: string | null
    revokedAt: string | null
  }>>
}
```

class OrgTokenRepository {
  listOrgTokens(orgId: string): Promise<Array<{
    tokenId: string
    provider: string
    createdByUserId: string | null
    createdByGithubLogin: string | null
    fiveHourReservePercent: number
    sevenDayReservePercent: number
  }>>
  listMemberTokens(orgId: string, userId: string): Promise<Array<{
    tokenId: string
    provider: string
  }>>
  removeMemberTokens(tx: TxSql, orgId: string, userId: string): Promise<number>
}
```

Repository invariants to lock here:
- normalize GitHub logins by trimming and lowercasing on both persistence and invite/access lookup
- persist every Phase 3 membership row with role `buyer`; compute owner-only authority from `in_orgs.owner_user_id`
- `createOrRefreshPendingInvite()` may refresh an existing pending row, but re-whitelisting a revoked or accepted login must insert a fresh pending invite row
- register the new repositories on `api/src/services/runtime.ts` so later route/service tasks consume stable runtime dependencies instead of newing repositories inside handlers

- [ ] **Step 5: Implement the org token repository**

Implement `OrgTokenRepository` plus the runtime registration needed for later services/routes to consume it.

- [ ] **Step 6: Re-run the focused repository tests and verify GREEN**

Run: `cd api && npm test -- orgInviteRepository.test.ts orgAccessRepository.test.ts orgBuyerKeyRepository.test.ts orgTokenRepository.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add api/src/repos/orgInviteRepository.ts api/src/repos/orgAccessRepository.ts api/src/repos/orgBuyerKeyRepository.ts api/src/repos/orgTokenRepository.ts api/src/services/runtime.ts api/tests/orgInviteRepository.test.ts api/tests/orgAccessRepository.test.ts api/tests/orgBuyerKeyRepository.test.ts api/tests/orgTokenRepository.test.ts
git commit -m "feat: add org access and buyer key repos"
```

## Chunk 2: Org Backend APIs

### Task 4: Add org auth and membership orchestration services

**Files:**
- Create: `api/src/services/org/orgGithubAuthService.ts`
- Create: `api/src/services/org/orgMembershipService.ts`
- Create: `api/src/services/org/orgTokenManagementService.ts`
- Modify: `api/src/services/runtime.ts`
- Test: `api/tests/orgGithubAuthService.test.ts`
- Test: `api/tests/orgMembershipService.test.ts`
- Test: `api/tests/orgTokenManagementService.test.ts`

- [ ] **Step 1: Write the failing service tests**

Cover:
- GitHub auth resolves by requested org slug instead of a single target org
- auth start preserves `returnTo=/{orgSlug}` exactly through OAuth state
- unauthenticated org access round-trips back to the same `/{orgSlug}`
- callback persists the authenticated user’s normalized GitHub login before access resolution/session issuance
- org creation is one transaction and rolls back if buyer-key creation fails
- invite creation rejects an already-active member as `already_a_member`
- re-whitelisting a revoked or accepted login creates a fresh pending invite row instead of reopening history
- invite acceptance creates membership + buyer key + accepted invite atomically
- invite acceptance rolls back cleanly if buyer-key creation fails
- duplicate invite acceptance for an active membership is a no-op success
- revoked-after-load invite acceptance returns `invite_no_longer_valid`
- ended membership reactivation issues a fresh buyer key on the same membership row
- leave/remove revokes the membership key, removes member tokens, and marks membership `ended` atomically
- leave/remove rolls back if buyer-key revocation or token cleanup fails mid-transaction
- owner cannot leave the org or remove their own owner membership
- org creation rejects reserved and already-taken slugs
- token onboarding accepts optional `fiveHourReservePercent` / `sevenDayReservePercent`
- blank reserve inputs default to `0`
- token onboarding rejects reserve values outside `0..100`
- token management authorization: owner can mutate any token, member can mutate only own token
- token onboarding persists reserve values onto the token credential
- owner refresh of another member's token preserves original `created_by`
- token refresh preserves the existing reserve values

- [ ] **Step 2: Run the focused service tests and verify RED**

Run: `cd api && npm test -- orgGithubAuthService.test.ts orgMembershipService.test.ts orgTokenManagementService.test.ts`
Expected: FAIL because the services do not exist yet

- [ ] **Step 3: Implement the minimal orchestration**

Keep one owner for membership lifecycle transactions: `OrgMembershipService`.

Use interfaces like:

```ts
class OrgMembershipService {
  createOrg(input: {
    orgName: string
    actorUserId: string
    actorGithubLogin: string
  }): Promise<{ orgId: string; orgSlug: string; reveal: { buyerKey: string; reason: 'org_created' } }>
  createInvite(input: {
    orgSlug: string
    actorUserId: string
    githubLogin: string
  }): Promise<
    | { kind: 'invite_created'; inviteId: string; createdFresh: boolean }
    | { kind: 'already_a_member' }
  >
  revokeInvite(input: {
    orgSlug: string
    actorUserId: string
    inviteId: string
  }): Promise<void>
  acceptInvite(input: {
    orgSlug: string
    actorUserId: string
    actorGithubLogin: string
  }): Promise<
    | { kind: 'invite_accepted'; membershipId: string; reveal: { buyerKey: string; reason: 'invite_accepted' } }
    | { kind: 'already_active_member'; membershipId: string }
    | { kind: 'invite_no_longer_valid' }
  >
  leaveOrg(input: {
    orgSlug: string
    actorUserId: string
  }): Promise<{ membershipId: string }>
  removeMember(input: {
    orgSlug: string
    actorUserId: string
    memberUserId: string
  }): Promise<{ membershipId: string }>
}

class OrgTokenManagementService {
  addOrgToken(input: {
    orgSlug: string
    actorUserId: string
    token: string
    provider: string
    fiveHourReservePercent?: number
    sevenDayReservePercent?: number
  }): Promise<void>
  refreshOrgToken(input: { orgSlug: string; actorUserId: string; tokenId: string }): Promise<void>
  removeOrgToken(input: { orgSlug: string; actorUserId: string; tokenId: string }): Promise<void>
}
```

`OrgGithubAuthService` should only own OAuth exchange, GitHub user lookup, normalized `github_login` persistence/update, and session issuance; it should call `OrgMembershipService` or repo reads for access resolution rather than embedding membership mutations directly.

`OrgTokenManagementService` should own normal token mutation authorization, normalize missing reserve inputs to `0`, reuse the existing token-credential reserve fields (`five_hour_reserve_percent`, `seven_day_reserve_percent`) on add, and preserve the stored reserve values on refresh. Leave/remove cleanup continues to call the lower-level repo cleanup seam inside `OrgMembershipService` transactions.
Register the new services in `api/src/services/runtime.ts` here so Task 5 routes can depend on stable runtime keys instead of constructing services ad hoc in route files.

- [ ] **Step 4: Re-run the focused service tests and verify GREEN**

Run: `cd api && npm test -- orgGithubAuthService.test.ts orgMembershipService.test.ts orgTokenManagementService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/services/org/orgGithubAuthService.ts api/src/services/org/orgMembershipService.ts api/src/services/org/orgTokenManagementService.ts api/src/services/runtime.ts api/tests/orgGithubAuthService.test.ts api/tests/orgMembershipService.test.ts api/tests/orgTokenManagementService.test.ts
git commit -m "feat: add org auth and token services"
```

### Task 5: Add the org route surface, auth endpoints, and analytics org scoping

**Files:**
- Create: `api/src/routes/org.ts`
- Create: `api/src/routes/orgAuth.ts`
- Create: `api/src/routes/orgAccess.ts`
- Create: `api/src/routes/orgManagement.ts`
- Create: `api/src/routes/orgAnalytics.ts`
- Modify: `api/src/repos/analyticsRepository.ts`
- Modify: `api/src/server.ts`
- Modify: `api/src/types/express.d.ts`
- Test: `api/tests/org.route.test.ts`
- Modify: `api/tests/analyticsRepository.test.ts`

- [ ] **Step 1: Write the failing route and analytics tests**

Cover:
- `GET /v1/org/auth/github/start`
- `GET /v1/org/auth/github/callback`
- `POST /v1/orgs`
- fresh org create sets `Set-Cookie`, duplicate invite accept does not, and neither create nor accept ever returns the plaintext buyer key in JSON
- `GET /v1/orgs/:slug/access`
- all `OrgAccessResponse` variants: `not_found`, `sign_in_required`, `not_invited`, `pending_invite`, `active_membership`
- a multi-org same-session case where org context comes from the route slug, not a sticky global selection
- `GET /v1/orgs/:slug/tokens`
- `POST /v1/orgs/:slug/invites`
- `POST /v1/orgs/:slug/invites/accept`
- `POST /v1/orgs/:slug/invites/revoke`
- `POST /v1/orgs/:slug/leave`
- `POST /v1/orgs/:slug/members/:memberUserId/remove`
- `GET /v1/orgs/:slug/members`
- `GET /v1/orgs/:slug/invites`
- `POST /v1/orgs/:slug/tokens`
- token add accepts optional reserve values and blank/default inputs normalize to `0`
- token add rejects reserve values outside `0..100`
- `POST /v1/orgs/:slug/tokens/:tokenId/refresh`
- `POST /v1/orgs/:slug/tokens/:tokenId/remove`
- `GET /v1/orgs/:slug/analytics/dashboard`
- `GET /v1/orgs/:slug/analytics/timeseries`
- nonexistent org slug returns `404` / `not_found`
- unauthenticated access returns an explicit sign-in-required contract
- reserved/conflicting slug rejection on org creation
- owner-only access to invite create/list/revoke endpoints
- `/v1/orgs/innies/access` requires active internal-org membership
- org-scoped analytics repo filters only return rows for the target org

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd api && npm test -- org.route.test.ts analyticsRepository.test.ts`
Expected: FAIL because the route file and org filters do not exist yet

- [ ] **Step 3: Implement the minimal route surface**

Add org-aware access middleware that:
- reads the org web session from cookie or bearer
- resolves org from the route slug
- authorizes active membership before serving org data

Add auth routes that:
- start GitHub OAuth with `returnTo=/{orgSlug}` preserved
- complete OAuth into the generalized org web session instead of the pilot-only target-org flow

Lock the access contract so Chunk 3 can consume it without guessing:

```ts
type OrgAccessResponse =
  | { kind: 'not_found' }
  | {
      kind: 'sign_in_required'
      org: { id: string; slug: string; name: string }
      authStartUrl: string
    }
  | { kind: 'not_invited'; org: { id: string; slug: string; name: string } }
  | {
      kind: 'pending_invite'
      org: { id: string; slug: string; name: string }
      invite: { inviteId: string; githubLogin: string }
    }
  | {
      kind: 'active_membership'
      org: { id: string; slug: string; name: string }
      membership: { membershipId: string; isOwner: boolean }
    }
```

Lock the reveal-cookie write contract for create/accept:
- `POST /v1/orgs` returns `201 { orgSlug: string }` and sets the reveal cookie in `Set-Cookie`
- `POST /v1/orgs/:slug/invites/accept` returns `200 { orgSlug: string }` and sets the reveal cookie in `Set-Cookie` only when the invite is freshly accepted or an ended membership is reactivated with a fresh key
- duplicate acceptance for an already-active member returns `200 { orgSlug: string }` without `Set-Cookie`
- neither route ever returns the plaintext buyer key in JSON

Extend `AnalyticsRepository` with additive org filtering:

```ts
type BaseFilters = {
  window: AnalyticsWindow
  provider?: string
  source?: string
  orgId?: string
}
```

Use the new org routes for org analytics instead of overloading the existing admin analytics route.
Route token mutations through `OrgTokenManagementService` instead of duplicating ownership checks in the route file.
Expose `GET /v1/orgs/:slug/tokens` from `orgManagement.ts` so Chunk 3 can render org token inventory with creator attribution from a stable backend contract.
Keep `api/src/routes/org.ts` as a thin top-level mount that composes focused subrouters:
- `orgAuth.ts` for GitHub start/callback
- `orgAccess.ts` for access resolution
- `orgManagement.ts` for org create/invites/members/tokens/leave
- `orgAnalytics.ts` for analytics endpoints

Lock the core org-management wire contracts here so Chunk 3 can consume them directly:

```ts
POST /v1/orgs/:slug/invites/revoke
request: { inviteId: string }
response: { inviteId: string; status: 'revoked' }

GET /v1/orgs/:slug/members
response: { members: Array<{ userId: string; githubLogin: string | null; membershipId: string; isOwner: boolean }> }

GET /v1/orgs/:slug/invites
response: { invites: Array<{ inviteId: string; githubLogin: string; createdAt: string }> }

GET /v1/orgs/:slug/tokens
response: { tokens: Array<{ tokenId: string; provider: string; createdByUserId: string | null; createdByGithubLogin: string | null; fiveHourReservePercent: number; sevenDayReservePercent: number }> }

POST /v1/orgs/:slug/tokens
request: {
  provider: string
  token: string
  fiveHourReservePercent?: number
  sevenDayReservePercent?: number
}
notes: omitted reserve fields normalize to `0`; provided values must be within `0..100`
response: { tokenId: string }

POST /v1/orgs/:slug/leave
response: { membershipId: string; redirectTo: '/' }
```

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Run: `cd api && npm test -- org.route.test.ts analyticsRepository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/org.ts api/src/routes/orgAuth.ts api/src/routes/orgAccess.ts api/src/routes/orgManagement.ts api/src/routes/orgAnalytics.ts api/src/repos/analyticsRepository.ts api/src/server.ts api/src/types/express.d.ts api/tests/org.route.test.ts api/tests/analyticsRepository.test.ts
git commit -m "feat: add org routes and analytics scoping"
```

### Task 6: Add internal-admin org visibility and control endpoints

**Files:**
- Create: `api/src/routes/adminOrgs.ts`
- Modify: `api/src/server.ts`
- Test: `api/tests/admin.orgs.route.test.ts`

- [ ] **Step 1: Write the failing admin route test**

Cover:
- list orgs across the system
- list org members with GitHub usernames
- list pending invites
- list org member buyer keys with membership/user attribution
- list org token inventory with owner attribution
- revoke a member buyer key from the admin side
- rotate a member buyer key for lost-key recovery
- every endpoint requires existing admin authorization and rejects non-admin callers

- [ ] **Step 2: Run the focused admin test and verify RED**

Run: `cd api && npm test -- admin.orgs.route.test.ts`
Expected: FAIL because the endpoints do not exist yet

- [ ] **Step 3: Implement the minimal admin surface**

Add endpoints like:

```ts
GET  /v1/admin/orgs
GET  /v1/admin/orgs/:slug/members
GET  /v1/admin/orgs/:slug/invites
GET  /v1/admin/orgs/:slug/buyer-keys
GET  /v1/admin/orgs/:slug/tokens
POST /v1/admin/orgs/:slug/buyer-keys/:apiKeyId/revoke
POST /v1/admin/orgs/:slug/members/:membershipId/buyer-key/rotate
```

Use `api/src/routes/adminOrgs.ts` as a dedicated router mounted from `server.ts` rather than growing `admin.ts` further. Reuse `OrgAccessRepository.listOrgs()` plus the new org repositories for discovery data, require the same admin auth middleware/policy used by existing admin routes, and route lost-key recovery through `OrgBuyerKeyRepository.revokeBuyerKeyById()` / `rotateMembershipBuyerKey()` so support rotation is explicit instead of tribal knowledge.
For buyer-key recovery responses, lock:
- revoke -> `200 { apiKeyId: string; status: 'revoked' }`
- rotate -> `200 { membershipId: string; apiKeyId: string; plaintextKey: string }` and reveal the new plaintext key exactly once in the admin response

- [ ] **Step 4: Re-run the focused admin test and verify GREEN**

Run: `cd api && npm test -- admin.orgs.route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/adminOrgs.ts api/src/server.ts api/tests/admin.orgs.route.test.ts
git commit -m "feat: add admin org visibility endpoints"
```

## Chunk 3: UI Routes, Actions, And Verification

### Task 7: Build the org server helpers and dynamic route pages

**Files:**
- Create: `ui/src/lib/org/types.ts`
- Create: `ui/src/lib/org/server.ts`
- Create: `ui/src/lib/org/sessionCookie.ts`
- Create: `ui/src/components/org/OrgCreationForm.tsx`
- Create: `ui/src/components/org/InviteAcceptanceCard.tsx`
- Create: `ui/src/components/org/OrgDashboardTokens.tsx`
- Create: `ui/src/components/org/OrgDashboardMembers.tsx`
- Create: `ui/src/components/org/OrgDashboardSections.tsx`
- Create: `ui/src/components/org/orgDashboard.module.css`
- Create: `ui/src/app/[orgSlug]/page.tsx`
- Create: `ui/src/app/innies/page.tsx`
- Modify: `ui/src/app/analytics/page.tsx`
- Modify: `ui/src/app/page.tsx`
- Test: `ui/tests/orgDashboard.test.mjs`

- [ ] **Step 1: Write the failing UI contract test**

Cover:
- unknown org -> `404`
- unauthenticated org route -> GitHub sign-in gate
- unauthenticated org route uses backend `authStartUrl` unchanged so `returnTo=/{orgSlug}` survives end-to-end
- signed-in root page -> org creation form
- org creation success redirects to `/{orgSlug}` and lands on creator reveal state
- org creation error renders reserved/colliding slug failure without losing the form
- org creation buyer-key provisioning failure renders an inline recoverable error and stays on `/`
- authenticated no-access user -> not-invited state
- pending invite -> accept-invite state
- stale invite acceptance returns `invite_no_longer_valid` and stays out of the dashboard
- invite acceptance buyer-key provisioning failure renders an inline error and stays on the invite state
- creator reveal-cookie present -> one-time buyer-key reveal state
- accepted-member reveal-cookie present -> one-time buyer-key reveal state
- reveal dismissal returns to the normal dashboard
- duplicate invite acceptance lands on the normal dashboard and does not replay reveal
- active member -> org dashboard with role-aware controls
- token onboarding form exposes optional `5h` and `1w` reserve inputs
- blank token reserve inputs still add the token successfully and persist as `0`
- out-of-range token reserve inputs render an inline error and do not add the token
- dashboard renders token inventory with creator attribution
- dashboard renders token inventory reserve values
- dashboard renders active members, and owner sees pending invites
- owner can manage any token, while a member can mutate only their own tokens
- owner sees pending invites/member controls; member does not
- owner cannot use the leave flow
- `/analytics` redirects to `/innies`
- `/innies` still renders the internal dashboard for active internal members only

- [ ] **Step 2: Run the focused UI test and verify RED**

Run: `node --test ui/tests/orgDashboard.test.mjs`
Expected: FAIL because the new org pages/helpers do not exist yet

- [ ] **Step 3: Implement the server helpers and page states**

`ui/src/lib/org/server.ts` should be the single server-only fetch surface for org pages:

```ts
type OrgInvitePageState = {
  inviteId: string
  githubLogin: string
  org: { id: string; slug: string; name: string }
}

type OrgRevealPageState = {
  buyerKey: string
  reason: 'org_created' | 'invite_accepted'
  org: { id: string; slug: string; name: string }
}

type OrgDashboardPageState = {
  org: { id: string; slug: string; name: string }
  membership: { membershipId: string; isOwner: boolean; githubLogin: string }
  analyticsPaths: { dashboardPath: string; timeseriesPath: string }
  tokenPermissions: { canManageAllTokens: boolean }
  tokens: Array<{
    tokenId: string
    provider: string
    createdByUserId: string | null
    createdByGithubLogin: string | null
    fiveHourReservePercent: number
    sevenDayReservePercent: number
  }>
  members: Array<{
    userId: string
    githubLogin: string | null
    membershipId: string
    isOwner: boolean
  }>
  pendingInvites: Array<{
    inviteId: string
    githubLogin: string
    createdAt: string
  }>
}

getOrgPageState(orgSlug: string): Promise<
  | { kind: 'not_found' }
  | { kind: 'sign_in'; authStartUrl: string; org: { id: string; slug: string; name: string } }
  | { kind: 'not_invited'; org: { id: string; slug: string; name: string } }
  | { kind: 'invite'; invite: OrgInvitePageState }
  | { kind: 'reveal'; reveal: OrgRevealPageState }
  | { kind: 'dashboard'; data: OrgDashboardPageState }
>
```

Consume the typed `GET /v1/orgs/:slug/access` union from Chunk 2 directly instead of inferring state from ad hoc status codes. The UI `sign_in` state must map 1:1 from backend `sign_in_required`.

`ui/src/lib/org/sessionCookie.ts` should own shared org-cookie utilities on the Next side so `getOrgPageState()` and logout/dismiss handlers use one source of truth. Keep it limited to:
- reading the current org-scoped reveal cookie from Next server request cookies
- returning `{ buyerKey, reason } | null`
- exporting the org session-cookie name/options needed by logout clearing
- producing the local cookie name/path helpers needed by the reveal-dismiss route
- never persisting the plaintext key outside the incoming request/response cycle

For the dashboard state, fetch the complete owner/member data needed for the page instead of rendering a thin shell:
- token inventory from the org token endpoint/repo seam
- active members from the org members endpoint/repo seam
- pending invites from the org invites endpoint/repo seam when `isOwner === true`
- an empty `pendingInvites` array for non-owners so the page contract stays stable

Split the UI responsibilities so the route pages stay small:
- `OrgCreationForm.tsx` is the client-side seam for org creation submit/loading/error rendering; it calls the Next `create` handler, keeps reserved/taken slug errors inline, and redirects on success
- `InviteAcceptanceCard.tsx` is the client-side seam for invite acceptance submit/loading/error rendering; it handles `invite_no_longer_valid` inline without query-string plumbing and redirects only on success
- `OrgDashboardTokens.tsx` renders token inventory, optional `5h` / `1w` reserve inputs for token onboarding, maps the `1w` label to backend `sevenDayReservePercent`, submits blank values as omitted so the backend defaults them to `0`, surfaces invalid/out-of-range reserve errors inline, and displays the persisted reserve values in inventory
- `OrgDashboardMembers.tsx` renders active members, pending invites, and owner-only member controls
- `OrgDashboardSections.tsx` becomes a thin layout/composition wrapper over the smaller dashboard sections

`ui/src/app/page.tsx` should render the signed-in org creation form, signed-out GitHub sign-in CTA, and reuse the existing root page styling instead of inventing a second root-page CSS surface. Successful create redirects to `/{orgSlug}` so the reveal cookie is consumed on the org route rather than on `/`.

Use `ui/src/app/[orgSlug]/page.tsx` for customer orgs and `ui/src/app/innies/page.tsx` for the internal org home.

- [ ] **Step 4: Re-run the focused UI test and verify GREEN**

Run: `node --test ui/tests/orgDashboard.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/org/types.ts ui/src/lib/org/server.ts ui/src/lib/org/sessionCookie.ts ui/src/components/org/OrgCreationForm.tsx ui/src/components/org/InviteAcceptanceCard.tsx ui/src/components/org/OrgDashboardTokens.tsx ui/src/components/org/OrgDashboardMembers.tsx ui/src/components/org/OrgDashboardSections.tsx ui/src/components/org/orgDashboard.module.css ui/src/app/[orgSlug]/page.tsx ui/src/app/innies/page.tsx ui/src/app/analytics/page.tsx ui/src/app/page.tsx ui/tests/orgDashboard.test.mjs
git commit -m "feat: add org route pages"
```

### Task 8: Add Next API handlers and parameterize the analytics client

**Files:**
- Create: `ui/src/app/api/orgs/create/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/analytics/dashboard/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/analytics/timeseries/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/invites/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/invites/accept/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/invites/revoke/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/leave/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/members/[memberUserId]/remove/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/tokens/add/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/tokens/[tokenId]/refresh/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/tokens/[tokenId]/remove/route.ts`
- Create: `ui/src/app/api/orgs/[orgSlug]/reveal/dismiss/route.ts`
- Create: `ui/src/app/api/orgs/session/logout/route.ts`
- Modify: `ui/src/lib/analytics/client.ts`
- Modify: `ui/src/hooks/useAnalyticsDashboard.ts`
- Modify: `ui/src/hooks/useAnalyticsSeries.ts`
- Modify: `ui/src/app/analytics/AnalyticsDashboardClient.tsx`
- Create: `ui/tests/orgApiHandlers.test.mjs`
- Modify: `ui/tests/pilotDashboard.test.mjs`

- [ ] **Step 1: Write the failing route-handler and client tests**

Cover:
- form/action handlers proxy create/invite-create/invite-accept/invite-revoke/leave/member-remove/token-add/token-refresh/token-remove to the new `/v1/orgs/...` API
- owner remove-member action proxies to the org member-removal API
- stale invite acceptance returns `invite_no_longer_valid` with no reveal cookie and no redirect into the dashboard
- org creation provisioning failure preserves the backend error kind/body and lets the root form render it inline
- invite acceptance provisioning failure preserves the backend error kind/body and lets the invite card render it inline
- token add proxy preserves optional `fiveHourReservePercent` / `sevenDayReservePercent` values
- blank reserve inputs are omitted by the UI submit path and still land as `0` after the backend add flow
- invalid token reserve errors preserve the backend error kind/body and let the token form render them inline
- reveal dismissal clears the reveal cookie for the current `/{orgSlug}` path
- org creation and invite acceptance proxies preserve upstream `Set-Cookie` for the one-time reveal cookie
- org analytics read handlers proxy `/v1/orgs/:slug/analytics/*`
- logout handler clears the org web-session cookie and returns `303` to `/`
- analytics client can target either `/api/analytics/*` or `/api/orgs/{slug}/analytics/*`
- existing internal analytics still works after parameterization

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test ui/tests/orgApiHandlers.test.mjs ui/tests/pilotDashboard.test.mjs`
Expected: FAIL on the new handler/client cases

- [ ] **Step 3: Implement the mutation proxy handlers**

Use explicit endpoint inputs instead of hard-coding `/api/analytics/...`:

```ts
fetchAnalyticsDashboard(window, { dashboardPath })
fetchAnalyticsSeries({ window, provider, source, timeseriesPath })
```

Make the Next handlers thin proxies by default: preserve upstream status codes and JSON bodies for create, invite create/revoke, accept, leave, member remove, and token add/refresh/remove so page/server actions can decide redirects without inventing new semantics in the proxy layer.
For `create` and `accept` handlers, forward the upstream `Set-Cookie` header untouched so the reveal cookie survives the Next proxy layer. For `accept`, do not emit a reveal cookie when the backend returns `already_active_member`, `invite_no_longer_valid`, or buyer-key provisioning failure. For `create`, preserve reserved/conflict/provisioning-failure JSON bodies unchanged.
For token add, preserve `fiveHourReservePercent` / `sevenDayReservePercent` in the proxied payload exactly as received from the UI layer; the client component should be the seam that turns blank fields into omitted values.

- [ ] **Step 4: Implement reveal-dismiss and logout cookie handlers**

For reveal dismissal, include `orgSlug` in the route and expire only the cookie scoped to that path.
`ui/src/app/api/orgs/session/logout/route.ts` should clear the org web-session cookie, preserve cookie-domain behavior from `ui/src/lib/org/sessionCookie.ts`, and return `303` to `/`.

- [ ] **Step 5: Parameterize the analytics client and analytics proxy handlers**

Keep the existing client-side dashboard behavior; only make the endpoint base configurable so `/{orgSlug}` and `/innies` can share the chart/table client.

- [ ] **Step 6: Re-run the focused tests and verify GREEN**

Run: `node --test ui/tests/orgApiHandlers.test.mjs ui/tests/pilotDashboard.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ui/src/app/api/orgs/create/route.ts ui/src/app/api/orgs/[orgSlug]/analytics/dashboard/route.ts ui/src/app/api/orgs/[orgSlug]/analytics/timeseries/route.ts ui/src/app/api/orgs/[orgSlug]/invites/route.ts ui/src/app/api/orgs/[orgSlug]/invites/accept/route.ts ui/src/app/api/orgs/[orgSlug]/invites/revoke/route.ts ui/src/app/api/orgs/[orgSlug]/leave/route.ts ui/src/app/api/orgs/[orgSlug]/members/[memberUserId]/remove/route.ts ui/src/app/api/orgs/[orgSlug]/tokens/add/route.ts ui/src/app/api/orgs/[orgSlug]/tokens/[tokenId]/refresh/route.ts ui/src/app/api/orgs/[orgSlug]/tokens/[tokenId]/remove/route.ts ui/src/app/api/orgs/[orgSlug]/reveal/dismiss/route.ts ui/src/app/api/orgs/session/logout/route.ts ui/src/lib/analytics/client.ts ui/src/hooks/useAnalyticsDashboard.ts ui/src/hooks/useAnalyticsSeries.ts ui/src/app/analytics/AnalyticsDashboardClient.tsx ui/tests/pilotDashboard.test.mjs ui/tests/orgApiHandlers.test.mjs
git commit -m "feat: wire org ui handlers and analytics client"
```

### Task 9: Run focused verification on the assembled feature

**Files:**
- Verify: backend and UI files touched in Tasks 1-8

- [ ] **Step 1: Run the focused backend suite**

Run:

```bash
cd api && npm test -- phase3OrgOnboardingMigrations.test.ts orgSlug.test.ts orgSessionService.test.ts orgSessionCookie.test.ts orgInviteRepository.test.ts orgAccessRepository.test.ts orgBuyerKeyRepository.test.ts orgTokenRepository.test.ts orgGithubAuthService.test.ts orgMembershipService.test.ts orgTokenManagementService.test.ts org.route.test.ts admin.orgs.route.test.ts analyticsRepository.test.ts
```

Expected: PASS with all focused org-onboarding tests green

- [ ] **Step 2: Run the backend build**

Run:

```bash
cd api && npm run build
```

Expected: PASS

- [ ] **Step 3: Run the focused UI tests**

Run:

```bash
node --test ui/tests/orgDashboard.test.mjs ui/tests/orgApiHandlers.test.mjs ui/tests/pilotDashboard.test.mjs ui/tests/analyticsPresent.test.mjs
```

Expected: PASS, including creator/member reveal flows, duplicate-accept no-reveal behavior, role-aware controls, reveal dismissal, and `/innies` membership gating

- [ ] **Step 4: Run the UI build**

Run:

```bash
cd ui && npm run build
```

Expected: PASS

- [ ] **Step 5: Commit the final assembled feature**

```bash
git add api ui docs/migrations
git commit -m "feat: add phase 3 org onboarding mvp"
```
