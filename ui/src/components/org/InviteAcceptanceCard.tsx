'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './orgDashboard.module.css';

type InviteAcceptanceCardProps = {
  orgSlug: string;
  orgName: string;
  githubLogin: string;
};

function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.code === 'string' && record.code.trim().length > 0) {
      return record.code;
    }
    if (typeof record.kind === 'string' && record.kind.trim().length > 0) {
      return record.kind;
    }
  }
  return fallback;
}

async function safeReadBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function InviteAcceptanceCard(input: InviteAcceptanceCardProps) {
  const { githubLogin, orgName, orgSlug } = input;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${orgSlug}/invites/accept`, {
        method: 'POST',
      });
      const body = await safeReadBody(response);

      if (!response.ok) {
        const message = readErrorMessage(body, 'Could not accept this invite.');
        if (message === 'invite_no_longer_valid') {
          setError('This invite is no longer valid.');
          return;
        }
        setError(message);
        return;
      }

      router.push(`/${orgSlug}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not accept this invite.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>Invite ready</h2>
          <p className={styles.sectionHint}>
            {githubLogin} has a pending seat in {orgName}. Accept invite to activate the org membership and reveal the new buyer key once.
          </p>
        </div>
      </div>

      <div className={styles.pillRow}>
        <span className={styles.pill}>Org {orgSlug}</span>
        <span className={styles.goodPill}>Pending invite</span>
      </div>

      {error ? <p className={styles.errorBox}>{error}</p> : null}

      <div className={styles.formActions}>
        <button className={styles.actionButton} disabled={pending} onClick={handleAccept} type="button">
          {pending ? 'Accepting...' : 'Accept invite'}
        </button>
      </div>
    </section>
  );
}
