import { LandingHeroHeader } from '../../components/LandingHeroHeader';
import { OnboardingPaneCarousel } from './OnboardingPaneCarousel';
import { loadOnboardingPanes } from './paneData';
import landingStyles from '../page.module.css';
import styles from './page.module.css';

export default async function OnboardPage() {
  const panes = await loadOnboardingPanes();

  return (
    <main className={landingStyles.page}>
      <div className={landingStyles.shell}>
        <div className={landingStyles.console}>
          <LandingHeroHeader
            promptMode="analytics"
            title="innies onboarding"
            analyticsPromptLabel="message"
            analyticsPromptLinkLabel="@shirtlessfounder"
            analyticsPromptLinkHref="https://t.me/shirtlessfounder"
            analyticsPromptSuffix="on telegram with your oauth tokens to onboard"
          />

          <section className={styles.workspaceSection}>
            <OnboardingPaneCarousel panes={panes} />
          </section>
        </div>
      </div>
    </main>
  );
}
