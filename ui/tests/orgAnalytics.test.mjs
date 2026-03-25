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

test('org analytics routes reuse the shared analytics dashboard client and no longer depend on a bespoke org helper', () => {
  const sectionsSource = readSource('src/components/org/OrgDashboardSections.tsx');
  const managementSource = readSource('src/components/org/OrgManagementSections.tsx');
  const toolbarSource = readSource('src/components/org/OrgDashboardToolbarActions.tsx');
  const modalShellSource = readSource('src/components/org/OrgModalShell.tsx');
  const clientSource = readSource('src/app/analytics/AnalyticsDashboardClient.tsx');

  assert.ok(sectionsSource.includes('AnalyticsDashboardClient'));
  assert.ok(sectionsSource.includes('dashboardPath={data.analyticsPaths.dashboardPath}'));
  assert.ok(sectionsSource.includes('timeseriesPath={data.analyticsPaths.timeseriesPath}'));
  assert.ok(sectionsSource.includes('authGithubLogin={data.membership.githubLogin}'));
  assert.ok(sectionsSource.includes('orgSlug={orgSlug}'));
  assert.ok(sectionsSource.includes('<OrgManagementSections data={data} />'));
  assert.ok(sectionsSource.includes('toolbarAction={toolbarAction}'));
  assert.ok(sectionsSource.includes('tokenSectionMetaAction='));
  assert.ok(sectionsSource.includes('[CLICK TO ADD TOKENS]'));
  assert.ok(sectionsSource.includes("const dashboardTitle = orgSlug === 'innies' ? 'monitor the innies' : `monitor ${orgSlug} innies`;"));
  assert.ok(sectionsSource.includes('tokenSectionTitle="TOKEN CREDS (innies)"'));
  assert.ok(sectionsSource.includes('buyerSectionTitle="BUYER KEYS (outies)"'));
  assert.ok(!sectionsSource.includes('tokenSectionTitle={`TOKEN CREDS (${orgSlug})`}'));
  assert.ok(!sectionsSource.includes('buyerSectionTitle={`BUYER KEYS (${orgSlug})`}'));

  assert.ok(managementSource.includes('OrgDashboardTokens'));
  assert.ok(managementSource.includes('OrgDashboardMembers'));

  assert.ok(toolbarSource.includes('ADD TOKEN'));
  assert.ok(toolbarSource.includes('INVITE MEMBER'));
  assert.ok(toolbarSource.includes('LEAVE ORG'));
  assert.ok(toolbarSource.includes('OrgModalShell'));
  assert.ok(toolbarSource.includes('/api/orgs/${org.slug}/leave'));
  assert.ok(toolbarSource.includes('`leave ${org.slug}`'));
  assert.ok(toolbarSource.includes('Remove yourself from this org if you no longer need access.'));
  assert.ok(toolbarSource.includes('Could not leave this org.'));
  assert.ok(!toolbarSource.includes('href="#leave-org"'));
  assert.ok(toolbarSource.includes('`add token to ${org.slug}`'));
  assert.ok(toolbarSource.includes('`invite member to ${org.slug}`'));
  assert.ok(toolbarSource.includes('Provider *'));
  assert.ok(toolbarSource.includes('Debug label *'));
  assert.ok(toolbarSource.includes('OAuth token *'));
  assert.ok(toolbarSource.includes('Refresh token *'));
  assert.ok(toolbarSource.includes('5h reserve %'));
  assert.ok(toolbarSource.includes('1w reserve %'));
  assert.ok(toolbarSource.includes('GitHub username *'));
  assert.ok(toolbarSource.includes('name="debugLabel"'));
  assert.ok(toolbarSource.includes('placeholder="octocat"'));
  assert.ok(toolbarSource.includes('placeholder="testing-test-claude-main"'));
  assert.ok(toolbarSource.includes('placeholder="Paste oauth token"'));
  assert.ok(toolbarSource.includes('placeholder="Paste refresh token"'));
  assert.ok(toolbarSource.includes('placeholder="For you only"'));
  assert.ok(toolbarSource.includes('href="/onboard"'));
  assert.ok(toolbarSource.includes('refreshToken'));
  assert.ok(toolbarSource.includes('className={analyticsStyles.modalFormStack}'));
  assert.ok(toolbarSource.includes('className={analyticsStyles.modalFormPair}'));
  assert.ok(toolbarSource.indexOf('Debug label *') < toolbarSource.indexOf('OAuth token *'));
  assert.ok(!toolbarSource.includes('Add Claude and Codex tokens to this org.'));
  assert.ok(!toolbarSource.includes('Tokens can only be added to one org at a time.'));
  assert.ok(toolbarSource.includes('GitHub username is required.'));
  assert.ok(toolbarSource.includes('Could not create this invite.'));
  assert.ok(toolbarSource.includes('Create invite'));
  assert.ok(toolbarSource.includes('Invite a GitHub username to this org.'));
  assert.ok(toolbarSource.includes('They will see the invite the next time they open this org route.'));
  assert.ok(toolbarSource.includes('/api/orgs/${org.slug}/invites'));
  assert.ok(!toolbarSource.includes('Paste provider token'));
  assert.ok(!toolbarSource.includes('CLOSE'));
  assert.ok(!toolbarSource.includes('Cancel'));
  assert.ok(toolbarSource.includes('/api/orgs/${org.slug}/tokens/add'));
  assert.ok(toolbarSource.includes('className={analyticsStyles.controlButton}'));
  assert.ok(readSource('src/app/analytics/page.module.css').includes('border-radius: 10px;'));
  assert.ok(readSource('src/app/analytics/page.module.css').includes('.modalFormPair'));
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
  assert.ok(modalShellSource.includes("document.body.style.overflow = 'hidden'"));
  assert.ok(modalShellSource.includes("document.body.style.overflow = previousOverflow"));

  assert.ok(clientSource.includes('dashboardPath?: string;'));
  assert.ok(clientSource.includes('timeseriesPath?: string;'));
  assert.ok(clientSource.includes('toolbarLead?: ReactNode;'));
  assert.ok(clientSource.includes('toolbarAction?: ReactNode;'));
  assert.ok(clientSource.includes('tokenSectionMetaAction?: ReactNode;'));
  assert.ok(clientSource.includes('authGithubLogin?: string | null;'));
  assert.ok(clientSource.includes('activeOrgs?: OrgHeaderOrg[];'));
  assert.ok(clientSource.includes('orgSlug?: string | null;'));
  assert.ok(clientSource.includes('tokenSectionTitle?: string;'));
  assert.ok(clientSource.includes('buyerSectionTitle?: string;'));
  assert.ok(clientSource.includes("const buyerSectionTitle = input.buyerSectionTitle ?? 'BUYER KEYS (outies)'"));
  assert.ok(!clientSource.includes('const buyerSectionTitle = input.buyerSectionTitle ?? `BUYER KEYS (${orgSlug})`;'));
  assert.ok(clientSource.includes('AUTH:'));
  assert.ok(clientSource.includes('ORGS:'));
  assert.ok(clientSource.includes('activeOrgs'));
  assert.ok(clientSource.includes('` / ${orgSlug.toUpperCase()}`'));
  assert.ok(!clientSource.includes('` / ANALYTICS / ${orgSlug.toUpperCase()}`'));

  assert.equal(existsSync(join(uiRoot, 'src/lib/org/analytics.ts')), false);
  assert.ok(!sectionsSource.includes('normalizeOrgAnalyticsSnapshot'));
  assert.ok(sectionsSource.includes('kickerLabel={` / ${orgSlug.toUpperCase()}`}'));
  assert.ok(!sectionsSource.includes('kickerLabel={` / ANALYTICS / ${orgSlug.toUpperCase()}`}'));
});

