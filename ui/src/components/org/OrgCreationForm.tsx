'use client';

import Link from 'next/link';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import analyticsStyles from '../../app/analytics/page.module.css';
import {
  buildLandingOrgCreateReturnTo,
  buildOrgCreationAuthStartUrl,
  readPendingOrgName,
} from '../../lib/org/landing';
import { deriveOrgSlugPreview } from '../../lib/org/slug';

type OrgCreationFormProps = {
  authStartUrl: string;
  footerLinkRowClassName?: string;
  footerLinkClassName?: string;
  footerLinks?: Array<{
    external?: boolean;
    href: string;
    label: string;
  }>;
  formClassName?: string;
  initialOrgName?: string;
  inputClassName?: string;
  signedIn: boolean;
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
  if (normalized.includes('cannot be empty')) {
    return 'Use letters or numbers so we can derive a slug.';
  }
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
  const [orgName, setOrgName] = useState(input.initialOrgName ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugPreview = deriveOrgSlugPreview(orgName);
  const submitLabel = pending
    ? slugPreview
      ? `Creating /${slugPreview} org...`
      : 'Creating org...'
    : slugPreview
      ? `Create /${slugPreview} org`
      : 'Create org';

  async function createOrg(nextOrgName: string, options?: {
    clearPendingOrgReturnTo?: boolean;
  }) {
    setPending(true);
    setError(null);

    try {
      if (options?.clearPendingOrgReturnTo) {
        window.history.replaceState({}, '', buildLandingOrgCreateReturnTo(''));
      }

      const response = await fetch('/api/orgs/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ orgName: nextOrgName }),
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

  useEffect(() => {
    if (!input.signedIn) {
      return;
    }

    const pendingOrgName = readPendingOrgName(Object.fromEntries(new URLSearchParams(window.location.search)));
    if (pendingOrgName.length === 0) {
      return;
    }

    void createOrg(pendingOrgName, { clearPendingOrgReturnTo: true });
  }, [input.signedIn]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    if (!input.signedIn) {
      window.location.assign(buildOrgCreationAuthStartUrl(input.authStartUrl, orgName));
      return;
    }

    await createOrg(orgName);
  }

  return (
    <form
      className={[analyticsStyles.managementFormGrid, input.formClassName].filter(Boolean).join(' ')}
      onSubmit={handleSubmit}
    >
      <label className={[analyticsStyles.managementField, analyticsStyles.managementFieldWide].join(' ')}>
        <input
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          name="orgName"
          onChange={(event) => setOrgName(event.target.value)}
          placeholder="me-and-the-boys"
          required
          spellCheck={false}
          type="text"
          value={orgName}
          className={[analyticsStyles.managementInput, input.inputClassName].filter(Boolean).join(' ')}
        />
      </label>

      <div className={analyticsStyles.managementActionRow}>
        <button className={input.submitClassName} disabled={pending || slugPreview === null} type="submit">
          <span>{submitLabel}</span>
        </button>
      </div>

      {input.footerLinks?.length ? (
        <div
          className={[analyticsStyles.managementActionRow, input.footerLinkRowClassName]
            .filter(Boolean)
            .join(' ')}
        >
          {input.footerLinks.map((link) => (
            link.external ? (
              <a
                key={`${link.label}:${link.href}`}
                className={input.footerLinkClassName}
                href={link.href}
                rel="noreferrer"
                target="_blank"
              >
                {link.label}
              </a>
            ) : (
              <Link key={`${link.label}:${link.href}`} className={input.footerLinkClassName} href={link.href}>
                {link.label}
              </Link>
            )
          ))}
        </div>
      ) : null}

      {error ? (
        <div className={[analyticsStyles.noticeList, analyticsStyles.managementFieldWide].join(' ')}>
          <div className={analyticsStyles.noticeError}>{error}</div>
        </div>
      ) : null}
    </form>
  );
}
