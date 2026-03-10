'use client';

import { useEffect, useRef, useState } from 'react';
import styles from '../app/page.module.css';

const NAV_ITEMS = ['ONBOARDING', 'HOW IT WORKS', 'MONEY SAVINGS'] as const;

function ChevronIcon() {
  return (
    <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.25 4.5 6 8.25 9.75 4.5" fill="none" />
    </svg>
  );
}

export function HeaderNav() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (openIndex === null) {
      return;
    }

    timeoutRef.current = setTimeout(() => {
      setOpenIndex(null);
    }, 1000);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [openIndex]);

  return (
    <nav className={styles.nav} aria-label="Primary">
      {NAV_ITEMS.map((label, index) => {
        const open = openIndex === index;
        return (
          <div
            key={label}
            className={styles.navDropdown}
            data-open={open ? 'true' : 'false'}
          >
            <button
              type="button"
              className={styles.navSummary}
              onClick={() => setOpenIndex((current) => current === index ? null : index)}
            >
              <span>{label}</span>
              <ChevronIcon />
            </button>
            <div className={styles.navPanel} hidden={!open}>
              Coming soon
            </div>
          </div>
        );
      })}
    </nav>
  );
}
