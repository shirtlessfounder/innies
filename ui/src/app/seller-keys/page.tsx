import { ShellCard } from '../../components/ShellCard';
import { getSellerKeySummaries } from '../../lib/mockAdapters';

export default async function SellerKeysPage() {
  const keys = await getSellerKeySummaries();

  return (
    <main style={{ maxWidth: 960, margin: '40px auto', fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1>Seller Keys</h1>
      <ShellCard title="Contributed Keys">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Key ID</th>
              <th align="left">Provider</th>
              <th align="left">Status</th>
              <th align="right">Used / Cap</th>
              <th align="left">Last Health</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.id}</td>
                <td>{key.provider}</td>
                <td>{key.status}</td>
                <td align="right">
                  {key.usedUnits.toLocaleString()} / {key.capUnits.toLocaleString()}
                </td>
                <td>{new Date(key.lastHealthAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ShellCard>
    </main>
  );
}
