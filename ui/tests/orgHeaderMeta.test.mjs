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

test('org session/header plumbing exposes all active org links instead of a single chosen org slug', () => {
  const typesSource = readSource('src/lib/org/types.ts');
  const serverSource = readSource('src/lib/org/server.ts');
  const headerSource = readSource('src/components/LandingHeroHeader.tsx');
  const rootPageSource = readSource('src/app/page.tsx');
  const onboardPageSource = readSource('src/app/onboard/page.tsx');
  const orgPageSource = readSource('src/app/[orgSlug]/page.tsx');
  const inniesPageSource = readSource('src/app/innies/page.tsx');
  const dashboardSource = readSource('src/components/org/OrgDashboardSections.tsx');

  assert.ok(typesSource.includes('activeOrgs'));
  assert.ok(serverSource.includes('/v1/org/session'));
  assert.ok(serverSource.includes('activeOrgs'));
  assert.ok(serverSource.includes('githubLogin'));

  assert.ok(headerSource.includes('ORGS:'));
  assert.ok(headerSource.includes('activeOrgs'));
  assert.ok(headerSource.includes("index > 0 ? ', ' : ''"));
  assert.ok(headerSource.includes('AUTH:'));
  assert.ok(headerSource.includes('; ORGS:'));
  assert.ok(headerSource.includes('[CLICK TO LOG IN WITH GITHUB]'));
  assert.ok(headerSource.includes('authGithubLogin'));
  assert.ok(headerSource.includes('authStartUrl'));
  assert.match(
    headerSource,
    /<div className=\{styles\.liveMeta\}>[\s\S]*AUTH:[\s\S]*; ORGS:/
  );
  assert.ok(headerSource.indexOf('AUTH:') < headerSource.indexOf('; ORGS:'));
  assert.ok(headerSource.indexOf('<div className={styles.liveMeta}>') < headerSource.indexOf('; ORGS:'));

  assert.ok(rootPageSource.includes('activeOrgs={landing.activeOrgs}'));
  assert.ok(rootPageSource.includes('authGithubLogin={landing.authGithubLogin}'));
  assert.ok(rootPageSource.includes('authStartUrl={landing.authStartUrl}'));
  assert.ok(onboardPageSource.includes('activeOrgs={landing.activeOrgs}'));
  assert.ok(onboardPageSource.includes('authGithubLogin={landing.authGithubLogin}'));
  assert.ok(onboardPageSource.includes("authStartUrl={buildOrgAuthStartUrl('/onboard')}"));
  assert.ok(orgPageSource.includes('activeOrgs={headerMeta.activeOrgs}'));
  assert.ok(orgPageSource.includes('authGithubLogin={headerMeta.authGithubLogin}'));
  assert.ok(inniesPageSource.includes('activeOrgs={headerMeta.activeOrgs}'));

  assert.ok(dashboardSource.includes('activeOrgs'));
  assert.ok(dashboardSource.includes('ORGS:'));
  assert.ok(dashboardSource.includes('; ORGS:'));
  assert.ok(dashboardSource.includes("index > 0 ? ', ' : ''"));
  assert.match(
    dashboardSource,
    /<div className=\{analyticsStyles\.liveMeta\}>[\s\S]*AUTH:[\s\S]*; ORGS:/
  );
  assert.ok(dashboardSource.indexOf('AUTH:') < dashboardSource.indexOf('; ORGS:'));
  assert.ok(dashboardSource.indexOf('<div className={analyticsStyles.liveMeta}>') < dashboardSource.indexOf('; ORGS:'));
});
