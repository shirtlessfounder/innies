'use client';

import { useEffect, useState } from 'react';
import { TbCheck, TbCopy } from 'react-icons/tb';
import analyticsStyles from '../../app/analytics/page.module.css';

export function BuyerKeyRevealCopyButton(input: { buyerKey: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timeoutId = globalThis.setTimeout(() => setCopied(false), 1400);
    return () => globalThis.clearTimeout(timeoutId);
  }, [copied]);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(input.buyerKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      aria-label="Copy buyer key"
      className={[
        analyticsStyles.managementInlineButton,
        analyticsStyles.revealCopyButton,
        copied ? analyticsStyles.revealCopyButtonCopied : '',
      ].filter(Boolean).join(' ')}
      onClick={() => {
        void handleClick();
      }}
      title={copied ? 'Copied buyer key' : 'Copy buyer key'}
      type="button"
    >
      {copied ? (
        <TbCheck aria-hidden="true" className={analyticsStyles.revealCopyIcon} />
      ) : (
        <TbCopy aria-hidden="true" className={analyticsStyles.revealCopyIcon} />
      )}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
