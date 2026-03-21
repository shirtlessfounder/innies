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
