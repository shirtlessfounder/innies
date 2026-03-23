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

function readFunctionBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? source.length : end);
}

test('pilot dashboard server fetchers use pilot/admin dashboard contracts instead of global token analytics', () => {
  const source = readSource('src/lib/pilot/server.ts');
  const pilotDashboardSource = readFunctionBlock(
    source,
    'export async function getPilotDashboardData',
    'export async function getAdminPilotAccountView'
  );

  assert.ok(source.includes('/v1/pilot/session'));
  assert.ok(source.includes('/v1/pilot/wallet'));
  assert.ok(source.includes('/v1/pilot/wallet/ledger'));
  assert.ok(source.includes('/v1/pilot/connected-accounts'));
  assert.ok(pilotDashboardSource.includes('/v1/pilot/requests'));
  assert.ok(source.includes('/v1/pilot/earnings/summary'));
  assert.ok(source.includes('/v1/pilot/earnings/history'));
  assert.ok(source.includes('/v1/pilot/withdrawals'));
  assert.ok(!pilotDashboardSource.includes('/v1/admin/requests'));
  assert.ok(source.includes('/v1/admin/pilot/connected-accounts'));
  assert.ok(source.includes('/v1/admin/pilot/identities'));
  assert.ok(source.includes('/v1/admin/requests'));
  assert.ok(source.includes('/v1/admin/requests/:requestId/explanation'.replace(':requestId', '${requestId}')) === false);
  assert.ok(!source.includes('/v1/admin/analytics/tokens'));
  assert.ok(!source.includes('/v1/admin/analytics/dashboard'));
});

test('pilot page includes the required Darryn dashboard sections', () => {
  const pageSource = readSource('src/app/pilot/page.tsx');
  const sharedSource = readSource('src/components/pilot/DashboardSections.tsx');

  assert.ok(pageSource.includes('ConnectedAccountsSection'));
  assert.ok(pageSource.includes('RequestHistorySection'));
  assert.ok(pageSource.includes('PilotWithdrawalsSection'));
  assert.ok(sharedSource.includes('Wallet'));
  assert.ok(sharedSource.includes('Request History'));
  assert.ok(sharedSource.includes('Connected Accounts'));
  assert.ok(sharedSource.includes('Reserve Floors'));
  assert.ok(sharedSource.includes('Earnings'));
  assert.ok(sharedSource.includes('Withdrawals'));
});

test('manual top-up form renders and forwards a stable idempotency key', () => {
  const sharedSource = readSource('src/components/pilot/DashboardSections.tsx');
  const routeSource = readSource('src/app/api/pilot/payments/top-up/route.ts');
  const serverSource = readSource('src/lib/pilot/server.ts');

  assert.ok(sharedSource.includes('randomUUID') || sharedSource.includes('randomBytes'));
  assert.ok(sharedSource.includes('manualTopUpIdempotencyKey'));
  assert.ok(sharedSource.includes('name="idempotencyKey"'));
  assert.ok(routeSource.includes("readFormString(formData, 'idempotencyKey')"));
  assert.ok(routeSource.includes("'idempotency-key': idempotencyKey"));
  assert.ok(serverSource.includes('headers?: Record<string, string>'));
  assert.ok(serverSource.includes('...(input.headers ?? {})'));
});

test('payment redirect routes sanitize returnTo before redirecting', async () => {
  const { normalizePilotReturnTo } = await import('../src/lib/pilot/returnTo.ts');
  const removeRouteSource = readSource('src/app/api/pilot/payments/remove/route.ts');
  const autoRechargeRouteSource = readSource('src/app/api/pilot/payments/auto-recharge/route.ts');

  assert.equal(normalizePilotReturnTo(' /pilot?tab=funding '), '/pilot?tab=funding');
  assert.equal(normalizePilotReturnTo('//attacker.example'), null);
  assert.equal(normalizePilotReturnTo('/\\attacker.example'), null);
  assert.equal(normalizePilotReturnTo('https://attacker.example/pilot'), null);
  assert.ok(removeRouteSource.includes('normalizePilotReturnTo'));
  assert.ok(autoRechargeRouteSource.includes('normalizePilotReturnTo'));
});

test('pilot auth cookie helpers derive a shared parent domain for api/ui siblings', async () => {
  const { resolvePilotSessionCookieDomain } = await import('../src/lib/pilot/sessionCookie.ts');
  const impersonateRouteSource = readSource('src/app/api/admin/pilot/impersonate/route.ts');
  const logoutRouteSource = readSource('src/app/api/pilot/session/logout/route.ts');

  assert.equal(
    resolvePilotSessionCookieDomain('https://www.innies.computer/pilot', 'https://api.innies.computer'),
    'innies.computer'
  );
  assert.equal(
    resolvePilotSessionCookieDomain('http://localhost:3000/pilot', 'http://localhost:4010'),
    null
  );
  assert.ok(impersonateRouteSource.includes('pilotSessionCookieOptions'));
  assert.ok(logoutRouteSource.includes('pilotSessionCookieOptions'));
});

test('payment POST routes use 303 redirects after successful submission', () => {
  const setupRouteSource = readSource('src/app/api/pilot/payments/setup/route.ts');
  const topUpRouteSource = readSource('src/app/api/pilot/payments/top-up/route.ts');
  const removeRouteSource = readSource('src/app/api/pilot/payments/remove/route.ts');
  const autoRechargeRouteSource = readSource('src/app/api/pilot/payments/auto-recharge/route.ts');

  assert.ok(setupRouteSource.includes('status: 303'));
  assert.ok(topUpRouteSource.includes('status: 303'));
  assert.ok(removeRouteSource.includes('status: 303'));
  assert.ok(autoRechargeRouteSource.includes('status: 303'));
});

test('admin pilot entry page includes identity discovery and impersonation entry UI', () => {
  const pageSource = readSource('src/app/admin/pilot/page.tsx');
  const sharedSource = readSource('src/components/pilot/DashboardSections.tsx');

  assert.ok(pageSource.includes('PilotIdentityListSection'));
  assert.ok(sharedSource.includes('Impersonate'));
  assert.ok(sharedSource.includes('/api/admin/pilot/impersonate'));
  assert.ok(sharedSource.includes('Pilot Identities'));
});

test('admin pilot account page includes request explanation and withdrawal review surfaces', () => {
  const pageSource = readSource('src/app/admin/pilot/accounts/[orgId]/page.tsx');
  const sharedSource = readSource('src/components/pilot/DashboardSections.tsx');

  assert.ok(pageSource.includes('RequestExplanationSection'));
  assert.ok(pageSource.includes('AdminWithdrawalReviewSection'));
  assert.ok(sharedSource.includes('Request Explanation'));
  assert.ok(sharedSource.includes('Withdrawal Review'));
  assert.ok(sharedSource.includes('Connected Accounts'));
});
