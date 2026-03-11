'use client';

import { useEffect, useState } from 'react';
import styles from './page.module.css';

export function PaneCopyButton(input: { contents: string; fileName: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timeoutId = globalThis.setTimeout(() => setCopied(false), 1400);
    return () => globalThis.clearTimeout(timeoutId);
  }, [copied]);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(input.contents);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      aria-label={`Copy ${input.fileName}`}
      className={[
        styles.copyButton,
        copied ? styles.copyButtonCopied : '',
      ].filter(Boolean).join(' ')}
      onClick={() => {
        void handleClick();
      }}
      title={copied ? 'Copied' : `Copy ${input.fileName}`}
      type="button"
    >
      <svg className={styles.copyIcon} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="3.5" width="7" height="9" rx="1.4" />
        <path d="M4.5 10.5h-1A1.5 1.5 0 0 1 2 9V4.5A1.5 1.5 0 0 1 3.5 3h4" />
      </svg>
    </button>
  );
}
