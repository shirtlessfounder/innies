import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

  assert.ok(typesSource.includes('export type OrgTokenStatus ='));
  assert.ok(typesSource.includes("'active' | 'paused' | 'rotating' | 'maxed' | 'expired' | 'revoked'"));
  assert.ok(typesSource.includes('export type OrgInvitePageState'));
  assert.ok(typesSource.includes('export type OrgRevealPageState'));
  assert.ok(typesSource.includes('export type OrgDashboardPageState'));
  assert.ok(typesSource.includes("reason: 'org_created' | 'invite_accepted'"));
  assert.ok(typesSource.includes('createdByGithubLogin: string | null'));
  assert.ok(typesSource.includes('debugLabel: string | null'));
  assert.ok(typesSource.includes('status: OrgTokenStatus'));
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

test('root page uses a single org creation entry point with OAuth continuation support', () => {
  const pageSource = readSource('src/app/page.tsx');
  const onboardSource = readSource('src/app/onboard/page.tsx');
  const formSource = readSource('src/components/org/OrgCreationForm.tsx');
  const headerSource = readSource('src/components/LandingHeroHeader.tsx');
  const landingSource = readSource('src/lib/org/landing.ts');
  const serverSource = readSource('src/lib/org/server.ts');

  assert.ok(pageSource.includes('OrgCreationForm'));
  assert.ok(pageSource.includes('primaryCta'));
  assert.ok(pageSource.includes('readPendingOrgName'));
  assert.ok(onboardSource.includes('getOrgLandingState'));
  assert.ok(serverSource.includes('/v1/org/session'));
  assert.ok(serverSource.includes('signedIn: Boolean(session)'));
  assert.ok(headerSource.includes('AUTH:'));
  assert.ok(headerSource.includes('ORGS:'));
  assert.ok(headerSource.includes('activeOrgs'));
  assert.ok(headerSource.includes('authGithubLogin'));
  assert.ok(headerSource.includes('github.com'));
  assert.ok(headerSource.includes('None'));
  assert.ok(pageSource.includes('activeOrgs={landing.activeOrgs}'));
  assert.ok(pageSource.includes('authGithubLogin={landing.authGithubLogin}'));
  assert.ok(onboardSource.includes('activeOrgs={landing.activeOrgs}'));
  assert.ok(onboardSource.includes('authGithubLogin={landing.authGithubLogin}'));
  assert.ok(formSource.includes('/api/orgs/create'));
  assert.ok(formSource.includes('app/analytics/page.module.css'));
  assert.ok(formSource.includes('buildOrgCreationAuthStartUrl'));
  assert.ok(formSource.includes('window.location.assign'));
  assert.ok(formSource.includes('signedIn: boolean;'));
  assert.ok(formSource.includes('authStartUrl: string;'));
  assert.ok(formSource.includes('initialOrgName?: string;'));
  assert.ok(formSource.includes('managementInput'));
  assert.ok(formSource.includes('noticeError'));
  assert.ok(!formSource.includes('style={{'));
  assert.match(formSource, /router\.(push|replace)\(\s*`\/\$\{.*orgSlug.*\}`/);
  assert.ok(formSource.includes('reserved'));
  assert.ok(formSource.includes('already exists'));
  assert.ok(formSource.includes('Create /${slugPreview} org'));
  assert.ok(formSource.includes('autoComplete="off"'));
  assert.ok(formSource.includes('spellCheck={false}'));
  assert.ok(formSource.includes('autoCorrect="off"'));
  assert.ok(formSource.includes('autoCapitalize="off"'));
  assert.ok(formSource.includes('placeholder="me-and-the-boys"'));
  assert.ok(landingSource.includes('createOrg'));
  assert.ok(landingSource.includes('buildLandingOrgCreateReturnTo'));
  assert.ok(!formSource.includes('Org name'));
  assert.ok(!formSource.includes('Spaces become dashes'));
  assert.ok(!formSource.includes('Slug preview'));
});

test('org slug preview helper normalizes names into route-safe slugs', async () => {
  const { deriveOrgSlugPreview } = await import('../src/lib/org/slug.ts');

  assert.equal(deriveOrgSlugPreview('Acme Research'), 'acme-research');
  assert.equal(deriveOrgSlugPreview('  ACME__Research  '), 'acme-research');
  assert.equal(deriveOrgSlugPreview('***'), null);
});

test('invite acceptance keeps inline errors and redirects only on success', () => {
  const cardSource = readSource('src/components/org/InviteAcceptanceCard.tsx');
  const errorSource = readSource('src/components/org/inviteAcceptanceError.ts');

  assert.ok(cardSource.includes('app/analytics/page.module.css'));
  assert.ok(!cardSource.includes('orgDashboard.module.css'));
  assert.ok(cardSource.includes('/api/orgs/${orgSlug}/invites/accept'));
  assert.ok(cardSource.includes('getInviteAcceptanceErrorMessage'));
  assert.ok(errorSource.includes('invite_no_longer_valid'));
  assert.ok(!errorSource.includes('Leave that org first'));
  assert.ok(cardSource.includes('router.push'));
  assert.ok(cardSource.includes('Accept invite'));
  assert.ok(cardSource.includes('setError'));
  assert.ok(cardSource.includes('className={analyticsStyles.managementPrimaryButton}'));
  assert.ok(!cardSource.includes('className={analyticsStyles.controlButton}'));
});

test('org dashboard sections expose reserve inputs, token attribution, and role-aware member controls', () => {
  const tokensSource = readSource('src/components/org/OrgDashboardTokens.tsx');
  const membersSource = readSource('src/components/org/OrgDashboardMembers.tsx');
  const sectionsSource = readSource('src/components/org/OrgDashboardSections.tsx');
  const managementSource = readSource('src/components/org/OrgManagementSections.tsx');
  const toolbarSource = readSource('src/components/org/OrgDashboardToolbarActions.tsx');
  const modalShellSource = readSource('src/components/org/OrgModalShell.tsx');
  const analyticsClientSource = readSource('src/app/analytics/AnalyticsDashboardClient.tsx');

  assert.ok(tokensSource.includes('5h'));
  assert.ok(tokensSource.includes('1w'));
  assert.ok(tokensSource.includes('app/analytics/page.module.css'));
  assert.ok(!tokensSource.includes('orgDashboard.module.css'));
  assert.ok(tokensSource.includes('createdByGithubLogin'));
  assert.ok(tokensSource.includes('token.debugLabel'));
  assert.ok(tokensSource.includes('>Token</th>'));
  assert.ok(!tokensSource.includes('<th>Label</th>'));
  assert.ok(tokensSource.includes('className={analyticsStyles.table}'));
  assert.ok(!tokensSource.includes('tableFillIfShorter'));
  assert.ok(!tokensSource.includes('tableFitContent'));
  assert.ok(tokensSource.includes('tableBracketField'));
  assert.ok(tokensSource.includes('/api/orgs/${org.slug}/tokens/${token.tokenId}/probe'));
  assert.ok(tokensSource.includes('/api/orgs/${org.slug}/tokens/${token.tokenId}/remove'));
  assert.ok(tokensSource.includes('canManageAllTokens'));
  assert.ok(tokensSource.includes('function canProbeToken(status: OrgTokenStatus): boolean {'));
  assert.ok(tokensSource.includes("return status === 'active' || status === 'maxed';"));
  assert.ok(tokensSource.includes('const probeEnabled = canProbeToken(token.status);'));
  assert.ok(!tokensSource.includes('tableColumnTight'));
  assert.ok(!tokensSource.includes('tableColumnStretch'));
  assert.ok(!tokensSource.includes('<colgroup>'));
  assert.ok(!tokensSource.includes('tableGrowColumn'));
  assert.ok(!tokensSource.includes('tableTightColumn'));
  assert.ok(tokensSource.includes('tableActionsColumn'));
  assert.ok(!tokensSource.includes('handleAddToken'));
  assert.ok(!tokensSource.includes('managementFormGrid'));
  assert.ok(!tokensSource.includes('Paste provider token'));

  assert.ok(membersSource.includes('pendingInvites'));
  assert.ok(membersSource.includes('app/analytics/page.module.css'));
  assert.ok(!membersSource.includes('orgDashboard.module.css'));
  assert.ok(membersSource.includes('/api/orgs/${org.slug}/invites/revoke'));
  assert.ok(membersSource.includes('/api/orgs/${org.slug}/members/${member.userId}/remove'));
  assert.ok(membersSource.includes('className={analyticsStyles.table}'));
  assert.ok(!membersSource.includes('tableFillIfShorter'));
  assert.ok(!membersSource.includes('tableFitContent'));
  assert.ok(!membersSource.includes('tableColumnTight'));
  assert.ok(!membersSource.includes('tableColumnStretch'));
  assert.ok(!membersSource.includes('<colgroup>'));
  assert.ok(!membersSource.includes('tableGrowColumn'));
  assert.ok(!membersSource.includes('tableTightColumn'));
  assert.ok(membersSource.includes('tableActionsColumn'));
  assert.ok(membersSource.includes('membership.isOwner'));
  assert.ok(!membersSource.includes('managementSplitRow'));
  assert.ok(!membersSource.includes('GitHub username'));
  assert.ok(!membersSource.includes("pendingAction === 'invite'"));
  assert.ok(!membersSource.includes('/api/orgs/${org.slug}/leave'));
  assert.ok(!membersSource.includes('id="leave-org"'));

  assert.ok(managementSource.includes('OrgDashboardTokens'));
  assert.ok(managementSource.includes('OrgDashboardMembers'));
  assert.ok(toolbarSource.includes('OrgModalShell'));
  assert.ok(toolbarSource.includes('ADD TOKEN'));
  assert.ok(toolbarSource.includes('INVITE MEMBER'));
  assert.ok(toolbarSource.includes('LEAVE ORG'));
  assert.ok(toolbarSource.includes('`leave ${org.slug}`'));
  assert.ok(toolbarSource.includes('Remove yourself from this org if you no longer need access.'));
  assert.ok(toolbarSource.includes('Could not leave this org.'));
  assert.ok(toolbarSource.includes('/api/orgs/${org.slug}/leave'));
  assert.ok(!toolbarSource.includes('href="#leave-org"'));
  assert.ok(toolbarSource.includes('`add token to ${org.slug}`'));
  assert.ok(toolbarSource.includes('`invite member to ${org.slug}`'));
  assert.ok(toolbarSource.includes('GitHub username *'));
  assert.ok(toolbarSource.includes('placeholder="octocat"'));
  assert.ok(toolbarSource.includes('Create invite'));
  assert.ok(toolbarSource.includes('GitHub username is required.'));
  assert.ok(toolbarSource.includes('Could not create this invite.'));
  assert.ok(toolbarSource.includes('Invite a GitHub username to this org.'));
  assert.ok(toolbarSource.includes('They will see the invite the next time they open this org route.'));
  assert.ok(toolbarSource.includes('/api/orgs/${org.slug}/invites'));
  assert.ok(!toolbarSource.includes('Add Claude and Codex tokens to this org.'));
  assert.ok(!toolbarSource.includes('Tokens can only be added to one org at a time.'));
  assert.ok(toolbarSource.includes('href="/onboard"'));
  assert.ok(toolbarSource.includes('OAuth token *'));
  assert.ok(toolbarSource.includes('Refresh token'));
  assert.ok(toolbarSource.includes('Debug label *'));
  assert.ok(toolbarSource.includes('Provider *'));
  assert.ok(toolbarSource.includes('name="debugLabel"'));
  assert.ok(toolbarSource.includes('placeholder="testing-test-claude-main"'));
  assert.ok(toolbarSource.includes('placeholder="Paste oauth token"'));
  assert.ok(toolbarSource.includes('placeholder="Paste refresh token"'));
  assert.ok(toolbarSource.includes('placeholder="For you only"'));
  assert.ok(!toolbarSource.includes('Paste provider token'));
  assert.ok(!toolbarSource.includes('CLOSE'));
  assert.ok(!toolbarSource.includes('Cancel'));
  assert.ok(toolbarSource.includes('/api/orgs/${org.slug}/tokens/add'));
  assert.ok(toolbarSource.includes('className={analyticsStyles.controlButton}'));
  assert.ok(toolbarSource.includes('refreshToken'));
  assert.ok(toolbarSource.includes('Provider, debug label, oauth token, and refresh token are required.'));
  assert.ok(toolbarSource.includes('className={analyticsStyles.modalFormPair}'));
  assert.ok(toolbarSource.indexOf('Debug label *') < toolbarSource.indexOf('OAuth token *'));
  assert.ok(modalShellSource.includes('role="dialog"'));
  assert.ok(modalShellSource.includes('aria-labelledby={titleId}'));
  assert.ok(modalShellSource.includes('aria-describedby={bodyId}'));
  assert.ok(modalShellSource.includes('tabIndex={-1}'));
  assert.ok(modalShellSource.includes('useId'));
  assert.ok(modalShellSource.includes('useRef'));
  assert.ok(modalShellSource.includes('previousActiveElementRef'));
  assert.ok(modalShellSource.includes("event.key === 'Tab'"));
  assert.ok(modalShellSource.includes('dialogRef.current?.focus()'));
  assert.ok(modalShellSource.includes('previousActiveElement?.focus()'));
  assert.ok(modalShellSource.includes('modalBackdrop'));
  assert.ok(modalShellSource.includes('modalCard'));
  assert.ok(modalShellSource.includes("document.body.style.overflow = 'hidden'"));
  assert.ok(modalShellSource.includes("document.body.style.overflow = previousOverflow"));
  assert.ok(sectionsSource.includes('AnalyticsDashboardClient'));
  assert.ok(sectionsSource.includes('OrgManagementSections'));
  assert.ok(sectionsSource.includes('view={ownerView}'));
  assert.ok(sectionsSource.includes('useAnalyticsDashboard'));
  assert.ok(!sectionsSource.includes('usePublicLiveMeta'));
  assert.ok(sectionsSource.includes('dashboardPath'));
  assert.ok(sectionsSource.includes('timeseriesPath'));
  assert.ok(sectionsSource.includes('tokenSectionMetaAction='));
  assert.ok(sectionsSource.includes('[CLICK TO ADD TOKENS]'));
  assert.ok(!sectionsSource.includes('normalizeOrgAnalyticsSnapshot'));
  assert.ok(!sectionsSource.includes('fetchAnalyticsSnapshot'));

  assert.ok(analyticsClientSource.includes('authGithubLogin?: string | null'));
  assert.ok(analyticsClientSource.includes('activeOrgs?: OrgHeaderOrg[]'));
  assert.ok(analyticsClientSource.includes('orgSlug?: string | null'));
  assert.ok(analyticsClientSource.includes('toolbarAction?: ReactNode'));
  assert.ok(analyticsClientSource.includes('tokenSectionMetaAction?: ReactNode'));
  assert.ok(analyticsClientSource.includes('kickerLabel?: string'));
  assert.ok(analyticsClientSource.includes('tokenSectionTitle?: string'));
  assert.ok(analyticsClientSource.includes('buyerSectionTitle?: string'));
  assert.ok(analyticsClientSource.includes('AUTH:'));
  assert.ok(analyticsClientSource.includes('ORGS:'));
  assert.ok(analyticsClientSource.includes('activeOrgs'));
  assert.equal(existsSync(join(uiRoot, 'src/components/org/orgDashboard.module.css')), false);
});

test('org route pages render sign-in, invite, reveal, dashboard, and innies contracts without a standalone analytics route', () => {
  const orgPageSource = readSource('src/app/[orgSlug]/page.tsx');
  const inniesPageSource = readSource('src/app/innies/page.tsx');
  const landingPageSource = readSource('src/app/page.tsx');
  const modalShellSource = readSource('src/components/org/OrgModalShell.tsx');
  const analyticsStylesSource = readSource('src/app/analytics/page.module.css');
  const serverSource = readSource('src/lib/org/server.ts');

  assert.ok(orgPageSource.includes('getOrgPageState'));
  assert.ok(orgPageSource.includes('analytics/page.module.css'));
  assert.ok(!orgPageSource.includes('orgDashboard.module.css'));
  assert.ok(orgPageSource.includes('notFound()'));
  assert.ok(orgPageSource.includes('OrgStateModalPage'));
  assert.ok(orgPageSource.includes("if (state.kind === 'sign_in')"));
  assert.ok(orgPageSource.includes("if (state.kind === 'not_invited')"));
  assert.ok(orgPageSource.includes("if (state.kind === 'invite')"));
  assert.ok(orgPageSource.includes("if (state.kind === 'reveal')"));
  assert.ok(orgPageSource.includes('state.authStartUrl'));
  assert.ok(orgPageSource.includes('actions={<a className={analyticsStyles.controlButton} href={state.authStartUrl}>Sign in with GitHub</a>}'));
  assert.ok(orgPageSource.includes('InviteAcceptanceCard'));
  assert.ok(orgPageSource.includes('OrgModalShell'));
  assert.ok(orgPageSource.includes('OrgDashboardSections'));
  assert.ok(orgPageSource.includes('buyerKey'));
  assert.ok(orgPageSource.includes('state.reveal.reason'));
  assert.ok(orgPageSource.includes('INNIES.COMPUTER'));
  assert.ok(orgPageSource.includes('href="/"'));
  assert.ok(orgPageSource.includes('{input.orgSlug.toUpperCase()}'));
  assert.ok(orgPageSource.includes('className={analyticsStyles.modalFormStack}'));
  assert.ok(orgPageSource.includes('Sign in with GitHub'));
  assert.ok(orgPageSource.includes('You must be whitelisted to view this org route. Continue to verify your identity.'));
  assert.ok(orgPageSource.includes('Dismiss reveal'));
  assert.ok(!orgPageSource.includes('A pending org invite matches the current GitHub login.'));
  assert.ok(!orgPageSource.includes('/ ORG /'));
  assert.ok(modalShellSource.includes('modalScope'));
  assert.ok(modalShellSource.includes('modalBackdrop'));
  assert.ok(modalShellSource.includes('modalCard'));
  assert.ok(modalShellSource.includes("document.body.style.overflow = 'hidden'"));
  assert.ok(modalShellSource.includes("document.documentElement.style.overflow = 'hidden'"));

  assert.ok(inniesPageSource.includes('AnalyticsDashboardClient'));
  assert.ok(inniesPageSource.includes('getOrgHeaderMeta'));
  assert.ok(inniesPageSource.includes('dashboardPath="/api/innies/analytics/dashboard"'));
  assert.ok(inniesPageSource.includes('timeseriesPath="/api/innies/analytics/timeseries"'));
  assert.ok(inniesPageSource.includes('monitor the innies'));
  assert.ok(inniesPageSource.includes('activeOrgs={headerMeta.activeOrgs}'));
  assert.ok(inniesPageSource.includes('orgSlug="innies"'));
  assert.ok(!inniesPageSource.includes("getOrgHeaderMeta({ orgSlug: 'innies' })"));
  assert.ok(!inniesPageSource.includes("getOrgPageState('innies')"));
  assert.ok(!inniesPageSource.includes('OrgDashboardSections'));
  assert.ok(!inniesPageSource.includes('InviteAcceptanceCard'));
  assert.ok(landingPageSource.includes('href="/innies"'));
  assert.ok(!landingPageSource.includes('href="/analytics"'));
  assert.equal(existsSync(join(uiRoot, 'src/app/analytics/page.tsx')), false);
  assert.equal(existsSync(join(uiRoot, 'src/lib/org/analytics.ts')), false);
  assert.ok(serverSource.includes('function resolveOrgAuthStartUrl(authStartUrl: string): string'));
  assert.ok(serverSource.includes('new URL(authStartUrl, `${readApiBaseUrl()}/`)'));
  assert.ok(serverSource.includes('authStartUrl: resolveOrgAuthStartUrl(access.authStartUrl)'));
  assert.match(
    analyticsStylesSource,
    /\.managementPrimaryButton:link,\s*\.managementPrimaryButton:visited,\s*\.managementPrimaryButton:active,\s*\.managementPrimaryButton:focus,\s*\.managementPrimaryButton:focus-visible,\s*\.managementSecondaryButton:link,\s*\.managementSecondaryButton:visited,\s*\.managementSecondaryButton:active,\s*\.managementSecondaryButton:focus,\s*\.managementSecondaryButton:focus-visible,\s*\.managementInlineButton:link,\s*\.managementInlineButton:visited,\s*\.managementInlineButton:active,\s*\.managementInlineButton:focus,\s*\.managementInlineButton:focus-visible\s*\{[\s\S]*text-decoration:\s*none;/
  );
  assert.doesNotMatch(
    analyticsStylesSource,
    /\.managementPrimaryButton,\s*\.managementPrimaryButton:link[\s\S]*color:\s*inherit;/
  );
});
