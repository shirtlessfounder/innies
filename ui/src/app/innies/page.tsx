import { notFound } from 'next/navigation';
import { InviteAcceptanceCard } from '../../components/org/InviteAcceptanceCard';
import { OrgDashboardSections } from '../../components/org/OrgDashboardSections';
import styles from '../../components/org/orgDashboard.module.css';
import { getOrgPageState } from '../../lib/org/server';

export const dynamic = 'force-dynamic';

function InniesStatePage(input: {
  eyebrow: string;
  title: string;
  lede: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.heroTop}>
            <div>
              <div className={styles.eyebrow}>{input.eyebrow}</div>
              <h1 className={styles.title}>{input.title}</h1>
              <p className={styles.lede}>{input.lede}</p>
            </div>
            {input.actions ? <div className={styles.heroActions}>{input.actions}</div> : null}
          </div>
        </section>
        {input.children ? <div className={styles.grid}>{input.children}</div> : null}
      </div>
    </main>
  );
}

export default async function InniesPage() {
  const state = await getOrgPageState('innies');

  if (state.kind === 'not_found') {
    notFound();
  }

  if (state.kind === 'sign_in') {
    return (
      <InniesStatePage
        actions={<a className={styles.actionButton} href={state.authStartUrl}>Sign in with GitHub</a>}
        eyebrow="innies"
        lede="The internal org surface still uses the same route-scoped auth contract. Sign in first, then the org slug resolves to the active internal membership."
        title="Internal org access"
      />
    );
  }

  if (state.kind === 'not_invited') {
    return (
      <InniesStatePage
        eyebrow="innies"
        lede="The /innies route requires an active internal membership."
        title="Internal org membership required"
      />
    );
  }

  if (state.kind === 'invite') {
    return (
      <InniesStatePage
        eyebrow="innies"
        lede="An internal invite is pending for this GitHub login. Accept it to activate the membership."
        title={state.invite.org.name}
      >
        <InviteAcceptanceCard
          githubLogin={state.invite.githubLogin}
          orgName={state.invite.org.name}
          orgSlug={state.invite.org.slug}
        />
      </InniesStatePage>
    );
  }

  if (state.kind === 'reveal') {
    return (
      <InniesStatePage
        eyebrow={state.reveal.reason === 'org_created' ? 'Org created' : 'Invite accepted'}
        lede="Dismiss this one-time buyer-key reveal to return to the internal org dashboard."
        title={state.reveal.org.name}
      >
        <section className={styles.section}>
          <div className={styles.pillRow}>
            <span className={styles.goodPill}>{state.reveal.reason}</span>
            <span className={styles.pill}>{state.reveal.org.slug}</span>
          </div>
          <div className={styles.subsection}>
            <h2 className={styles.sectionTitle}>Buyer key</h2>
            <pre className={styles.emptyState}>{state.reveal.buyerKey}</pre>
          </div>
          <div className={styles.formActions}>
            <form action={`/api/orgs/${state.reveal.org.slug}/reveal/dismiss`} method="post">
              <button className={styles.actionButton} type="submit">Dismiss reveal</button>
            </form>
          </div>
        </section>
      </InniesStatePage>
    );
  }

  return <OrgDashboardSections data={state.data} />;
}
