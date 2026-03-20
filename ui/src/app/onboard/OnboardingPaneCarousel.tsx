'use client';

import { startTransition, useEffect, useState, type CSSProperties } from 'react';
import { PaneCopyButton } from './PaneCopyButton';
import {
  chunkIntoPanePages,
  clampPageIndex,
  getPageButtonState,
} from './carousel';
import type { OnboardingPane } from './paneData';
import styles from './page.module.css';

function pageSizeForWidth(width: number): number {
  if (width <= 720) return 1;
  if (width <= 1080) return 2;
  return 3;
}

function OnboardingPaneCard(input: { pane: OnboardingPane }) {
  const { pane } = input;

  return (
    <article
      aria-label={pane.title}
      className={styles.pane}
    >
      <div className={styles.paneChrome}>
        <div className={styles.paneLights} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className={styles.paneTab}>{pane.fileName}</div>
        <div className={styles.paneChromeActions}>
          <div className={styles.paneCount}>{pane.lines.length} lines</div>
          <PaneCopyButton fileName={pane.fileName} contents={pane.contents} />
        </div>
      </div>

      <div className={styles.paneBody}>
        <div className={styles.paneRows}>
          {pane.lines.map((line) => (
            <div key={`${pane.fileName}-${line.number}`} className={styles.paneLine}>
              <span className={styles.lineNumber}>{line.number}</span>
              <span
                className={[
                  styles.lineText,
                  styles[`line_${line.kind}`],
                ].filter(Boolean).join(' ')}
              >
                {line.text.length > 0 ? line.text : ' '}
              </span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function OnboardingPaneCarousel(input: { panes: OnboardingPane[] }) {
  const [pageSize, setPageSize] = useState(3);
  const pages = chunkIntoPanePages(input.panes, pageSize);
  const [activePage, setActivePage] = useState(0);
  const buttonState = getPageButtonState(activePage, pages.length);
  const pageStyle = {
    '--page-columns': String(pageSize),
  } as CSSProperties;

  useEffect(() => {
    const syncPageSize = () => {
      const nextPageSize = pageSizeForWidth(globalThis.innerWidth);

      startTransition(() => {
        setPageSize((current) => current === nextPageSize ? current : nextPageSize);
        setActivePage((current) => clampPageIndex(current, Math.ceil(input.panes.length / nextPageSize)));
      });
    };

    syncPageSize();
    globalThis.addEventListener('resize', syncPageSize);

    return () => {
      globalThis.removeEventListener('resize', syncPageSize);
    };
  }, [input.panes.length]);

  const goToPage = (targetPage: number) => {
    startTransition(() => {
      setActivePage((current) => {
        const nextPage = typeof targetPage === 'number' ? targetPage : current;
        return clampPageIndex(nextPage, pages.length);
      });
    });
  };

  return (
    <>
      <div className={styles.workspaceMeta}>
        <span className={styles.workspaceLabel}>ONBOARDING WORKSPACE</span>
        <span className={styles.workspaceHint}>4 GUIDES LOADED · COPY AND SEND TO AGENT TO SET UP</span>

        <div className={styles.carouselControls}>
          <button
            aria-label="Show previous onboarding page"
            className={styles.carouselButton}
            disabled={!buttonState.canScrollLeft}
            onClick={() => {
              goToPage(activePage - 1);
            }}
            type="button"
          >
            LEFT
          </button>
          <div className={styles.carouselPosition}>
            {activePage + 1} / {pages.length}
          </div>
          <button
            aria-label="Show next onboarding page"
            className={styles.carouselButton}
            disabled={!buttonState.canScrollRight}
            onClick={() => {
              goToPage(activePage + 1);
            }}
            type="button"
          >
            RIGHT
          </button>
        </div>
      </div>

      <div className={styles.carouselViewport}>
        <div
          className={styles.carouselTrack}
          style={{
            ...pageStyle,
            transform: `translateX(-${activePage * 100}%)`,
          }}
        >
          {pages.map((page, pageIndex) => (
            <div
              key={`page-${pageIndex + 1}`}
              aria-label={`Onboarding page ${pageIndex + 1}`}
              className={styles.carouselPage}
              role="group"
            >
              {page.map((pane) => (
                <OnboardingPaneCard key={pane.fileName} pane={pane} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
