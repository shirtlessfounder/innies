import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');

function readSource(relativePath) {
  return readFileSync(join(uiRoot, relativePath), 'utf8');
}

test('org page helpers consume org access contracts and expand invite/reveal/dashboard state', () => {
  const typesSource = readSource('src/lib/org/types.ts');
  const serverSource = readSource('src/lib/org/server.ts');

  assert.ok(typesSource.includes('export type OrgInvitePageState'));
  assert.ok(typesSource.includes('export type OrgRevealPageState'));
  assert.ok(typesSource.includes('export type OrgDashboardPageState'));
  assert.ok(typesSource.includes("reason: 'org_created' | 'invite_accepted'"));
  assert.ok(typesSource.includes('createdByGithubLogin: string | null'));
  assert.ok(typesSource.includes('fiveHourReservePercent: number'));
  assert.ok(typesSource.includes('sevenDayReservePercent: number'));
  assert.ok(typesSource.includes('pendingInvites: Array<{'));
  assert.ok(typesSource.includes("kind: 'sign_in'"));
  assert.ok(typesSource.includes("kind: 'invite'"));
  assert.ok(typesSource.includes("kind: 'reveal'"));
  assert.ok(typesSource.includes("kind: 'dashboard'"));

  assert.ok(serverSource.includes('fetchPilotJson'));
  assert.ok(serverSource.includes('/v1/orgs/${orgSlug}/access'));
  assert.ok(serverSource.includes("case 'sign_in_required'"));
  assert.ok(serverSource.includes("case 'pending_invite'"));
  assert.ok(serverSource.includes("case 'active_membership'"));
  assert.ok(serverSource.includes('/v1/orgs/${orgSlug}/tokens'));
  assert.ok(serverSource.includes('/v1/orgs/${orgSlug}/members'));
  assert.ok(serverSource.includes('/v1/orgs/${orgSlug}/invites'));
  assert.ok(serverSource.includes('pendingInvites: []'));
  assert.ok(serverSource.includes('/api/orgs/${orgSlug}/analytics/dashboard'));
  assert.ok(serverSource.includes('/api/orgs/${orgSlug}/analytics/timeseries'));
});

test('org cookie helpers derive a shared parent domain and org-scoped reveal-cookie helpers', async () => {
  const sessionCookieSource = readSource('src/lib/org/sessionCookie.ts');
  const routeSource = readSource('src/app/[orgSlug]/page.tsx');
  const {
    resolveOrgSessionCookieDomain,
    ORG_REVEAL_COOKIE_NAME,
    getOrgRevealCookiePath,
  } = await import('../src/lib/org/sessionCookie.ts');

  assert.equal(
    resolveOrgSessionCookieDomain('https://www.innies.computer/acme', 'https://api.innies.computer'),
    'innies.computer'
  );
  assert.equal(
    resolveOrgSessionCookieDomain('http://localhost:3000/acme', 'http://localhost:4010'),
    null
  );
  assert.equal(ORG_REVEAL_COOKIE_NAME, 'innies_org_reveal');
  assert.equal(getOrgRevealCookiePath('acme-inc'), '/acme-inc');
  assert.ok(sessionCookieSource.includes('ORG_REVEAL_COOKIE_NAME'));
  assert.ok(sessionCookieSource.includes('ORG_SESSION_COOKIE_NAME'));
  assert.ok(sessionCookieSource.includes('readOrgRevealCookie'));
  assert.ok(sessionCookieSource.includes('buyerKey'));
  assert.ok(sessionCookieSource.includes('reason'));
  assert.ok(routeSource.includes('/api/orgs/${orgSlug}/reveal/dismiss'));
});

