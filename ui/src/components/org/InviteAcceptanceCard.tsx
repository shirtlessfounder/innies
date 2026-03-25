'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import analyticsStyles from '../../app/analytics/page.module.css';
import { getInviteAcceptanceErrorMessage } from './inviteAcceptanceError';

type InviteAcceptanceCardProps = {
  orgSlug: string;
  orgName: string;
  githubLogin: string;
  variant?: 'section' | 'modal';
};

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
  const { githubLogin, orgName, orgSlug, variant = 'section' } = input;
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
        setError(getInviteAcceptanceErrorMessage(body, 'Could not accept this invite.'));
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

  if (variant === 'modal') {
    return (
      <>
        <div className={analyticsStyles.noticeList}>
          <div className={analyticsStyles.noticeText}>
            {githubLogin} has a pending seat in {orgName}. Accept invite to activate the org membership and reveal the new buyer key once.
          </div>
          {error ? <div className={analyticsStyles.noticeError}>{error}</div> : null}
        </div>

        <div className={analyticsStyles.modalFormStack}>
          <div className={analyticsStyles.managementActionRow}>
            <button className={analyticsStyles.managementPrimaryButton} disabled={pending} onClick={handleAccept} type="button">
              {pending ? 'Accepting...' : 'Accept invite'}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <section className={analyticsStyles.section}>
      <div className={analyticsStyles.sectionHeader}>
        <div className={analyticsStyles.sectionTitle}>Invite ready</div>
        <div className={analyticsStyles.sectionMeta}>Pending invite · {orgSlug}</div>
      </div>

      <div className={analyticsStyles.noticeList}>
        <div className={analyticsStyles.noticeText}>
          {githubLogin} has a pending seat in {orgName}. Accept invite to activate the org membership and reveal the new buyer key once.
        </div>
        {error ? <div className={analyticsStyles.noticeError}>{error}</div> : null}
      </div>

      <div className={analyticsStyles.managementActionRow}>
        <button className={analyticsStyles.managementPrimaryButton} disabled={pending} onClick={handleAccept} type="button">
          {pending ? 'Accepting...' : 'Accept invite'}
        </button>
      </div>
    </section>
  );
}
