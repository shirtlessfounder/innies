import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AdminWithdrawalReviewSection,
  ConnectedAccountsSection,
  DashboardPage,
  EarningsSection,
  RequestExplanationSection,
  RequestHistorySection,
  WalletSection,
} from '../../../../../components/pilot/DashboardSections';
import { getAdminPilotAccountView } from '../../../../../lib/pilot/server';
import { formatCount, formatUsdMinor } from '../../../../../lib/pilot/present';

export const dynamic = 'force-dynamic';

export default async function AdminPilotAccountPage(input: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await input.params;
  const searchParams = input.searchParams ? await input.searchParams : {};
  const explain = Array.isArray(searchParams.explain) ? searchParams.explain[0] : searchParams.explain;
  const view = await getAdminPilotAccountView({
    orgId: params.orgId,
    explainRequestId: explain ?? null
  });

  if (!view) notFound();

  return (
    <DashboardPage
      eyebrow="Admin Account View"
      title={view.identity.displayName || view.identity.userEmail}
      lede="Admin account-view page for Darryn context, with request explanation, routing attribution, wallet history, connected accounts, earnings, and withdrawal review."
      actions={(
        <>
          <Link href="/admin/pilot">Back to identities</Link>
          <form action="/api/admin/pilot/impersonate" method="post">
            <input name="targetUserId" type="hidden" value={view.identity.targetUserId} />
            <input name="targetOrgId" type="hidden" value={view.identity.targetOrgId} />
            <input name="targetOrgSlug" type="hidden" value={view.identity.targetOrgSlug || ''} />
            <input name="targetOrgName" type="hidden" value={view.identity.targetOrgName || ''} />
            <input name="githubLogin" type="hidden" value={view.identity.githubLogin || ''} />
            <input name="userEmail" type="hidden" value={view.identity.userEmail} />
            <button type="submit">Impersonate</button>
          </form>
        </>
      )}
      stats={[
        { label: 'Wallet', value: formatUsdMinor(view.wallet.balanceMinor) },
        { label: 'Requests', value: formatCount(view.requests.length) },
        { label: 'Withdrawals', value: formatCount(view.withdrawals.length) },
        { label: 'Accounts', value: formatCount(view.accounts.length) },
      ]}
      sections={(
        <>
          <WalletSection ledger={view.walletLedger} wallet={view.wallet} />
          <RequestHistorySection
            adminBasePath={`/admin/pilot/accounts/${encodeURIComponent(view.identity.targetOrgId)}`}
            orgId={view.identity.targetOrgId}
            requests={view.requests}
          />
          <RequestExplanationSection request={view.requestExplanation} />
          <ConnectedAccountsSection accounts={view.accounts} editable={false} returnTo={`/admin/pilot/accounts/${encodeURIComponent(view.identity.targetOrgId)}`} />
          <EarningsSection history={view.earningsHistory} summary={view.earningsSummary} />
          <AdminWithdrawalReviewSection
            returnTo={`/admin/pilot/accounts/${encodeURIComponent(view.identity.targetOrgId)}`}
            withdrawals={view.withdrawals}
          />
        </>
      )}
    />
  );
}
