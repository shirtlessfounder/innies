import { notFound } from 'next/navigation';
import { InviteAcceptanceCard } from '../../components/org/InviteAcceptanceCard';
import { OrgDashboardSections } from '../../components/org/OrgDashboardSections';
import styles from '../../components/org/orgDashboard.module.css';
import { getOrgPageState } from '../../lib/org/server';

export const dynamic = 'force-dynamic';

function OrgStatePage(input: {
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

export default async function OrgSlugPage(input: {
  params: Promise<{ orgSlug: string }>;
}) {
  const params = await input.params;
  const state = await getOrgPageState(params.orgSlug);

  if (state.kind === 'not_found') {
    notFound();
  }

  if (state.kind === 'sign_in') {
    return (
      <OrgStatePage
        actions={<a className={styles.actionButton} href={state.authStartUrl}>Sign in with GitHub</a>}
        eyebrow={state.org.slug}
        lede="This org route requires the GitHub web session. Continue through the backend auth start URL so the return target survives unchanged."
        title={state.org.name}
      />
    );
  }

  if (state.kind === 'not_invited') {
    return (
      <OrgStatePage
        eyebrow={state.org.slug}
        lede="You are signed in, but this GitHub account does not have an active invite or membership for this org."
        title="You are not invited to this org"
      />
    );
  }

  if (state.kind === 'invite') {
    return (
      <OrgStatePage
        eyebrow={state.invite.org.slug}
        lede="A pending org invite matches the current GitHub login. Accept it here to activate membership and provision the org buyer key."
        title={state.invite.org.name}
      >
        <InviteAcceptanceCard
          githubLogin={state.invite.githubLogin}
          orgName={state.invite.org.name}
          orgSlug={state.invite.org.slug}
        />
      </OrgStatePage>
    );
  }

  if (state.kind === 'reveal') {
    const orgSlug = state.reveal.org.slug;
    const reasonLabel = state.reveal.reason === 'org_created'
      ? 'Org created'
      : state.reveal.reason === 'invite_accepted'
        ? 'Invite accepted'
        : 'Buyer key reveal';
    return (
      <OrgStatePage
        eyebrow={reasonLabel}
        lede="This buyer key is shown exactly once after org creation or invite acceptance. Dismiss the reveal to return to the normal dashboard."
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
            <form action={`/api/orgs/${orgSlug}/reveal/dismiss`} method="post">
              <button className={styles.actionButton} type="submit">Dismiss reveal</button>
            </form>
          </div>
        </section>
      </OrgStatePage>
    );
  }

  return <OrgDashboardSections data={state.data} />;
}
