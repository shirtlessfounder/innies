import Image from 'next/image';
import { LandingHeroHeader } from '../components/LandingHeroHeader';
import { OrgCreationForm } from '../components/org/OrgCreationForm';
import { getOrgLandingState } from '../lib/org/server';
import styles from './page.module.css';

export default async function DashboardIndexPage() {
  const landing = await getOrgLandingState();

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
              <a href="/analytics" className={styles.frame} aria-label="Open analytics">
                {heroFrame}
              </a>

              {landing.signedIn ? (
                <OrgCreationForm submitClassName={styles.primaryCta} />
              ) : (
                <a href={landing.authStartUrl} className={styles.primaryCta}>
                  <span>Sign in with GitHub</span>
                </a>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