test('org owners can toggle between analytics and management views on the same org route', () => {
  const sectionsSource = readSource('src/components/org/OrgDashboardSections.tsx');
  const clientSource = readSource('src/app/analytics/AnalyticsDashboardClient.tsx');
  const stylesSource = readSource('src/app/analytics/page.module.css');

  assert.ok(sectionsSource.includes("'use client'"));
  assert.ok(sectionsSource.includes("type OwnerView = 'analytics' | 'management';"));
  assert.ok(sectionsSource.includes("useState<OwnerView>('analytics')"));
  assert.ok(sectionsSource.includes('data.membership.isOwner'));
  assert.ok(sectionsSource.includes('ANALYTICS'));
  assert.ok(sectionsSource.includes('MANAGEMENT'));
  assert.ok(sectionsSource.includes("ownerView === 'management'"));
  assert.ok(sectionsSource.includes('toolbarLead={ownerToggle}'));
  assert.ok(sectionsSource.includes('useAnalyticsDashboard'));
  assert.ok(sectionsSource.includes('dashboardPath: data.analyticsPaths.dashboardPath'));
  assert.ok(sectionsSource.includes('LAST {formatTimestamp(managementDashboard.lastSuccessfulUpdateAt)}'));
  assert.ok(sectionsSource.includes('analyticsStyles[`liveBadge_${managementDashboard.liveStatus}`]'));
  assert.ok(!sectionsSource.includes('usePublicLiveMeta'));

  assert.ok(clientSource.includes('toolbarLead?: ReactNode;'));
  assert.ok(clientSource.includes('input.toolbarLead ?'));

  assert.ok(stylesSource.includes('.toolbarGroupLead'));
  assert.ok(stylesSource.includes('.toolbarGroupMetrics'));
  assert.ok(sectionsSource.includes('view={ownerView}'));
  assert.ok(sectionsSource.includes('function readOwnerViewFromHash(hash: string): OwnerView {'));
  assert.ok(sectionsSource.includes("return hash === '#management' ? 'management' : 'analytics';"));
  assert.ok(sectionsSource.includes('function ownerViewHref(view: OwnerView): string {'));
  assert.ok(sectionsSource.includes("window.addEventListener('hashchange', handleHashChange);"));
  assert.ok(sectionsSource.includes("href={ownerViewHref('management')}"));
  assert.ok(sectionsSource.includes('role="button"'));
});

