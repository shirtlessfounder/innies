'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePublicLiveMeta } from '../hooks/usePublicLiveMeta';
import { formatLocalTimeZoneAbbreviation, formatTimestamp } from '../lib/analytics/present';
import type { OrgHeaderOrg } from '../lib/org/types';
import styles from '../app/page.module.css';

const STATIC_HEADER_ROWS = [
  'Consolidate your Claude Code and Codex tokens into a single, optimized key.',
  'Create orgs to pool and manage tokens with your teammates.',
] as const;
const COMMAND_PREFIX = 'innies ';
const COMMAND_SUFFIXES = ['claude', 'codex', 'openclaw'] as const;
const TYPE_DELAY_MS = 85;
const DELETE_DELAY_MS = 55;
const HOLD_DELAY_MS = 1200;
const SWITCH_DELAY_MS = 220;
const ANALYTICS_COMMAND_LABEL = 'watch analytics --window 24h --mode token --metric usage';

export function LandingHeroHeader(input: {
  promptMode?: 'landing' | 'analytics';
  title?: string;
  brandSuffix?: string;
  analyticsPromptLabel?: string;
  analyticsPromptLinkLabel?: string;
  analyticsPromptLinkHref?: string;
  analyticsPromptSecondaryLinkLabel?: string;
  analyticsPromptSecondaryLinkHref?: string;
  analyticsPromptSuffix?: string;
  authGithubLogin?: string | null;
  authStartUrl?: string | null;
  activeOrgs?: OrgHeaderOrg[];
}) {
  const promptMode = input.promptMode ?? 'landing';
  const activeOrgs = input.activeOrgs ?? [];
  const analyticsPromptLabel = input.analyticsPromptLabel ?? ANALYTICS_COMMAND_LABEL;
  const analyticsPrompt = (
    <div className={styles.promptLine}>
      <span className={styles.promptPrefix}>innies:~$</span>
      <span className={styles.promptCommand}>
        <span className={styles.promptCommandText}>
          <span>{analyticsPromptLabel}</span>
          {input.analyticsPromptLinkLabel && input.analyticsPromptLinkHref ? (
            <>
              {' '}
              <a
                className={styles.promptLink}
                href={input.analyticsPromptLinkHref}
                rel="noreferrer"
                target="_blank"
              >
                {input.analyticsPromptLinkLabel}
              </a>
              {input.analyticsPromptSecondaryLinkLabel && input.analyticsPromptSecondaryLinkHref ? (
                <>
                  {' '}
                  <span>in</span>
                  {' '}
                  <a
                    className={styles.promptLink}
                    href={input.analyticsPromptSecondaryLinkHref}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {input.analyticsPromptSecondaryLinkLabel}
                  </a>
                </>
              ) : null}
              {input.analyticsPromptSuffix ? (
                <>
                  {' '}
                  <span>{input.analyticsPromptSuffix}</span>
                </>
              ) : null}
            </>
          ) : null}
          <span className={styles.promptCursor} aria-hidden="true" />
        </span>
      </span>
    </div>
  );

  const liveMeta = usePublicLiveMeta();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandText, setCommandText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'holding' | 'deleting'>('typing');
  const targetCommand = `${COMMAND_PREFIX}${COMMAND_SUFFIXES[commandIndex]}`;
  const authGithubLogin = input.authGithubLogin?.trim() || null;
  const authStartUrl = input.authStartUrl?.trim() || null;

  useEffect(() => {
    const timeoutId = globalThis.setTimeout(() => {
      if (phase === 'typing') {
        if (commandText === targetCommand) {
          setPhase('holding');
          return;
        }

        setCommandText(targetCommand.slice(0, commandText.length + 1));
        return;
      }

      if (phase === 'holding') {
        setPhase('deleting');
        return;
      }

      if (commandText === COMMAND_PREFIX) {
        setCommandIndex((current) => (current + 1) % COMMAND_SUFFIXES.length);
        setPhase('typing');
        return;
      }

      setCommandText((current) => current.slice(0, -1));
    }, phase === 'holding'
      ? HOLD_DELAY_MS
      : phase === 'deleting' && commandText === COMMAND_PREFIX
        ? SWITCH_DELAY_MS
        : phase === 'deleting'
          ? DELETE_DELAY_MS
          : TYPE_DELAY_MS);

    return () => globalThis.clearTimeout(timeoutId);
  }, [commandIndex, commandText, phase, targetCommand]);

  return (
    <header className={styles.consoleHeader}>
      <div className={styles.headerBlock}>
        <div className={styles.kicker}>
          <Link className={styles.homeLink} href="/">
            INNIES.COMPUTER{input.brandSuffix ? ` ${input.brandSuffix}` : ''}
          </Link>
        </div>
        <h1 className={styles.consoleTitle}>{input.title ?? 'welcome to innies'}</h1>
        {promptMode === 'analytics' ? analyticsPrompt : (
          <div className={styles.promptStack}>
            {STATIC_HEADER_ROWS.map((line) => (
              <div key={line} className={styles.promptLine}>
                <span className={styles.promptPrefix}>innies:~$</span>
                <span className={styles.promptCommand}>
                  <span className={styles.promptCommandText}>{line}</span>
                </span>
              </div>
            ))}
            <div className={styles.promptLine}>
              <span className={styles.promptPrefix}>innies:~$</span>
              <span
                aria-label="innies claude, innies codex, innies openclaw"
                className={styles.promptCommand}
              >
                <span className={styles.promptCommandText} aria-hidden="true">
                  {commandText}
                  <span className={styles.promptCursor} aria-hidden="true" />
                </span>
              </span>
            </div>
          </div>
        )}
      </div>

      <div className={styles.liveMeta}>
        <span className={`${styles.liveBadge} ${styles[`liveBadge_${liveMeta.liveStatus}`]}`}>
          <span className={styles.liveDot} />
          {liveMeta.liveStatus.toUpperCase()}
        </span>
        <span className={styles.liveText}>
          LAST {formatTimestamp(liveMeta.lastSuccessfulUpdateAt)} {formatLocalTimeZoneAbbreviation(liveMeta.lastSuccessfulUpdateAt)}
        </span>
        <span className={styles.liveTextSecondary}>
          {authGithubLogin ? (
            <>
              AUTH:{' '}
              <a
                className={styles.liveMetaLink}
                href={`https://github.com/${authGithubLogin}`}
                rel="noreferrer"
                target="_blank"
              >
                {authGithubLogin}
              </a>
            </>
          ) : authStartUrl ? (
            <>
              AUTH:{' '}
              <a className={styles.liveMetaLink} href={authStartUrl}>
                [CLICK TO LOG IN WITH GITHUB]
              </a>
            </>
          ) : (
            <>
              AUTH:{' '}
              <span className={styles.liveMetaMuted}>None</span>
            </>
          )}
          {activeOrgs.length > 0 ? (
            <>
              ; ORGS:{' '}
              {activeOrgs.map((org, index) => (
                <span key={org.slug}>
                  {index > 0 ? ', ' : ''}
                  <Link className={styles.liveMetaLink} href={`/${org.slug}`}>
                    {org.slug}
                  </Link>
                </span>
              ))}
            </>
          ) : null}
        </span>
      </div>
    </header>
  );
}
