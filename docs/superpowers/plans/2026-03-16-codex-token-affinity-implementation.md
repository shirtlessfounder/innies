# Codex Token Affinity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship soft preferred token affinity for Codex/OpenAI token-mode traffic with auto-generated CLI session IDs, org-scoped Postgres affinity state, floating fallback, and truthful routing metadata.

**Architecture:** Add an affinity layer between provider selection and token credential picking. Persist preferred assignments plus live-stream busy state in Postgres behind a focused repo/service pair, normalize session identity once at ingress, and teach `proxy.ts` to reuse, claim, float, and clean up affinity state without changing existing provider-selection semantics.

**Tech Stack:** TypeScript, Express, Postgres SQL migrations, Vitest, Node.js `node:test`, bash smoke scripts

---

## References

- Spec: `/Users/dylanvu/innies/docs/superpowers/specs/2026-03-16-codex-token-affinity-design.md`
- Token-mode routing: `/Users/dylanvu/innies/api/src/routes/proxy.ts`
- Token credential pool boundary: `/Users/dylanvu/innies/api/src/repos/tokenCredentialRepository.ts`
- Runtime wiring: `/Users/dylanvu/innies/api/src/services/runtime.ts`
- Codex wrapper: `/Users/dylanvu/innies/cli/src/commands/codex.js`
- Existing token-mode route coverage: `/Users/dylanvu/innies/api/tests/proxy.tokenMode.route.test.ts`
- Existing OpenClaw/compat coverage: `/Users/dylanvu/innies/api/tests/anthropicCompat.route.test.ts`

## File Structure

### Create

- `docs/migrations/017_token_affinity.sql`
  - Postgres tables and indexes for preferred assignments and active streams.
- `docs/migrations/017_token_affinity_no_extensions.sql`
  - No-extensions twin of the same schema.
- `api/src/repos/tokenAffinityRepository.ts`
  - Persistence boundary for preferred assignments, live-stream busy rows, stale cleanup, and atomic claims.
- `api/src/services/tokenAffinityService.ts`
  - Pure application rules for reuse, streaming-only first claims, floating fallback, spillover, and route-decision affinity metadata.
- `api/src/utils/sessionIdentity.ts`
  - Canonical `x-innies-session-id` resolution plus OpenClaw fallback-order handling.
- `api/tests/tokenAffinityRepository.test.ts`
  - SQL/repository contract tests.
- `api/tests/tokenAffinityService.test.ts`
  - Rule-level tests for claim/reuse/filter/lifecycle behavior.

### Modify

- `api/src/repos/tableNames.ts`
  - Register new affinity tables.
- `api/src/services/runtime.ts`
  - Wire new repo/service into runtime.
- `api/src/routes/proxy.ts`
  - Use session identity, affinity service decisions, lifecycle hooks, and dedicated `routeDecision.affinity` metadata.
- `api/tests/proxy.tokenMode.route.test.ts`
  - Token-mode routing coverage for preferred reuse, first streaming claim, floating fallback, spillover, lifecycle cleanup, and metadata.
- `api/tests/anthropicCompat.route.test.ts`
  - OpenClaw/compat session extraction and canonical-header precedence coverage.
- `cli/src/commands/codex.js`
  - Generate one session ID per process and send it via `x-innies-session-id`.
- `cli/tests/codexArgs.test.js`
  - Verify header injection and stable env wiring.
- `cli/scripts/smoke.sh`
  - Assert the Codex wrapper exports the session header config.
- `docs/API_CONTRACT.md`
  - Document `x-innies-session-id`, accepted OpenClaw fallbacks, and `routeDecision.affinity`.
- `docs/CLI_UX.md`
  - Document hidden per-process session stickiness for `innies codex`.
- `api/scripts/token_mode_manual_check.sh`
  - Extend manual evidence checks to inspect affinity rows and route-decision affinity metadata.

## Chunk 1: Persistence And Session Identity

### Task 1: Add affinity schema, table wiring, and repository contract

