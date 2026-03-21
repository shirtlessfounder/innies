import {
  ConnectedAccountsSection,
  DashboardPage,
  EarningsSection,
  PilotWithdrawalsSection,
  RequestHistorySection,
  WalletSection,
} from '../../components/pilot/DashboardSections';
import { buildPilotAuthStartUrl, getPilotDashboardData } from '../../lib/pilot/server';
import { formatCount, formatUsdMinor } from '../../lib/pilot/present';

export const dynamic = 'force-dynamic';

export default async function PilotPage() {
  const dashboard = await getPilotDashboardData();

  if (!dashboard) {
    return (
      <DashboardPage
        eyebrow="Pilot Dashboard"
        title="Darryn dashboard access"
        lede="Sign in with the allowlisted pilot GitHub account to see wallet movement, request routing, connected accounts, reserve floors, earnings, and withdrawals."
        actions={<a href={buildPilotAuthStartUrl('/pilot')}>Sign in with GitHub</a>}
        stats={[
          { label: 'Wallet', value: '--' },
          { label: 'Requests', value: '--' },
          { label: 'Withdrawable', value: '--' },
          { label: 'Accounts', value: '--' },
        ]}
        sections={null}
      />
    );
  }

  return (
    <DashboardPage
      eyebrow={dashboard.session.sessionKind === 'admin_impersonation' ? 'Admin Impersonation' : 'Pilot Dashboard'}
      title={dashboard.session.githubLogin ? `${dashboard.session.githubLogin} · Phase 2 dashboard` : 'Phase 2 dashboard'}
      lede="One coherent dashboard for wallet balance, post-cutover request history, connected accounts, Reserve Floors, earnings, and withdrawals."
      actions={(
        <form action="/api/pilot/session/logout" method="post">
          <button type="submit">Log out</button>
        </form>
      )}
      stats={[
        { label: 'Wallet', value: formatUsdMinor(dashboard.wallet.balanceMinor) },
        { label: 'Requests', value: formatCount(dashboard.requests.length) },
        { label: 'Withdrawable', value: formatUsdMinor(dashboard.earningsSummary.withdrawableMinor) },
        { label: 'Accounts', value: formatCount(dashboard.accounts.length) },
      ]}
      sections={(
        <>
          <WalletSection ledger={dashboard.walletLedger} wallet={dashboard.wallet} />
          <RequestHistorySection orgId={dashboard.session.effectiveOrgId} requests={dashboard.requests} />
          <ConnectedAccountsSection accounts={dashboard.accounts} editable returnTo="/pilot" />
          <EarningsSection history={dashboard.earningsHistory} summary={dashboard.earningsSummary} />
          <PilotWithdrawalsSection returnTo="/pilot" withdrawals={dashboard.withdrawals} />
        </>
      )}
    />
  );
}
