'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import analyticsStyles from '../../app/analytics/page.module.css';

type LockInResponse = {
  message?: string;
};

export function BuyerKeyRevealPreferenceForm(input: { orgSlug: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const preferredProvider = String(formData.get('preferredProvider') ?? '').trim();

    try {
      const response = await fetch(`/api/orgs/${input.orgSlug}/buyer-key/provider-preference`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ preferredProvider })
      });
      const payload = (await response.json().catch(() => null)) as LockInResponse | null;

      if (!response.ok) {
        setError(payload?.message ?? 'Could not lock in OpenClaw preference.');
        setPending(false);
        return;
      }

      router.refresh();
    } catch {
      setError('Could not lock in OpenClaw preference.');
      setPending(false);
    }
  }

  return (
    <form className={analyticsStyles.modalFormStack} onSubmit={handleSubmit}>
      <label className={analyticsStyles.managementField}>
        <span>OpenClaw Pref</span>
        <select className={analyticsStyles.managementSelect} defaultValue="openai" name="preferredProvider" required>
          <option value="anthropic">Claude</option>
          <option value="openai">Codex</option>
        </select>
      </label>

      {error ? <div className={analyticsStyles.noticeError}>{error}</div> : null}

      <div className={analyticsStyles.managementActionRow}>
        <button className={analyticsStyles.managementPrimaryButton} disabled={pending} type="submit">
          LOCKED IN
        </button>
      </div>
    </form>
  );
}
