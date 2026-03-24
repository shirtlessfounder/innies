# Phase 3 Org Onboarding MVP Design

## Goal

Turn the current Darryn/pilot-specific account surface into a general self-serve org product:

- sign in with GitHub
- create an org with only an org name
- invite GitHub users into that org
- let members accept invites at the org route
- give each accepted membership one org-scoped buyer key automatically
- let org members onboard, refresh, and remove Claude/Codex tokens under clear ownership rules
- move analytics from a single global page to org-scoped routes

This MVP is intentionally free. It does not include billing, trials, or payment gating.

## Context

The current codebase already has real building blocks from Phase 2:

- GitHub OAuth session handling in the pilot auth path
- org, user, and membership persistence patterns in `pilotIdentityRepository`
- org-scoped token credentials
- org-scoped analytics reads
- org-scoped dashboard surface patterns
- token refresh/remove behavior already exposed through scripts and admin/pilot flows

The problem is that these seams are still shaped around one hard-coded pilot org and one hard-coded pilot route. Phase 3 MVP should generalize those seams into a reusable org product instead of continuing Darryn-specific work.

## Decision

Generalize the current pilot stack into the first self-serve org platform.

This is preferred over:

- continuing to build separate pilot-only and org-only flows in parallel
- inventing a personal floating buyer-key model tied directly to one GitHub identity
- building a thin UI wrapper on top of internal/admin routes

The design keeps human web identity separate from API credentials, but keeps the UX simple:

- users sign into the web app with GitHub
- org membership controls org access
- each membership gets exactly one org-scoped buyer key automatically

## Canonical State Model

### GitHub Identity

- `github_login` is stored on the user row as the canonical GitHub identifier for MVP.
- GitHub logins are normalized by trimming and lowercasing before persistence and invite matching.
- The normalized login is used for whitelist/invite matching and access checks.

### Pending Invites

Pending invites are their own object. They are not separate from the whitelist.

Invite states for MVP:

- `pending`
- `revoked`
- `accepted`

Rules:

- owner whitelist action creates or refreshes a `pending` invite
- removing a whitelist entry marks that invite `revoked`
- accepting an invite marks it `accepted`
- re-whitelisting a revoked or accepted GitHub login creates a fresh `pending` invite row
- attempting to whitelist a GitHub login that already has an active membership in the org is rejected as `already_a_member`

### Memberships

Membership rows are soft-stateful, not hard-deleted.

Membership states for MVP:

- `active`
- `ended`

Rules:

- org creation creates one `active` owner membership for the creator
- invite acceptance activates membership access
- leave/remove transitions the membership to `ended`
- rejoining the same org reactivates the existing membership row instead of creating a duplicate logical membership
- reactivation issues a fresh buyer key for that reactivated membership
- any previously revoked key for that ended membership remains revoked

The persisted membership row is retained for audit and buyer-key attribution.

## Product Scope

### Included

- GitHub sign-in for the web app
- org creation after sign-in
- immutable auto-generated org slug
- owner-managed GitHub username whitelist
- pending org invites
- invite acceptance at `/{orgSlug}`
- one owner per org
- member leave flow
- owner remove-member flow
- one org-scoped buyer key per active membership
- one-time buyer-key reveal after org creation and invite acceptance
- org-scoped analytics routes
- org-scoped token add/remove/refresh flows

### Excluded

- billing, subscriptions, or trials
- invite emails or magic invite links
- multiple owners
- owner promotion/demotion
- editable org slugs
- service accounts or extra arbitrary buyer keys
- final visual design polish
- retiring the pilot flow as part of this MVP

## Core Model

### Identity And Access

- GitHub OAuth session is the human web identity.
- Org membership is the access-control boundary for org surfaces.
- API traffic is authenticated with buyer keys, not with the GitHub session.
- A user may belong to multiple orgs.
- A user selects an org by visiting that org's route, not by a global org switcher.

### Roles

For MVP, each org has:

- exactly one `owner`: the org creator
- zero or more `member`s

Role rules:

- the owner can manage whitelist entries and active members
- the owner can manage any token in the org
- a member can leave the org
- a member can manage only the tokens they personally added
- the owner cannot leave the org in MVP; org deletion/transfer is out of scope

