'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import analyticsStyles from '../../app/analytics/page.module.css';
import { AnalyticsDashboardClient } from '../../app/analytics/AnalyticsDashboardClient';
import { useAnalyticsDashboard } from '../../hooks/useAnalyticsDashboard';
import { formatLocalTimeZoneAbbreviation, formatTimestamp } from '../../lib/analytics/present';
import type { OrgDashboardPageState, OrgHeaderOrg } from '../../lib/org/types';
import { OrgManagementSections } from './OrgManagementSections';
import { OrgDashboardToolbarActions } from './OrgDashboardToolbarActions';

type OwnerView = 'analytics' | 'management';

function readOwnerViewFromHash(hash: string): OwnerView {
  return hash === '#management' ? 'management' : 'analytics';
}

function ownerViewHref(view: OwnerView): string {
  return view === 'management' ? '#management' : '#analytics';
}

function OwnerViewToggle(input: {
  ownerView: OwnerView;
  onChange: (view: OwnerView) => void;
}) {
  return (
    <>
      <a
        aria-pressed={input.ownerView === 'analytics'}
        className={input.ownerView === 'analytics' ? analyticsStyles.windowButtonActive : analyticsStyles.windowButton}
        href={ownerViewHref('analytics')}
        onClick={(event) => {
          event.preventDefault();
          input.onChange('analytics');
        }}
        role="button"
      >
        ANALYTICS
      </a>
      <a
        aria-pressed={input.ownerView === 'management'}
        className={input.ownerView === 'management' ? analyticsStyles.windowButtonActive : analyticsStyles.windowButton}
        href={ownerViewHref('management')}
        onClick={(event) => {
          event.preventDefault();
          input.onChange('management');
        }}
        role="button"
      >
        MANAGEMENT
      </a>
    </>
  );
}

