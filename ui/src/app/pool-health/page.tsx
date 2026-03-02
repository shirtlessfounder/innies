import { ShellCard } from '../../components/ShellCard';
import { getPoolHealthSummary } from '../../lib/mockAdapters';

export default async function PoolHealthPage() {
  const health = await getPoolHealthSummary();

  return (
    <main style={{ maxWidth: 960, margin: '40px auto', fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1>Pool Health</h1>
      <ShellCard title="Live Capacity Health">
        <p>Active keys: {health.activeKeys}</p>
        <p>Quarantined keys: {health.quarantinedKeys}</p>
        <p>In-flight requests: {health.inFlightRequests}</p>
        <p>Failure rate: {health.failureRatePct.toFixed(2)}%</p>
      </ShellCard>
    </main>
  );
}