Persisted compatibility rule:

- all Phase 3 membership rows are stored in the existing membership table with persisted role value `buyer`
- owner-only authorization never comes from that persisted role
- owner-only authorization comes only from `org.owner_user_id`

### Buyer Keys

Each active membership gets one org-scoped buyer key.

Rules:

- the org creator gets a buyer key at org creation time
- the key is created automatically when the invite is accepted
- the key belongs to the org for routing/accounting purposes
- the key is attributed to the accepting membership/user for audit and lifecycle control
- if the member leaves or is removed, that member's org key is revoked automatically
- the plaintext key is revealed once immediately after org creation or invite acceptance
- self-serve key rotation/regeneration is out of scope for this MVP

This keeps the UX simple without coupling one person's API key to one org forever.

Lost-key recovery policy for MVP:

- if the user loses the one-time reveal, there is no self-serve recovery path
- recovery requires a manual admin/support rotation using existing internal tooling
- the spec does not include a new self-serve key-regeneration surface

### Buyer-Key Reveal Transport

The one-time plaintext buyer key must not travel in URL params or persistent browser storage.

MVP transport contract:

- after successful org creation or invite acceptance, the backend writes the plaintext key into a short-lived encrypted HttpOnly reveal cookie scoped to that org route
- the next authenticated GET for `/{orgSlug}` reads that cookie server-side and renders the one-time reveal state
- the reveal cookie is cleared only after an explicit reveal-dismissal POST from the browser
- if the reveal page load fails before the browser can dismiss it, the cookie remains and the next successful GET still shows the reveal state
- if the reveal cookie is already cleared, `/{orgSlug}` renders the normal dashboard

This is the only supported reveal path in MVP.

### Token Ownership

Tokens are borrowed into the org by the member who adds them.

Rules:

- the org may route against the token while that member belongs to the org
- token inventory keeps the adding user as visible attribution
- a member may remove or refresh only the tokens they added
- the owner may remove or refresh any token in the org
- refreshing a token never changes its original `created_by` ownership attribution
- if the member leaves or is removed, every token they added to that org is removed automatically

### Token Reserve Floors

The org token onboarding flow should reuse the existing token credential reserve model instead of inventing a second cap system.

Rules:

- when adding a token to an org, the member may optionally set a `5h` reserve percent and a `1w` reserve percent
- each reserve input is an integer percent in the range `0..100`
- the backend persists those values in the existing `five_hour_reserve_percent` and `seven_day_reserve_percent` token-credential fields
- the UI label `1w` maps to the existing backend `7d` / `sevenDayReservePercent` window
- blank reserve inputs default to `0`, which means no reserve floor / no cap buffer for that window
- token inventory should show the currently configured reserve percentages for each token
- token refresh keeps the existing reserve percentages unless an explicit reserve-edit surface is added later
- adding org-specific reserve settings must not require a new org-only cap table or a parallel token-cap model in MVP

## Route Model

### Reserved Slugs

The system must reserve a fixed list of slugs so org creation cannot collide with system routes.

Minimum reserved set:

- `innies`
- `admin`
- `api`
- `analytics`
- `pilot`
- `onboard`

Additional internal/system slugs may be added conservatively.

Slug normalization rules:

- trim surrounding whitespace
- lowercase the value
- transliterate to ASCII where possible
- replace each run of non-alphanumeric characters with a single `-`
- collapse repeated `-`
- trim leading/trailing `-`
- reject if empty after normalization
- max length: 48 characters after normalization

Collision behavior:

- if the normalized slug is reserved, reject org creation
- if the normalized slug already exists, reject org creation
- do not auto-append numeric suffixes in MVP

### Org Routes

- `/{orgSlug}` is the org entry point and org dashboard route
- `/innies` is the internal org route
- `/analytics` should redirect to `/innies` for compatibility during migration

Route behavior at `/{orgSlug}`:

- nonexistent org slug: return `404`
- not signed in: show a generic GitHub sign-in page
- signed in but not invited or not a member: show a simple "you're not invited to this org" page
- signed in and pending invite exists: show the invite-acceptance modal
- signed in and just completed org creation or invite acceptance: show the one-time buyer-key reveal state
- signed in and membership exists: show the org dashboard

