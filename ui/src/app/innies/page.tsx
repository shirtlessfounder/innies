import analyticsStyles from '../analytics/page.module.css';
import { AnalyticsDashboardClient } from '../analytics/AnalyticsDashboardClient';
import { buildOrgAuthStartUrl, getOrgHeaderMeta } from '../../lib/org/server';

export const dynamic = 'force-dynamic';

export default async function InniesPage() {
  const headerMeta = await getOrgHeaderMeta();

  return (
    <main className={analyticsStyles.page}>
      <div className={analyticsStyles.shell}>
        <AnalyticsDashboardClient
          activeOrgs={headerMeta.activeOrgs}
          authGithubLogin={headerMeta.authGithubLogin}
          authStartUrl={buildOrgAuthStartUrl('/innies')}
          dashboardPath="/api/innies/analytics/dashboard"
          orgSlug="innies"
          timeseriesPath="/api/innies/analytics/timeseries"
          title="monitor the innies"
        />
      </div>
    </main>
  );
}