**Files:**
- Create: `docs/migrations/017_token_affinity.sql`
- Create: `docs/migrations/017_token_affinity_no_extensions.sql`
- Create: `api/src/repos/tokenAffinityRepository.ts`
- Create: `api/tests/tokenAffinityRepository.test.ts`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing repository contract tests**

```ts
describe('tokenAffinityRepository', () => {
  it('claims one preferred credential per (org_id, provider, session_id)', async () => {});
  it('rejects competing claims for the same credential', async () => {});
  it('lists busy credential ids from active-stream rows', async () => {});
  it('refreshes last_touched_at for a live stream heartbeat', async () => {});
  it('returns cleared stream context by request id', async () => {});
  it('clears stale active streams and orphaned preferred ownership together', async () => {});
});
```

- [ ] **Step 2: Run the new repository tests to verify they fail**

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/tokenAffinityRepository.test.ts`
Expected: FAIL with module-not-found and/or missing method assertions for `tokenAffinityRepository`.

- [ ] **Step 3: Add the new table names**

```ts
export const TABLES = {
  routingEvents: 'in_routing_events',
  tokenAffinityAssignments: 'in_token_affinity_assignments',
  tokenAffinityActiveStreams: 'in_token_affinity_active_streams'
} as const;
```

- [ ] **Step 4: Add the migrations**

```sql
-- 017_token_affinity.sql and 017_token_affinity_no_extensions.sql should stay functionally identical;
-- this schema does not require extension-only features.

create table if not exists in_token_affinity_assignments (
  org_id uuid not null,
  provider text not null,
  credential_id uuid not null,
  session_id text not null,
  last_activity_at timestamptz not null default now(),
  grace_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider, credential_id),
  unique (org_id, provider, session_id)
);