function OwnerManagementView(input: {
  data: OrgDashboardPageState;
  activeOrgs: OrgHeaderOrg[];
  ownerToggle: ReactNode;
  toolbarAction: ReactNode;
  dashboardTitle: string;
}) {
  const { activeOrgs, data, dashboardTitle, ownerToggle, toolbarAction } = input;
  const orgSlug = data.org.slug;
  const managementDashboard = useAnalyticsDashboard('24h', {
    dashboardPath: data.analyticsPaths.dashboardPath,
  });

  return (
    <main className={analyticsStyles.page}>
      <div className={analyticsStyles.shell}>
        <div className={analyticsStyles.console}>
          <header className={analyticsStyles.consoleHeader}>
            <div className={analyticsStyles.headerBlock}>
              <div className={analyticsStyles.kicker}>
                <Link className={analyticsStyles.homeLink} href="/">
                  INNIES.COMPUTER
                </Link>
                <span>{` / ${orgSlug.toUpperCase()}`}</span>
              </div>
              <h1 className={analyticsStyles.title}>{dashboardTitle}</h1>
              <div className={analyticsStyles.promptLine}>
                <span className={analyticsStyles.promptPrefix}>innies:~$</span>
                <span className={analyticsStyles.promptCommand}>
                  <span className={analyticsStyles.promptCommandText}>
                    {`manage org --slug ${orgSlug}`}
                    <span className={analyticsStyles.promptCursor} aria-hidden="true" />
                  </span>
                </span>
              </div>
            </div>

            <div className={analyticsStyles.liveMeta}>
              <span className={`${analyticsStyles.liveBadge} ${analyticsStyles[`liveBadge_${managementDashboard.liveStatus}`]}`}>
                <span className={analyticsStyles.liveDot} />
                {managementDashboard.liveStatus.toUpperCase()}
              </span>
              <span className={analyticsStyles.liveText}>
                LAST {formatTimestamp(managementDashboard.lastSuccessfulUpdateAt)} {formatLocalTimeZoneAbbreviation(managementDashboard.lastSuccessfulUpdateAt)}
              </span>
              <span className={analyticsStyles.liveTextSecondary}>
                AUTH:{' '}
                <a
                  className={analyticsStyles.liveMetaLink}
                  href={`https://github.com/${data.membership.githubLogin}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {data.membership.githubLogin}
                </a>
                {activeOrgs.length > 0 ? (
                  <>
                    ; ORGS:{' '}
                    {activeOrgs.map((org, index) => (
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

          <div className={analyticsStyles.toolbar}>
            <div className={analyticsStyles.toolbarMain}>
              <div className={`${analyticsStyles.segmented} ${analyticsStyles.toolbarGroupLead}`}>
                {ownerToggle}
              </div>
            </div>
            <div className={analyticsStyles.toolbarActions}>
              {toolbarAction}
            </div>
          </div>

          <div className={analyticsStyles.managementSectionStack}>
            <OrgManagementSections data={data} />
          </div>
        </div>
      </div>
    </main>
  );
}

export function OrgDashboardSections(input: {
  data: OrgDashboardPageState;
  activeOrgs?: OrgHeaderOrg[];
}) {
  const { data } = input;
  const activeOrgs = input.activeOrgs ?? [];
  const orgSlug = data.org.slug;
  const dashboardTitle = orgSlug === 'innies' ? 'monitor the innies' : `monitor ${orgSlug} innies`;
  const [ownerView, setOwnerView] = useState<OwnerView>('analytics');
  const showOwnerToggle = data.membership.isOwner;
  const applyOwnerView = (nextView: OwnerView) => {
    setOwnerView(nextView);

    const nextHash = ownerViewHref(nextView);
    if (window.location.hash === nextHash) {
      return;
    }

    const url = new URL(window.location.href);
    url.hash = nextHash.slice(1);
    window.history.replaceState(null, '', url);
  };

  useEffect(() => {
    if (!showOwnerToggle) return;

    function handleHashChange() {
      setOwnerView(readOwnerViewFromHash(window.location.hash));
    }

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [showOwnerToggle]);

  const ownerToggle = showOwnerToggle ? (
    <OwnerViewToggle ownerView={ownerView} onChange={applyOwnerView} />
  ) : null;
  const toolbarAction = (
    <OrgDashboardToolbarActions membership={data.membership} org={data.org} view={ownerView} />
  );
  const tokenSectionMetaAction = (
    <button
      className={analyticsStyles.sectionMetaButton}
      onClick={() => globalThis.dispatchEvent(new CustomEvent('innies:add-token-modal'))}
      type="button"
    >
      [CLICK TO ADD TOKENS]
    </button>
  );

  if (showOwnerToggle && ownerView === 'management') {
    return (
      <OwnerManagementView
        activeOrgs={activeOrgs}
        dashboardTitle={dashboardTitle}
        data={data}
        ownerToggle={ownerToggle}
        toolbarAction={toolbarAction}
      />
    );
  }

  return (
    <main className={analyticsStyles.page}>
      <div className={analyticsStyles.shell}>
        <AnalyticsDashboardClient
          activeOrgs={activeOrgs}
          authGithubLogin={data.membership.githubLogin}
          buyerSectionTitle="BUYER KEYS (outies)"
          dashboardPath={data.analyticsPaths.dashboardPath}
          kickerLabel={` / ${orgSlug.toUpperCase()}`}
          orgSlug={orgSlug}
          timeseriesPath={data.analyticsPaths.timeseriesPath}
          tokenRowRemoveConfig={orgSlug === 'innies' ? undefined : {
            orgSlug,
            viewerGithubLogin: data.membership.githubLogin,
            createdByGithubLoginByTokenId: Object.fromEntries(
              data.tokens.map((token) => [token.tokenId, token.createdByGithubLogin]),
            ),
          }}
          toolbarAction={toolbarAction}
          toolbarLead={ownerToggle}
          title={dashboardTitle}
          tokenSectionMetaAction={tokenSectionMetaAction}
          tokenSectionTitle="TOKEN CREDS (innies)"
        />
      </div>
    </main>
  );
}
