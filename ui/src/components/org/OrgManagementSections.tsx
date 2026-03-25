'use client';

import type { OrgDashboardPageState } from '../../lib/org/types';
import analyticsStyles from '../../app/analytics/page.module.css';
import { OrgDashboardMembers } from './OrgDashboardMembers';
import { OrgDashboardTokens } from './OrgDashboardTokens';

export function OrgManagementSections(input: { data: OrgDashboardPageState }) {
  const { data } = input;

  return (
    <div className={analyticsStyles.tableGrid}>
      <OrgDashboardTokens
        membership={data.membership}
        org={data.org}
        tokenPermissions={data.tokenPermissions}
        tokens={data.tokens}
      />

      <OrgDashboardMembers
        members={data.members}
        membership={data.membership}
        org={data.org}
        pendingInvites={data.pendingInvites}
      />
    </div>
  );
}
