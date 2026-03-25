import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');

function readSource(relativePath) {
  return readFileSync(join(uiRoot, relativePath), 'utf8');
}

async function importUiModule(relativePath) {
  const target = pathToFileURL(join(uiRoot, relativePath)).href;
  return import(`${target}?t=${Date.now()}-${Math.random()}`);
}

test('landing org auth helpers preserve pending org creation across oauth return', async () => {
  const {
    buildLandingOrgCreateReturnTo,
    buildOrgCreationAuthStartUrl,
    readPendingOrgName,
  } = await importUiModule('src/lib/org/landing.ts');

  assert.equal(buildLandingOrgCreateReturnTo('  Acme Research  '), '/?createOrg=Acme+Research');
  assert.equal(buildLandingOrgCreateReturnTo(''), '/');
  assert.equal(readPendingOrgName({ createOrg: 'me-and-the-boys' }), 'me-and-the-boys');
  assert.equal(readPendingOrgName({ createOrg: ['acme', 'other'] }), 'acme');
  assert.equal(
    buildOrgCreationAuthStartUrl(
      'https://api.innies.test/v1/org/auth/github/start?returnTo=%2F',
      'Acme Research',
    ),
    'https://api.innies.test/v1/org/auth/github/start?returnTo=%2F%3FcreateOrg%3DAcme%2BResearch',
  );
});

test('landing source always renders org creation form and resumes through validated auth state', () => {
  const pageSource = readSource('src/app/page.tsx');
  const onboardSource = readSource('src/app/onboard/page.tsx');
  const formSource = readSource('src/components/org/OrgCreationForm.tsx');
  const headerSource = readSource('src/components/LandingHeroHeader.tsx');
  const serverSource = readSource('src/lib/org/server.ts');
  const stylesSource = readSource('src/app/page.module.css');

  assert.ok(pageSource.includes('searchParams?: Promise<Record<string, string | string[] | undefined>>;'));
  assert.ok(pageSource.includes('const pendingOrgName = readPendingOrgName(searchParams);'));
  assert.ok(pageSource.includes('<OrgCreationForm'));
  assert.ok(pageSource.includes('authStartUrl={landing.authStartUrl}'));
  assert.ok(pageSource.includes('className={styles.heroPreviewLabel}'));
  assert.ok(pageSource.includes('className={styles.heroBadgeCluster}'));
  assert.ok(pageSource.includes('footerLinkClassName={styles.footerLink}'));
  assert.ok(pageSource.includes('footerLinkRowClassName={styles.footerLinkRow}'));
  assert.ok(pageSource.includes("footerLinks={["));
  assert.ok(pageSource.includes("label: '[guides]'"));
  assert.ok(pageSource.includes("href: '/onboard'"));
  assert.ok(pageSource.includes("label: '[telegram]'"));
  assert.ok(pageSource.includes("href: 'https://t.me/innies_hq'"));
  assert.ok(pageSource.includes("label: '[twitter]'"));
  assert.ok(pageSource.includes("href: 'https://x.com/innies_computer'"));
  assert.ok(pageSource.includes("label: '[github]'"));
  assert.ok(pageSource.includes("href: 'https://github.com/shirtlessfounder/innies'"));
  assert.ok(!pageSource.includes('Sign in with GitHub'));
  assert.ok(onboardSource.includes("authStartUrl={buildOrgAuthStartUrl('/onboard')}"));
  assert.ok(onboardSource.includes('analyticsPromptLinkLabel="@shirtlessfounder"'));
  assert.ok(onboardSource.includes('analyticsPromptSecondaryLinkLabel="@innies_hq"'));
  assert.ok(onboardSource.includes('analyticsPromptSecondaryLinkHref="https://t.me/innies_hq"'));
  assert.ok(onboardSource.includes('analyticsPromptSuffix="if you have questions"'));
  assert.ok(!onboardSource.includes('on telegram with your oauth tokens to onboard'));
  assert.ok(headerSource.includes('analyticsPromptSecondaryLinkLabel?: string;'));
  assert.ok(headerSource.includes('analyticsPromptSecondaryLinkHref?: string;'));
  assert.ok(headerSource.includes('authStartUrl?: string | null;'));
  assert.ok(headerSource.includes('[CLICK TO LOG IN WITH GITHUB]'));

  assert.ok(formSource.includes('signedIn: boolean;'));
  assert.ok(formSource.includes('authStartUrl: string;'));
  assert.ok(formSource.includes('footerLinks?: Array<{'));
  assert.ok(formSource.includes('external?: boolean;'));
  assert.ok(formSource.includes('footerLinkRowClassName?: string;'));
  assert.ok(formSource.includes('footerLinkClassName?: string;'));
  assert.ok(formSource.includes('initialOrgName?: string;'));
  assert.ok(formSource.includes('input.footerLinks?.length'));
  assert.ok(formSource.includes('input.footerLinks.map((link) => ('));
  assert.ok(formSource.includes("link.external ? ("));
  assert.ok(formSource.includes('href={link.href}'));
  assert.ok(formSource.includes('{link.label}'));
  assert.ok(formSource.includes('window.location.assign(buildOrgCreationAuthStartUrl(input.authStartUrl, orgName));'));
  assert.ok(formSource.includes('window.history.replaceState({}, \'\', buildLandingOrgCreateReturnTo(\'\'));'));

  assert.ok(serverSource.includes('const session = cookieStore.has(ORG_SESSION_COOKIE_NAME)'));
  assert.ok(serverSource.includes('signedIn: Boolean(session)'));

  assert.ok(stylesSource.includes('width: min(40vw, 500px);'));
  assert.ok(stylesSource.includes('.heroForm'));
  assert.ok(stylesSource.includes('width: 100%;'));
  assert.ok(stylesSource.includes('border-radius: 14px;'));
  assert.ok(stylesSource.includes('.heroBadgeCluster'));
  assert.ok(stylesSource.includes('.footerLinkRow'));
  assert.ok(stylesSource.includes('.footerLink'));
  assert.ok(stylesSource.includes('gap: clamp(0.67px, 0.17vw, 2px);'));
  assert.ok(stylesSource.includes('transform: translate(-50%, calc(-50% - (var(--hero-badge-width) * 0.12)));'));
  assert.ok(stylesSource.includes('margin-top: calc(var(--hero-badge-width) * -0.31);'));
  assert.ok(stylesSource.includes('font-weight: 900;'));
  assert.match(stylesSource, /\.heroPreviewLabel\s*\{[\s\S]*filter: saturate\(0\.48\) brightness\(0\.9\);/);
  assert.ok(!stylesSource.includes('top: calc(50% +'));
});