test('org-scoped token creds table adds a viewer-owned remove column outside the innies route', () => {
  const sectionsSource = readSource('src/components/org/OrgDashboardSections.tsx');
  const clientSource = readSource('src/app/analytics/AnalyticsDashboardClient.tsx');
  const tablesSource = readSource('src/components/analytics/AnalyticsTables.tsx');

  assert.ok(sectionsSource.includes("tokenRowRemoveConfig={orgSlug === 'innies'"));
  assert.ok(sectionsSource.includes('createdByGithubLoginByTokenId: Object.fromEntries('));
  assert.ok(sectionsSource.includes('viewerGithubLogin: data.membership.githubLogin'));

  assert.ok(clientSource.includes('tokenRowRemoveConfig?: TokenRowRemoveConfig;'));
  assert.ok(clientSource.includes('tokenRowRemoveConfig={input.tokenRowRemoveConfig}'));

  assert.ok(tablesSource.includes('export type TokenRowRemoveConfig = {'));
  assert.ok(tablesSource.includes('createdByGithubLoginByTokenId: Record<string, string | null>;'));
  assert.ok(tablesSource.includes('viewerGithubLogin: string | null;'));
  assert.ok(tablesSource.includes('tokenRowRemoveConfig ? <th className={styles.numeric}>REMOVE</th> : null'));
  assert.ok(tablesSource.includes('{tokenRowRemoveConfig ? ('));
  assert.ok(tablesSource.includes('<td className={styles.numeric}>'));
  assert.ok(tablesSource.includes('const tokenCreatorLogin = tokenRowRemoveConfig.createdByGithubLoginByTokenId[row.credentialId] ?? null;'));
  assert.ok(tablesSource.includes('const canRemove = tokenCreatorLogin !== null && tokenCreatorLogin === tokenRowRemoveConfig.viewerGithubLogin;'));
  assert.ok(tablesSource.includes('/api/orgs/${tokenRowRemoveConfig.orgSlug}/tokens/${row.credentialId}/remove'));
  assert.ok(tablesSource.includes('[remove]'));
  assert.ok(tablesSource.includes(': \'--\''));
});