test('root page swaps between org creation and GitHub sign-in entry states', () => {
  const pageSource = readSource('src/app/page.tsx');
  const formSource = readSource('src/components/org/OrgCreationForm.tsx');

  assert.ok(pageSource.includes('OrgCreationForm'));
  assert.ok(pageSource.includes('Sign in with GitHub'));
  assert.ok(pageSource.includes('primaryCta'));
  assert.ok(formSource.includes('/api/orgs/create'));
  assert.match(formSource, /router\.(push|replace)\(\s*`\/\$\{.*orgSlug.*\}`/);
  assert.ok(formSource.includes('reserved'));
  assert.ok(formSource.includes('already exists'));
});

test('invite acceptance keeps inline errors and redirects only on success', () => {
  const cardSource = readSource('src/components/org/InviteAcceptanceCard.tsx');

  assert.ok(cardSource.includes('/api/orgs/${orgSlug}/invites/accept'));
  assert.ok(cardSource.includes('invite_no_longer_valid'));
  assert.ok(cardSource.includes('router.push'));
  assert.ok(cardSource.includes('Accept invite'));
  assert.ok(cardSource.includes('setError'));
});

test('org dashboard sections expose reserve inputs, token attribution, and role-aware member controls', () => {
  const tokensSource = readSource('src/components/org/OrgDashboardTokens.tsx');
  const membersSource = readSource('src/components/org/OrgDashboardMembers.tsx');
  const sectionsSource = readSource('src/components/org/OrgDashboardSections.tsx');
  const cssSource = readSource('src/components/org/orgDashboard.module.css');

  assert.ok(tokensSource.includes('5h'));
  assert.ok(tokensSource.includes('1w'));
  assert.ok(tokensSource.includes('name="fiveHourReservePercent"'));
  assert.ok(tokensSource.includes('name="sevenDayReservePercent"'));
  assert.ok(tokensSource.includes('createdByGithubLogin'));
  assert.ok(tokensSource.includes('/api/orgs/${org.slug}/tokens/add'));
  assert.ok(tokensSource.includes('/api/orgs/${org.slug}/tokens/${token.tokenId}/refresh'));
  assert.ok(tokensSource.includes('/api/orgs/${org.slug}/tokens/${token.tokenId}/remove'));
  assert.ok(tokensSource.includes('canManageAllTokens'));

  assert.ok(membersSource.includes('pendingInvites'));
  assert.ok(membersSource.includes('/api/orgs/${org.slug}/invites'));
  assert.ok(membersSource.includes('/api/orgs/${org.slug}/invites/revoke'));
  assert.ok(membersSource.includes('/api/orgs/${org.slug}/members/${member.userId}/remove'));
  assert.ok(membersSource.includes('/api/orgs/${org.slug}/leave'));
  assert.ok(membersSource.includes('Leave org'));
  assert.ok(membersSource.includes('membership.isOwner'));

  assert.ok(sectionsSource.includes('OrgDashboardTokens'));
  assert.ok(sectionsSource.includes('OrgDashboardMembers'));
  assert.ok(sectionsSource.includes('dashboardPath'));
  assert.ok(sectionsSource.includes('timeseriesPath'));

  assert.ok(cssSource.includes('.page'));
  assert.ok(cssSource.includes('.hero'));
  assert.ok(cssSource.includes('.section'));
  assert.ok(cssSource.includes('.table'));
});

test('org route pages render sign-in, invite, reveal, dashboard, and innies redirect contracts', () => {
  const orgPageSource = readSource('src/app/[orgSlug]/page.tsx');
  const inniesPageSource = readSource('src/app/innies/page.tsx');
  const analyticsPageSource = readSource('src/app/analytics/page.tsx');

  assert.ok(orgPageSource.includes('getOrgPageState'));
  assert.ok(orgPageSource.includes('notFound()'));
  assert.ok(orgPageSource.includes('state.authStartUrl'));
  assert.ok(orgPageSource.includes('InviteAcceptanceCard'));
  assert.ok(orgPageSource.includes('OrgDashboardSections'));
  assert.ok(orgPageSource.includes('buyerKey'));
  assert.ok(orgPageSource.includes('invite_accepted'));
  assert.ok(orgPageSource.includes('org_created'));

  assert.ok(inniesPageSource.includes("getOrgPageState('innies')"));
  assert.ok(inniesPageSource.includes('OrgDashboardSections'));
  assert.ok(analyticsPageSource.includes("redirect('/innies')"));
});
