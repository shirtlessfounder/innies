import Link from 'next/link';
import { notFound } from 'next/navigation';
import analyticsStyles from '../analytics/page.module.css';
import { BuyerKeyRevealCopyButton } from '../../components/org/BuyerKeyRevealCopyButton';
import { BuyerKeyRevealPreferenceForm } from '../../components/org/BuyerKeyRevealPreferenceForm';
import { InviteAcceptanceCard } from '../../components/org/InviteAcceptanceCard';
import { OrgDashboardSections } from '../../components/org/OrgDashboardSections';
import { OrgModalShell } from '../../components/org/OrgModalShell';
import { getOrgHeaderMeta, getOrgPageState } from '../../lib/org/server';
import type { OrgHeaderOrg } from '../../lib/org/types';

export const dynamic = 'force-dynamic';

function OrgStateBackdrop(input: {
  orgSlug: string;
  authGithubLogin: string | null;
  activeOrgs: OrgHeaderOrg[];
}) {
  const authGithubLogin = input.authGithubLogin?.trim() || null;
  return (
    <div className={analyticsStyles.console} aria-hidden="true">
      <header className={analyticsStyles.consoleHeader}>
        <div className={analyticsStyles.headerBlock}>
          <div className={analyticsStyles.kicker}>
            <Link className={analyticsStyles.homeLink} href="/">
              INNIES.COMPUTER
            </Link>
            <span>{` / ${input.orgSlug.toUpperCase()}`}</span>
          </div>
          <h1 className={analyticsStyles.title}>{input.orgSlug}</h1>
        </div>
        <div className={analyticsStyles.liveMeta}>
          <span className={analyticsStyles.liveTextSecondary}>
            AUTH:{' '}
            {authGithubLogin ? (
              <a
                className={analyticsStyles.liveMetaLink}
                href={`https://github.com/${authGithubLogin}`}
                rel="noreferrer"
                target="_blank"
              >
                {authGithubLogin}
              </a>
            ) : (
              <span className={analyticsStyles.liveMetaMuted}>None</span>
            )}
            {input.activeOrgs.length > 0 ? (
              <>
                ; ORGS:{' '}
                {input.activeOrgs.map((org, index) => (
                  <span key={org.slug}>
                    {index > 0 ? ', ' : ''}
                    <Link className={analyticsStyles.liveMetaLink} href={`/${org.slug}`}>
                      {org.slug}
                    </Link>
                  </span>
                ))}
              </>
            ) : null}
          </span>
        </div>
      </header>
    </div>
  );
}

function OrgStateModalPage(input: {
  orgSlug: string;
  authGithubLogin: string | null;
  activeOrgs: OrgHeaderOrg[];
  eyebrow: string;
  title: string;
  lede?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <main className={analyticsStyles.page}>
      <div className={analyticsStyles.shell}>
        <OrgStateBackdrop
          activeOrgs={input.activeOrgs}
          authGithubLogin={input.authGithubLogin}
          orgSlug={input.orgSlug}
        />
        <OrgModalShell eyebrow={input.eyebrow} title={input.title}>
          {input.lede ? (
            <div className={analyticsStyles.noticeList}>
              <div className={analyticsStyles.noticeText}>{input.lede}</div>
            </div>
          ) : null}
          {input.children || input.actions ? (
            <div className={analyticsStyles.modalFormStack}>
              {input.children}
              {input.actions ? (
                <div className={analyticsStyles.managementActionRow}>{input.actions}</div>
              ) : null}
            </div>
          ) : null}
        </OrgModalShell>
      </div>
    </main>
  );
}

export default async function OrgSlugPage(input: {
  params: Promise<{ orgSlug: string }>;
}) {
  const params = await input.params;
  const [headerMeta, state] = await Promise.all([
    getOrgHeaderMeta({ orgSlug: params.orgSlug }),
    getOrgPageState(params.orgSlug)
  ]);

  if (state.kind === 'not_found') {
    notFound();
  }

  if (state.kind === 'sign_in') {
    return (
      <OrgStateModalPage
        activeOrgs={headerMeta.activeOrgs}
        authGithubLogin={headerMeta.authGithubLogin}
        actions={<a className={analyticsStyles.controlButton} href={state.authStartUrl}>Sign in with GitHub</a>}
        eyebrow="Sign in"
        orgSlug={state.org.slug}
        lede="You must be whitelisted to view this org route. Continue to verify your identity."
        title={state.org.name}
      />
    );
  }

  if (state.kind === 'not_invited') {
    return (
      <OrgStateModalPage
        activeOrgs={headerMeta.activeOrgs}
        authGithubLogin={headerMeta.authGithubLogin}
        eyebrow="Access blocked"
        orgSlug={state.org.slug}
        lede="You are signed in, but this GitHub account does not have an active invite or membership for this org."
        title="You are not invited to this org"
      />
    );
  }

  if (state.kind === 'invite') {
    return (
      <OrgStateModalPage
        activeOrgs={headerMeta.activeOrgs}
        authGithubLogin={headerMeta.authGithubLogin}
        eyebrow="Accept invite"
        orgSlug={state.invite.org.slug}
        title={state.invite.org.name}
      >
        <InviteAcceptanceCard
          githubLogin={state.invite.githubLogin}
          orgName={state.invite.org.name}
          orgSlug={state.invite.org.slug}
          variant="modal"
        />
      </OrgStateModalPage>
    );
  }

  if (state.kind === 'reveal') {
    const orgSlug = state.reveal.org.slug;
    return (
      <OrgStateModalPage
        activeOrgs={headerMeta.activeOrgs}
        authGithubLogin={headerMeta.authGithubLogin}
        eyebrow="Buyer key"
        orgSlug={state.reveal.org.slug}
        lede="This buyer key is shown exactly once after org creation or invite acceptance. Choose your OpenClaw Pref, copy the key, then lock it in to continue."
        title={state.reveal.org.name}
      >
        <div className={analyticsStyles.noticeText}>
            {state.reveal.reason} · {state.reveal.org.slug}
        </div>
        <div className={analyticsStyles.tableWrap}>
          <table className={analyticsStyles.table}>
            <tbody>
              <tr>
                <td>
                  <div className={analyticsStyles.revealKeyRow}>
                    <span className={analyticsStyles.revealKeyValue}>{state.reveal.buyerKey}</span>
                    <BuyerKeyRevealCopyButton buyerKey={state.reveal.buyerKey} />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <BuyerKeyRevealPreferenceForm orgSlug={orgSlug} />
      </OrgStateModalPage>
    );
  }

  return <OrgDashboardSections activeOrgs={headerMeta.activeOrgs} data={state.data} />;
}
