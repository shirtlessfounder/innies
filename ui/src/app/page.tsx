import Image from 'next/image';
import Link from 'next/link';
import { LandingHeroHeader } from '../components/LandingHeroHeader';
import { shouldShowAnalyticsIndexLink } from '../lib/analyticsAccess';
import styles from './page.module.css';

export default function DashboardIndexPage() {
  const showAnalyticsLink = shouldShowAnalyticsIndexLink();
  const heroFrame = (
    <div className={styles.heroArtwork}>
      <Image
        className={styles.heroImage}
        src="/images/archive-computer.png"
        alt="Winter lake landscape on archival computer"
        width={2359}
        height={1778}
        priority
      />
      <Image
        className={styles.heroBadge}
        src="/images/innies-eye-logo-green-square.svg"
        alt=""
        aria-hidden="true"
        width={320}
        height={320}
        priority
      />
    </div>
  );

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.console}>
          <LandingHeroHeader />

          <section className={styles.hero}>
            <div className={styles.heroInner}>
              {showAnalyticsLink ? (
                <a href="/analytics" className={styles.frame} aria-label="Open analytics">
                  {heroFrame}
                </a>
              ) : (
                <div className={styles.frame} aria-hidden="true">
                  {heroFrame}
                </div>
              )}

              <Link href="/onboard" className={styles.primaryCta}>
                <span>ONBOARD YOUR INNIES</span>
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
