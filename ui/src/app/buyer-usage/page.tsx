import { ShellCard } from '../../components/ShellCard';
import { getBuyerUsageSummary } from '../../lib/mockAdapters';

export default async function BuyerUsagePage() {
  const usage = await getBuyerUsageSummary();

  return (
    <main style={{ maxWidth: 960, margin: '40px auto', fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1>Buyer Usage</h1>
      <ShellCard title="Current Period Totals">
        <p>Period: {usage.period}</p>
        <p>Requests: {usage.requests.toLocaleString()}</p>
        <p>Usage Units: {usage.usageUnits.toLocaleString()}</p>
        <p>Retail Equivalent: ${(usage.retailEquivalentMinor / 100).toFixed(2)}</p>
      </ShellCard>
    </main>
  );
}
