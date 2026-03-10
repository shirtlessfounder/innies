import { AnalyticsDashboardClient } from './AnalyticsDashboardClient';
import styles from './page.module.css';

export default function AnalyticsPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <AnalyticsDashboardClient />
      </div>
    </main>
  );
}