The route must not leak org analytics or token inventory before membership is confirmed.

## Org Context Contract

- the web session is user-scoped, not org-scoped
- org context comes from the current route slug
- org-scoped UI fetchers and API handlers must resolve the org from that slug, then authorize against the signed-in user
- `/innies` follows the same rule, but always resolves to the internal org slug and requires active internal-org membership
- server-rendered pages and backend handlers must not infer org context from a previously selected global org state
- unauthenticated visits to `/{orgSlug}` must carry `returnTo=/{orgSlug}` through GitHub auth so the user lands back on the same org route after sign-in

## User Flows

### Org Creation

1. User signs in with GitHub.
2. User submits an org creation form with only `org name`.
3. Backend generates the slug from the org name and rejects reserved or conflicting slugs.
4. Backend creates:
   - org row
   - owner membership for the creator
   - one owner buyer key for the creator
5. Backend writes the one-time reveal cookie carrying the plaintext buyer key.
6. User is redirected to `/{orgSlug}`.

The creator does not need a separate click to become the owner.
Org creation is one transaction: if buyer-key creation fails, org creation rolls back.
The first successful post-create page load is the one-time buyer-key reveal state; after dismissal, normal org dashboard rendering resumes.

### Invite Flow

1. Owner enters a GitHub username in org settings.
2. Backend creates or updates a pending invite for `(org_id, github_login)`.
3. Invited user visits `/{orgSlug}`.
4. If not signed in, they complete GitHub auth first.
5. If the authenticated GitHub login matches the pending invite, the UI shows an invite-acceptance modal.
6. On acceptance, backend performs one transaction:
   - create membership idempotently
   - create that membership's buyer key
   - consume the pending invite
7. Backend writes the one-time reveal cookie carrying the plaintext buyer key.

If buyer-key creation fails, the transaction rolls back and the invite remains pending.
The first successful post-accept page load is the one-time buyer-key reveal state; after dismissal, normal org dashboard rendering resumes.
If the invite was already accepted for an active membership, a repeated accept submit is treated as idempotent success and lands on the normal dashboard with no new key reveal.
If the invite was revoked after the page loaded but before the accept submit, accept returns `invite_no_longer_valid` and no membership change occurs.
If the invite targets an `ended` membership, accept reactivates that same membership row, creates a fresh buyer key for it, and then shows the one-time reveal state.

### Leave And Removal

Member leave:

1. Member chooses `Leave org`.
2. Backend performs one transaction:
   - revokes that membership's org buyer key
   - removes tokens added by that member in that org
   - marks that membership `ended`

Owner removal of member:

1. Owner removes the member from org settings.
2. Backend performs the same buyer-key revocation and token-removal cleanup.

For MVP, owner leave is rejected.
If cleanup fails, the transaction rolls back and the membership remains active. There is no committed half-removed state in MVP.

## Product Surfaces

### Public/Auth Surface

- generic GitHub sign-in entry
- org creation screen after sign-in
- invite acceptance modal
- one-time buyer-key reveal after org creation or invite acceptance
- not-invited page

### Org Dashboard

The org dashboard lives at `/{orgSlug}` and uses the current analytics dashboard as the shell.

Contents for MVP:

- org-scoped analytics
- org token inventory
- add token flow
- refresh token flow
- remove token flow
- member list
- pending invites list

`/innies` uses the same dashboard shell for the internal org.

Visibility rules:

- all active members can view the active member list
- only the owner can view the pending invites list
- only the owner can revoke pending invites

### Token Management Permissions

Owner:

- can add tokens
- can refresh/remove any token
- can view attribution for all tokens

Member:

- can add tokens
- can refresh/remove only tokens they added
- can view token attribution in the org dashboard

### Internal Admin Access

Innies internal admins have full cross-org operator authority through internal admin surfaces and tooling.

That includes:

- viewing all orgs, memberships, pending invites, buyer-key metadata, and associated GitHub usernames
- viewing and managing token inventory across orgs
- revoking or rotating org member buyer keys through internal tooling
- performing emergency support/debug actions across orgs

This internal-admin authority is separate from customer org-owner permissions.

## Backend Design

### Auth And Session

Generalize the current pilot GitHub auth/session flow into an org-aware web auth flow.

