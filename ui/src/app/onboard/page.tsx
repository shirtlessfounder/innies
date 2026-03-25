import { LandingHeroHeader } from '../../components/LandingHeroHeader';
import { buildOrgAuthStartUrl, getOrgLandingState } from '../../lib/org/server';
import { OnboardingPaneCarousel } from './OnboardingPaneCarousel';
import { loadOnboardingPanes } from './paneData';
import landingStyles from '../page.module.css';
import styles from './page.module.css';

export default async function OnboardPage() {
  const landing = await getOrgLandingState();
  const panes = await loadOnboardingPanes();

  return (
    <main className={landingStyles.page}>
      <div className={landingStyles.shell}>
        <div className={landingStyles.console}>
          <LandingHeroHeader
            activeOrgs={landing.activeOrgs}
            authGithubLogin={landing.authGithubLogin}
            authStartUrl={buildOrgAuthStartUrl('/onboard')}
            promptMode="analytics"
            title="innies onboarding"
            analyticsPromptLabel="message"
            analyticsPromptLinkLabel="@shirtlessfounder"
            analyticsPromptLinkHref="https://t.me/shirtlessfounder"
            analyticsPromptSecondaryLinkLabel="@innies_hq"
            analyticsPromptSecondaryLinkHref="https://t.me/innies_hq"
            analyticsPromptSuffix="if you have questions"
          />

          <section className={styles.workspaceSection}>
            <OnboardingPaneCarousel panes={panes} />
          </section>
        </div>
      </div>
    </main>
  );
}
