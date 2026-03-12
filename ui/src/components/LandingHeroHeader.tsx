'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePublicLiveMeta } from '../hooks/usePublicLiveMeta';
import { formatTimestamp } from '../lib/analytics/present';
import styles from '../app/page.module.css';

const STATIC_HEADER_ROWS = [
  'Get more Claude Code and Codex usage without buying new $200/month accounts.',
  'Share unused capacity with teammates or others and earn money back.',
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
  analyticsPromptLabel?: string;
  analyticsPromptLinkLabel?: string;
  analyticsPromptLinkHref?: string;
  analyticsPromptSuffix?: string;
}) {
  const promptMode = input.promptMode ?? 'landing';
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
            INNIES.COMPUTER
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
        <span className={styles.liveText}>LAST {formatTimestamp(liveMeta.lastSuccessfulUpdateAt)} UTC</span>
      </div>
    </header>
  );
}
