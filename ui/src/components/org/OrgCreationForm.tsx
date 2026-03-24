'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type OrgCreationFormProps = {
  submitClassName?: string;
};

function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
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

function describeCreateError(body: unknown, status: number): string {
  const message = readErrorMessage(body, status >= 500 ? 'Could not finish org creation right now.' : 'Could not create this org.');
  const normalized = message.toLowerCase();
  if (normalized.includes('reserved')) {
    return 'That org slug is reserved. Try another name.';
  }
  if (normalized.includes('already exists') || normalized.includes('already taken') || normalized.includes('exists')) {
    return 'That org slug already exists. Try another name.';
  }
  return message;
}

export function OrgCreationForm(input: OrgCreationFormProps) {
  const router = useRouter();
  const [orgName, setOrgName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/orgs/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ orgName }),
      });
      const body = await safeReadBody(response);

      if (!response.ok) {
        setError(describeCreateError(body, response.status));
        return;
      }

      if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).orgSlug !== 'string') {
        setError('Org creation completed without a redirect target.');
        return;
      }

      router.push(`/${(body as { orgSlug: string }).orgSlug}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create this org.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'grid',
        gap: '12px',
        width: 'min(520px, 100%)',
      }}
    >
      <label
        style={{
          display: 'grid',
          gap: '8px',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            color: 'rgba(59, 90, 105, 0.86)',
            fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
            fontSize: '0.92rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          Org name
        </span>
        <input
          autoComplete="organization"
          name="orgName"
          onChange={(event) => setOrgName(event.target.value)}
          placeholder="Acme Research"
          required
          type="text"
          value={orgName}
          style={{
            minHeight: '48px',
            padding: '0 14px',
            borderRadius: '8px',
            border: '1px solid rgba(59, 90, 105, 0.26)',
            background: 'rgba(248, 251, 253, 0.9)',
            color: '#16333e',
            font: 'inherit',
          }}
        />
      </label>

      <button className={input.submitClassName} disabled={pending || orgName.trim().length === 0} type="submit">
        <span>{pending ? 'Creating org...' : 'Create org'}</span>
      </button>

      {error ? (
        <p
          style={{
            margin: 0,
            padding: '10px 12px',
            borderRadius: '8px',
            border: '1px solid rgba(180, 35, 24, 0.22)',
            background: 'rgba(180, 35, 24, 0.08)',
            color: '#b42318',
            fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
          }}
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