The generalized auth flow must:

- authenticate the GitHub user
- persist or update the user identity
- persist the normalized GitHub login on the user identity row
- resolve the requested org slug from the route
- determine one of:
  - active membership
  - pending invite
  - no access
- issue a session that can be used by org routes and org-scoped UI fetchers

The current pilot-specific target-org assumptions must be removed from the generalized path.

### Org And Invite Service

Add an org membership/invite service responsible for:

- org creation
- slug generation/validation
- reserved-slug rejection
- whitelist/invite creation
- membership acceptance
- leave/remove actions

This service is the owner of invite and membership lifecycle rules.

Canonical invite rule:

- the owner-facing "whitelist GitHub username" action creates a pending invite row
- there is no separate whitelist data model in MVP
- removing a whitelist entry marks that pending invite `revoked`
- re-whitelisting the same GitHub username recreates the pending invite
- attempting to whitelist an already active member returns `already_a_member`
- active members are represented by membership rows, not by invite rows

This service also owns the top-level transaction boundary for:

- org creation
- invite acceptance
- member leave
- owner remove-member

It is the orchestration owner for those flows.

### Buyer-Key Provisioning

Add a buyer-key provisioning seam responsible for:

- creating one buyer key for a new accepted membership
- storing attribution from buyer key -> membership/user
- revoking that buyer key on leave/removal

The current auth path should keep using org-owned buyer keys for request traffic.

Interface contract:

- `createMembershipBuyerKey(tx, membershipId, orgId, userId)` -> creates and returns the new plaintext key once
- `revokeMembershipBuyerKey(tx, membershipId)` -> idempotently revokes the current membership key

This seam does not own the top-level transaction. It is called by the org membership/invite service inside that service's transaction.

### Token Mutation Authorization

Add an org token management service responsible for normal add/refresh/remove flows and their authorization checks.

Interface contract:

- `addOrgToken(actorUserId, orgId, input)` -> adds a token attributed to `actorUserId`, with optional reserve percentages for `5h` and `1w`
- `refreshOrgToken(actorUserId, orgId, tokenId, input)` -> refreshes the token if the actor is allowed
- `removeOrgToken(actorUserId, orgId, tokenId)` -> removes the token if the actor is allowed

Authorization rules owned by this service:

- owner may mutate any token in the org
- member may mutate only tokens whose `created_by` equals that member's user id
- refresh preserves the original `created_by` attribution even when the owner performs it

This service owns normal token mutation authorization. Token offboarding remains the specialized leave/remove cleanup seam.

### Token Offboarding

Add a token offboarding seam responsible for:

- listing tokens in an org that were added by a given member
- removing those tokens on leave/removal

The existing token credential `created_by` field is the intended attribution seam for MVP.

Interface contract:

- `removeMemberTokens(tx, orgId, userId)` -> idempotently removes or revokes every token in that org whose `created_by` is that user

This seam does not own the top-level transaction. It is called by the org membership/invite service inside that service's transaction.

## Data Design

### Additive Data Requirements

Phase 3 MVP needs additive data support for:

- GitHub login stored against the user row
- pending org invites keyed by org + GitHub login
- single-owner attribution on the org row
- buyer-key attribution to the membership/user it was created for
- membership activity state so leave/remove can mark a membership `ended` without destroying audit history
- existing token-credential reserve columns reused for org token onboarding (`five_hour_reserve_percent` and `seven_day_reserve_percent`)

Data invariants for MVP:

- at most one `active` membership per `(org_id, user_id)`
- at most one `pending` invite per `(org_id, github_login)`
- at most one active buyer key per membership

It should reuse existing org/user/membership rows where possible instead of replacing them wholesale.

### Membership Compatibility

The current membership shape is still `admin` / `seller` / `buyer`.

Phase 3 MVP will use an additive ownership seam:

- add `owner_user_id` to the org row as the single source of truth for owner-only permissions
- keep using the existing membership table for active org membership rows
- treat Phase 3 members as membership rows without relying on legacy `admin` / `seller` / `buyer` semantics for owner authorization
- never infer owner-only permissions from legacy membership role alone

This avoids a destructive membership-role rewrite while still making the single-owner rule explicit and testable.

