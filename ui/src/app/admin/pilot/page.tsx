import { DashboardPage, PilotIdentityListSection } from '../../../components/pilot/DashboardSections';
import { listAdminPilotIdentities } from '../../../lib/pilot/server';
import { formatCount } from '../../../lib/pilot/present';

export const dynamic = 'force-dynamic';

export default async function AdminPilotPage() {
  const identities = await listAdminPilotIdentities();

  return (
    <DashboardPage
      eyebrow="Admin Pilot"
      title="Pilot identity discovery"
      lede="Admin entry for Darryn context, account-view navigation, and one-click impersonation into the pilot dashboard."
      stats={[
        { label: 'Pilot Identities', value: formatCount(identities.length) },
        { label: 'Impersonate', value: 'Ready' },
        { label: 'Account Views', value: formatCount(identities.length) },
        { label: 'Mode', value: 'Admin' },
      ]}
      sections={<PilotIdentityListSection identities={identities} />}
    />
  );
}
