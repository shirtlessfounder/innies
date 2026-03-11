import Image from 'next/image';
import Link from 'next/link';
import { LandingHeroHeader } from '../components/LandingHeroHeader';
import { shouldShowAnalyticsIndexLink } from '../lib/analyticsAccess';
import styles from './page.module.css';

export default function DashboardIndexPage() {
  const showAnalyticsLink = shouldShowAnalyticsIndexLink();
  const heroFrame = (
    <Image
      className={styles.heroImage}
      src="/images/archive-computer.png"
      alt="Winter lake landscape on archival computer"
      width={2359}
      height={1778}
      priority
    />
  );

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.console}>
          <LandingHeroHeader />

          <section className={styles.hero}>
            <div className={styles.heroInner}>
              {showAnalyticsLink ? (
                <Link href="/analytics" className={styles.frame} aria-label="Open analytics">
                  {heroFrame}
                </Link>
              ) : (
                <div className={styles.frame} aria-hidden="true">
                  {heroFrame}
                </div>
              )}

              <Link href="/onboard" className={styles.primaryCta}>
                <span>ONBOARD YOUR INNIE</span>
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