### Analytics Scoping

The analytics/dashboard data contract must become org-route aware:

- `/{orgSlug}` shows only that org's analytics
- `/innies` shows the internal org analytics
- route resolution must not rely on one hard-coded pilot org

## Error Handling

The MVP should surface explicit outcomes for these cases:

- org name generates a reserved slug
- org name generates a slug already in use
- nonexistent org slug
- unauthenticated visit to `/{orgSlug}`
- authenticated visit without invite or membership
- duplicate invite acceptance
- invite revoked after page load but before accept submit
- org creation cannot provision the creator's buyer key
- invite acceptance cannot provision the member buyer key
- member tries to manage another member's token
- token onboarding reserve percent is malformed or outside the accepted range
- owner tries to remove themselves
- leave/remove cleanup cannot fully revoke the member's buyer key and tokens

Org creation and invite acceptance must fail atomically: no committed membership without its buyer key.

Leave/remove cleanup must also commit atomically: either buyer key revocation, token removal, and membership deactivation all commit together, or nothing changes and the caller receives an explicit error.

## Testing Requirements

### Backend

- org creation:
  - org creation succeeds from org name only
  - slug generation is deterministic
  - reserved/conflicting slugs are rejected
- auth/membership:
  - invited user signs in and sees pending invite
  - invite acceptance is idempotent
  - duplicate invite acceptance for an already active member lands on the normal dashboard with no new key reveal
  - revoked-after-load invite submit returns `invite_no_longer_valid`
  - non-invited user cannot access org data
  - nonexistent org slug returns `404`
  - one GitHub user can join multiple orgs by route
  - whitelisting an already active member is rejected as `already_a_member`
  - leave/remove marks membership `ended`
  - re-invite/reactivation restores access on the existing membership row
  - unauthenticated org-route sign-in returns to the same `/{orgSlug}`
- buyer keys:
  - org creation auto-creates the creator buyer key
  - membership acceptance auto-creates one org buyer key
  - acceptance rolls back cleanly if buyer-key creation fails
  - leave/remove revokes that membership buyer key
  - reactivation creates a fresh buyer key for the reactivated membership
- token permissions:
  - adding a token with explicit `5h` / `1w` reserve values persists those values on the token
  - adding a token with blank reserve inputs defaults both reserve values to `0`
  - member can manage own token only
  - owner can manage any token
  - token inventory shows the current reserve values for each token
  - owner refreshing another member's token preserves original token ownership attribution
  - token refresh preserves existing reserve values
  - leave/remove strips tokens added by the departing member
  - leave/remove rolls back cleanly if cleanup fails
- org analytics scoping:
  - org dashboard reads only org data
  - `/innies` preserves internal-org visibility

### UI

- unauthenticated org route shows sign-in gate
- nonexistent org route shows `404`
- non-invited authenticated user sees not-invited state
- invited user sees accept-invite modal
- creator and accepted member both see the one-time buyer-key reveal state
- token onboarding form exposes optional `5h` and `1w` reserve inputs
- leaving those reserve inputs blank still submits a valid token add and results in no caps
- out-of-range reserve values are rejected with an inline token-form error
- token inventory shows the configured reserve values
- the one-time buyer-key reveal state clears into the normal org dashboard after dismissal
- duplicate invite acceptance does not replay the key reveal
- accepted member sees org dashboard
- owner sees whitelist/member controls
- member sees the active member list but not the pending invites list
- member does not see owner-only member-management actions
- owner `Leave org` is rejected

### Regression

- existing token auth/routing continues to work with org-scoped buyer keys
- current internal analytics surface still works at `/innies`
- `/innies` requires active internal-org membership under the same org-context contract
- current pilot-specific surfaces remain functional until they are intentionally retired

## Rollout

Rollout should be additive and low-risk:

1. Land the org auth/invite/membership foundation.
2. Land org-scoped routes and analytics surface generalization.
3. Land member-scoped buyer-key provisioning.
4. Land member-scoped token permissions and offboarding cleanup.
5. Keep pilot-specific routes alive until the new org surface is proven.

This MVP does not attempt to migrate or revive the parked Darryn rollout. It uses the reusable Phase 2 infrastructure as substrate for a general org product.