create table if not exists in_token_affinity_active_streams (
  request_id text primary key,
  org_id uuid not null,
  provider text not null,
  credential_id uuid not null,
  session_id text not null,
  started_at timestamptz not null default now(),
  last_touched_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists idx_in_token_affinity_assignments_session
  on in_token_affinity_assignments (org_id, provider, session_id);

create index if not exists idx_in_token_affinity_assignments_grace
  on in_token_affinity_assignments (org_id, provider, grace_expires_at);

create index if not exists idx_in_token_affinity_active_streams_partition
  on in_token_affinity_active_streams (org_id, provider, credential_id);

create index if not exists idx_in_token_affinity_active_streams_stale
  on in_token_affinity_active_streams (last_touched_at)
  where ended_at is null;
```

- [ ] **Step 5: Implement the repository with explicit atomic operations**

```ts
type ClaimPreferredAssignmentResult =
  | { outcome: 'claimed'; assignment: { orgId: string; provider: string; credentialId: string; sessionId: string; graceExpiresAt: Date | null } }
  | { outcome: 'already_owned_by_session'; assignment: { orgId: string; provider: string; credentialId: string; sessionId: string; graceExpiresAt: Date | null } }
  | { outcome: 'credential_unavailable' }
  | { outcome: 'session_already_bound'; assignment: { orgId: string; provider: string; credentialId: string; sessionId: string; graceExpiresAt: Date | null } };

export class TokenAffinityRepository {
  async getPreferredAssignment(input: { orgId: string; provider: string; sessionId: string }) {}
  async claimPreferredAssignment(input: { orgId: string; provider: string; sessionId: string; credentialId: string }): Promise<ClaimPreferredAssignmentResult> {}
  async clearPreferredAssignment(input: { orgId: string; provider: string; sessionId: string; credentialId?: string }) {}
  async touchPreferredAssignment(input: { orgId: string; provider: string; sessionId: string; credentialId: string; graceExpiresAt: Date | null }) {}
  async upsertActiveStream(input: { requestId: string; orgId: string; provider: string; credentialId: string; sessionId: string }) {}
  async touchActiveStream(input: { requestId: string; touchedAt: Date }): Promise<boolean> {}
  async clearActiveStream(input: { requestId: string }): Promise<null | {
    requestId: string;
    orgId: string;
    provider: string;
    credentialId: string;
    sessionId: string;
  }> {}
  async listBusyCredentialIds(input: { orgId: string; provider: string; staleBefore: Date }) {}
  async clearStaleActiveStreams(input: { staleBefore: Date }): Promise<Array<{
    requestId: string;
    orgId: string;
    provider: string;
    credentialId: string;
    sessionId: string;
  }>> {}
}
```

- [ ] **Step 6: Re-run the repository tests**

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/tokenAffinityRepository.test.ts`
Expected: PASS.

- [ ] **Step 7: Apply the migration locally**

Run: `cd /Users/dylanvu/innies && psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/017_token_affinity.sql`
Expected: `CREATE TABLE`, `CREATE INDEX`, and no SQL errors.

- [ ] **Step 8: Commit the persistence slice**

```bash
cd /Users/dylanvu/innies
git add docs/migrations/017_token_affinity.sql docs/migrations/017_token_affinity_no_extensions.sql api/src/repos/tableNames.ts api/src/repos/tokenAffinityRepository.ts api/tests/tokenAffinityRepository.test.ts
git commit -m "feat: add token affinity persistence"
```

### Task 2: Normalize session identity and teach the Codex wrapper to send it

**Files:**
- Create: `api/src/utils/sessionIdentity.ts`
- Modify: `api/src/routes/proxy.ts`
- Modify: `api/tests/proxy.tokenMode.route.test.ts`
- Modify: `api/tests/anthropicCompat.route.test.ts`
- Modify: `cli/src/commands/codex.js`
- Modify: `cli/tests/codexArgs.test.js`
- Modify: `cli/scripts/smoke.sh`

- [ ] **Step 1: Write the failing CLI and ingress tests**

```js
test('injects x-innies-session-id header config into codex args', () => {});
test('runCodex exports one INNIES_SESSION_ID per process invocation', async () => {});
```

```ts
it('uses x-innies-session-id on the direct token-mode proxy path', async () => {});
it('prefers x-innies-session-id over OpenClaw session fallbacks', async () => {});
it('falls back through OpenClaw session fields in documented order', async () => {});
it('ignores blank session ids and stays request-by-request when none are usable', async () => {});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `cd /Users/dylanvu/innies/cli && node --test tests/codexArgs.test.js`
Expected: FAIL because the new session-header assertions are not wired.

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/anthropicCompat.route.test.ts`
Expected: FAIL because no canonical session-identity helper exists yet.

- [ ] **Step 3: Add the session identity helper**

```ts
export type SessionIdentity = {
  sessionId: string | null;
  source: 'x-innies-session-id' | 'x-openclaw-session-id' | 'openclaw-session-id' | 'x-session-id' | 'metadata.openclaw_session_id' | 'payload.metadata.openclaw_session_id' | null;
};

export function resolveSessionIdentity(req: { header(name: string): string | undefined; body?: unknown }): SessionIdentity {
  const candidates = [
    ['x-innies-session-id', readHeader(req, 'x-innies-session-id')],
    ['x-openclaw-session-id', readHeader(req, 'x-openclaw-session-id')],
    ['openclaw-session-id', readHeader(req, 'openclaw-session-id')],
    ['x-session-id', readHeader(req, 'x-session-id')],
    ['metadata.openclaw_session_id', readMetadataSession(req.body, 'metadata.openclaw_session_id')],
    ['payload.metadata.openclaw_session_id', readMetadataSession(req.body, 'payload.metadata.openclaw_session_id')]
  ] as const;
  // return the first trimmed, non-empty value whose length is <= 256; otherwise { sessionId: null, source: null }
}
```

- [ ] **Step 4: Make ingress normalization use the helper as the single session source of truth**

```ts
const sessionIdentity = resolveSessionIdentity(req);
const correlation = resolveOpenClawCorrelation(req, requestId);

const normalizedCorrelation = {
  ...correlation,
  openclawSessionId: sessionIdentity.source === 'x-innies-session-id'
    ? correlation.openclawSessionId
    : sessionIdentity.sessionId
};
```

The goal here is:

- `sessionIdentity.ts` owns affinity/session resolution
- OpenClaw correlation keeps run/session audit fields for existing logs
- later `routeDecision.affinity` reads the canonical session helper, not duplicated header parsing

- [ ] **Step 5: Modify the Codex wrapper to generate and forward one session id per process**

```js
const sessionId = `sess_${crypto.randomUUID()}`;

const forcedArgs = [
  '--config', 'model_providers.innies.env_http_headers."x-innies-session-id"="INNIES_SESSION_ID"',
  '--config', 'model_providers.innies.env_http_headers."x-innies-provider-pin"="INNIES_PROVIDER_PIN"'
];

const env = {
  ...process.env,
  INNIES_SESSION_ID: sessionId
};
```

- [ ] **Step 6: Thread canonical session identity into current proxy metadata**

```ts
const sessionIdentity = resolveSessionIdentity(req);
const routeDecision = buildTokenRouteDecision(
  credential,
  correlation,
  providerPreference,
  compatTranslation,
  providerUsageMeta,
  {
    sessionId: sessionIdentity.sessionId,
    sessionSource: sessionIdentity.source
  }
);
```

- [ ] **Step 7: Re-run the targeted tests**

Run: `cd /Users/dylanvu/innies/cli && node --test tests/codexArgs.test.js`
Expected: PASS.

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/anthropicCompat.route.test.ts`
Expected: PASS.

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/proxy.tokenMode.route.test.ts`
Expected: PASS for the direct token-mode session-id cases.

- [ ] **Step 8: Re-run the CLI smoke script**

Run: `cd /Users/dylanvu/innies/cli && npm run test:smoke`
Expected: PASS and the fake Codex log contains both `x-innies-provider-pin` and `x-innies-session-id`.

- [ ] **Step 9: Commit the session-identity slice**

```bash
cd /Users/dylanvu/innies
git add api/src/utils/sessionIdentity.ts api/src/routes/proxy.ts api/tests/proxy.tokenMode.route.test.ts api/tests/anthropicCompat.route.test.ts cli/src/commands/codex.js cli/tests/codexArgs.test.js cli/scripts/smoke.sh
git commit -m "feat: add codex session identity plumbing"
```

## Chunk 2: Affinity Routing, Lifecycle, And Observability

### Task 3: Add the affinity service and pre-dispatch routing decisions

**Files:**
- Create: `api/src/services/tokenAffinityService.ts`
- Create: `api/tests/tokenAffinityService.test.ts`
- Modify: `api/src/services/runtime.ts`
- Modify: `api/src/routes/proxy.ts`
- Modify: `api/tests/proxy.tokenMode.route.test.ts`

- [ ] **Step 1: Write the failing service tests**

```ts
describe('tokenAffinityService', () => {
  it('reuses an eligible preferred credential', async () => {});
  it('claims only for streaming requests', async () => {});
  it('keeps non-streaming requests floating when no preference exists', async () => {});
  it('prefers healthy unprotected floating candidates before spillover', async () => {});
  it('partitions ownership by org_id + provider', async () => {});
});
```

- [ ] **Step 2: Add failing route coverage for the new routing reasons**

```ts
it('records preferred_token_reused in routeDecision.affinity', async () => {});
it('records preferred_token_claimed for first streaming claim', async () => {});
it('records preferred_token_unavailable_floating when no claimable token exists', async () => {});
it('records preferred_token_protected_spillover when every healthy token is protected', async () => {});
```

- [ ] **Step 3: Run the targeted tests to verify they fail**

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/tokenAffinityService.test.ts tests/proxy.tokenMode.route.test.ts`
Expected: FAIL because the service and affinity metadata do not exist yet.

- [ ] **Step 4: Implement the affinity service and runtime wiring**

```ts
export class TokenAffinityService {
  async resolveCredential(input: {
    orgId: string;
    provider: string;
    sessionId: string | null;
    requestId: string;
    streaming: boolean;
    credentials: TokenCredential[];
  }): Promise<{
    mode: 'preferred_reuse' | 'preferred_claim' | 'floating' | 'spillover';
    forcedCredentialId: string | null;
    floatingCredentialIds: string[];
    affinityMeta: Record<string, unknown>;
  }> {}
}
```

- [ ] **Step 5: Integrate the service into `proxy.ts` without breaking provider selection**

```ts
const affinityDecision = await runtime.services.tokenAffinity.resolveCredential({
  orgId,
  provider,
  sessionId: sessionIdentity.sessionId,
  requestId,
  streaming: parsed.streaming,
  credentials
});

const forcedCredential = affinityDecision.forcedCredentialId
  ? credentials.find((c) => c.id === affinityDecision.forcedCredentialId) ?? null
  : null;

const floatingCredentials = credentials.filter((c) => affinityDecision.floatingCredentialIds.includes(c.id));
```

- [ ] **Step 6: Extend `buildTokenRouteDecision` to write dedicated affinity metadata**

```ts
decision.affinity = {
  mode: affinityDecision.mode,
  reason: affinityDecision.affinityMeta.reason,
  session_id_present: sessionIdentity.sessionId !== null,
  partition_key: `${orgId}:${provider}`,
  preferred_credential_id: affinityDecision.affinityMeta.preferredCredentialId ?? null
};
```

- [ ] **Step 7: Re-run the targeted routing tests**

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/tokenAffinityService.test.ts tests/proxy.tokenMode.route.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit the routing slice**

```bash
cd /Users/dylanvu/innies
git add api/src/services/tokenAffinityService.ts api/tests/tokenAffinityService.test.ts api/src/services/runtime.ts api/src/routes/proxy.ts api/tests/proxy.tokenMode.route.test.ts
git commit -m "feat: add token affinity routing decisions"
```

### Task 4: Wire lifecycle hooks for stream busy state, cleanup, and grace

**Files:**
- Modify: `api/src/services/tokenAffinityService.ts`
- Modify: `api/src/repos/tokenAffinityRepository.ts`
- Modify: `api/src/routes/proxy.ts`
- Modify: `api/tests/tokenAffinityService.test.ts`
- Modify: `api/tests/proxy.tokenMode.route.test.ts`

- [ ] **Step 1: Add failing lifecycle coverage**

```ts
it('marks routed streaming requests busy on stream start and clears them on completion', async () => {});
it('drops newly claimed ownership when the request fails before stream start', async () => {});
it('starts grace only after the last overlapping preferred stream ends', async () => {});
it('does not let a new preferred claim land on a live spillover stream', async () => {});
it('clears stale active-stream rows and orphaned ownership together', async () => {});
```

- [ ] **Step 2: Run the lifecycle-focused tests to verify they fail**

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/tokenAffinityService.test.ts tests/proxy.tokenMode.route.test.ts`
Expected: FAIL because stream lifecycle hooks are incomplete.

- [ ] **Step 3: Implement proxy lifecycle hooks**

```ts
await runtime.services.tokenAffinity.onStreamStart({
  requestId,
  orgId,
  provider,
  credentialId,
  sessionId,
  ownsPreference
});

await runtime.services.tokenAffinity.onStreamComplete({ requestId, ownsPreference });
await runtime.services.tokenAffinity.onStreamBreakage({ requestId, ownsPreference });
await runtime.services.tokenAffinity.onNonStreamingPreferredSuccess({ orgId, provider, sessionId, credentialId });
await runtime.services.tokenAffinity.onClaimedRequestFailedBeforeUse({ orgId, provider, sessionId, credentialId });
```

- [ ] **Step 4: Implement stale-stream cleanup inside the service/repo**

```ts
const staleBefore = new Date(Date.now() - activeStreamStaleMs);
await repo.clearStaleActiveStreams({ staleBefore });
const busyCredentialIds = await repo.listBusyCredentialIds({ orgId, provider, staleBefore });
```

- [ ] **Step 5: Re-run the lifecycle tests**

Run: `cd /Users/dylanvu/innies/api && npx vitest run tests/tokenAffinityService.test.ts tests/proxy.tokenMode.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the lifecycle slice**

```bash
cd /Users/dylanvu/innies
git add api/src/services/tokenAffinityService.ts api/src/repos/tokenAffinityRepository.ts api/src/routes/proxy.ts api/tests/tokenAffinityService.test.ts api/tests/proxy.tokenMode.route.test.ts
git commit -m "feat: add token affinity lifecycle cleanup"
```

## Chunk 3: Docs, Manual Verification, And Final Gate

### Task 5: Document the feature and update manual verification helpers

**Files:**
- Modify: `docs/API_CONTRACT.md`
- Modify: `docs/CLI_UX.md`
- Modify: `api/scripts/token_mode_manual_check.sh`

- [ ] **Step 1: Add the failing smoke/manual assertions first**

```bash
cd /Users/dylanvu/innies/api
bash scripts/token_mode_manual_check.sh
```

Expected: output includes `routeDecision.affinity.reason`, the preferred-assignment row when one exists, and the active-stream row or an explicit `none`.

- [ ] **Step 2: Update the docs with the exact contract**

```md
- `x-innies-session-id` is the canonical session header.
- Accepted fallback session fields: `x-openclaw-session-id`, `openclaw-session-id`, `x-session-id`, `metadata.openclaw_session_id`, `payload.metadata.openclaw_session_id`.
- `routeDecision.affinity` is debug metadata only; provider-selection fields keep their current meaning.
```

- [ ] **Step 3: Extend the manual check script**

Run: `cd /Users/dylanvu/innies/api && bash scripts/token_mode_manual_check.sh`
Expected: PASS or a clear skipped-message when optional env like `DATABASE_URL` is missing.

- [ ] **Step 4: Commit the docs/manual slice**

```bash
cd /Users/dylanvu/innies
git add docs/API_CONTRACT.md docs/CLI_UX.md api/scripts/token_mode_manual_check.sh
git commit -m "docs: document token affinity routing"
```

### Task 6: Run the full verification gate and finish cleanly

**Files:**
- Modify: working tree only if a verification failure exposes a real bug

- [ ] **Step 1: Run the full API test suite**

Run: `cd /Users/dylanvu/innies/api && npm test`
Expected: PASS.

- [ ] **Step 2: Run the full CLI unit suite**

Run: `cd /Users/dylanvu/innies/cli && npm run test:unit`
Expected: PASS.

- [ ] **Step 3: Run the CLI smoke suite**

Run: `cd /Users/dylanvu/innies/cli && npm run test:smoke`
Expected: PASS.

- [ ] **Step 4: Re-run the manual token-mode check if env is available**

Run: `cd /Users/dylanvu/innies/api && bash scripts/token_mode_manual_check.sh`
Expected: PASS or explicit skipped DB-evidence messaging.

- [ ] **Step 5: Inspect the diff before final handoff**

Run: `cd /Users/dylanvu/innies && git --no-pager diff --stat && git status --short`
Expected: only planned token-affinity files remain modified.

- [ ] **Step 6: Create the final feature commit**

```bash
cd /Users/dylanvu/innies
git add docs/migrations/017_token_affinity.sql docs/migrations/017_token_affinity_no_extensions.sql api/src/repos/tableNames.ts api/src/repos/tokenAffinityRepository.ts api/src/services/tokenAffinityService.ts api/src/utils/sessionIdentity.ts api/src/services/runtime.ts api/src/routes/proxy.ts api/tests/tokenAffinityRepository.test.ts api/tests/tokenAffinityService.test.ts api/tests/proxy.tokenMode.route.test.ts api/tests/anthropicCompat.route.test.ts cli/src/commands/codex.js cli/tests/codexArgs.test.js cli/scripts/smoke.sh docs/API_CONTRACT.md docs/CLI_UX.md api/scripts/token_mode_manual_check.sh
git commit -m "feat: add codex token affinity routing"
```

- [ ] **Step 7: Record final verification in the handoff**

```md
- `cd api && npm test`
- `cd cli && npm run test:unit`
- `cd cli && npm run test:smoke`
- `cd api && bash scripts/token_mode_manual_check.sh`
```
