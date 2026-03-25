import Image from 'next/image';
import { LandingHeroHeader } from '../components/LandingHeroHeader';
import { OrgCreationForm } from '../components/org/OrgCreationForm';
import { readPendingOrgName } from '../lib/org/landing';
import { getOrgLandingState } from '../lib/org/server';
import styles from './page.module.css';

export default async function DashboardIndexPage(input: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = input.searchParams ? await input.searchParams : {};
  const pendingOrgName = readPendingOrgName(searchParams);
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
      <div className={styles.heroBadgeCluster} aria-hidden="true">
        <Image
          className={styles.heroBadge}
          src="/images/innies-eye-logo-green-square.svg"
          alt=""
          width={320}
          height={320}
          priority
        />
        <div className={styles.heroPreviewLabel}>Click to preview</div>
      </div>
    </div>
  );

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.console}>
          <LandingHeroHeader
            activeOrgs={landing.activeOrgs}
            authGithubLogin={landing.authGithubLogin}
            authStartUrl={landing.authStartUrl}
            brandSuffix="(BETA)"
          />

          <section className={styles.hero}>
            <div className={styles.heroInner}>
              <a href="/innies" className={styles.frame} aria-label="Open innies dashboard">
                {heroFrame}
              </a>

              <OrgCreationForm
                authStartUrl={landing.authStartUrl}
                footerLinkClassName={styles.footerLink}
                footerLinkRowClassName={styles.footerLinkRow}
                footerLinks={[
                  { href: '/onboard', label: '[guides]' },
                  { external: true, href: 'https://t.me/innies_hq', label: '[telegram]' },
                  { external: true, href: 'https://x.com/innies_computer', label: '[twitter]' },
                  { external: true, href: 'https://github.com/shirtlessfounder/innies', label: '[github]' },
                ]}
                formClassName={styles.heroForm}
                initialOrgName={pendingOrgName}
                inputClassName={styles.heroInput}
                signedIn={landing.signedIn}
                submitClassName={styles.primaryCta}
              />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
