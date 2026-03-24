'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './orgDashboard.module.css';
import type { OrgDashboardPageState } from '../../lib/org/types';

type OrgDashboardTokensProps = Pick<
  OrgDashboardPageState,
  'org' | 'membership' | 'tokenPermissions' | 'tokens'
>;

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

function parseOptionalReserve(value: FormDataEntryValue | null, label: string): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${label} reserve percent must be between 0 and 100.`);
  }
  return parsed;
}

function canManageToken(
  githubLogin: string,
  canManageAllTokens: boolean,
  createdByGithubLogin: string | null,
): boolean {
  return canManageAllTokens || (githubLogin.length > 0 && githubLogin === createdByGithubLogin);
}

export function OrgDashboardTokens(input: OrgDashboardTokensProps) {
  const { membership, org, tokenPermissions, tokens } = input;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  async function handleAddToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingAction) return;

    const form = event.currentTarget;
    const formData = new FormData(form);

    let fiveHourReservePercent: number | undefined;
    let sevenDayReservePercent: number | undefined;

    try {
      fiveHourReservePercent = parseOptionalReserve(formData.get('fiveHourReservePercent'), '5h');
      sevenDayReservePercent = parseOptionalReserve(formData.get('sevenDayReservePercent'), '1w');
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Reserve values are invalid.');
      return;
    }

    const provider = String(formData.get('provider') ?? '').trim();
    const token = String(formData.get('token') ?? '').trim();
    if (!provider || !token) {
      setError('Provider and token are required.');
      return;
    }

    setPendingAction('add');
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/tokens/add`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider,
          token,
          ...(fiveHourReservePercent === undefined ? {} : { fiveHourReservePercent }),
          ...(sevenDayReservePercent === undefined ? {} : { sevenDayReservePercent }),
        }),
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not add this token.'));
        return;
      }

      form.reset();
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not add this token.');
    } finally {
      setPendingAction(null);
    }
  }

  async function mutateToken(token: { tokenId: string }, action: 'refresh' | 'remove') {
    if (pendingAction) return;

    setPendingAction(`${action}:${token.tokenId}`);
    setError(null);

    try {
      const response = await fetch(
        action === 'refresh'
          ? `/api/orgs/${org.slug}/tokens/${token.tokenId}/refresh`
          : `/api/orgs/${org.slug}/tokens/${token.tokenId}/remove`,
        {
          method: 'POST',
        },
      );
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, `Could not ${action} this token.`));
        return;
      }

      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : `Could not ${action} this token.`);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>Org tokens</h2>
          <p className={styles.sectionHint}>
            Borrow Claude and Codex capacity into this org, keep creator attribution visible, and preserve the existing 5h / 1w reserve model.
          </p>
        </div>
      </div>

      {error ? <p className={styles.errorBox}>{error}</p> : null}

      <form className={styles.cardGrid} onSubmit={handleAddToken}>
        <label className={styles.fieldLabel}>
          Provider
          <select className={styles.select} defaultValue="anthropic" name="provider">
            <option value="anthropic">Claude</option>
            <option value="openai">Codex</option>
          </select>
        </label>

        <label className={styles.fieldLabel}>
          Token
          <input className={styles.input} name="token" placeholder="Paste provider token" required type="password" />
        </label>

        <label className={styles.fieldLabel}>
          5h reserve %
          <input className={styles.input} inputMode="numeric" name="fiveHourReservePercent" placeholder="Optional" type="number" />
        </label>

        <label className={styles.fieldLabel}>
          1w reserve %
          <input className={styles.input} inputMode="numeric" name="sevenDayReservePercent" placeholder="Optional" type="number" />
        </label>

        <div className={styles.formActions}>
          <button className={styles.actionButton} disabled={pendingAction === 'add'} type="submit">
            {pendingAction === 'add' ? 'Adding token...' : 'Add token'}
          </button>
        </div>
      </form>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Creator</th>
              <th>5h</th>
              <th>1w</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => {
              const manageable = canManageToken(
                membership.githubLogin,
                tokenPermissions.canManageAllTokens,
                token.createdByGithubLogin,
              );
              return (
                <tr key={token.tokenId}>
                  <td>{token.provider}</td>
                  <td>{token.createdByGithubLogin ?? token.createdByUserId ?? '--'}</td>
                  <td>{token.fiveHourReservePercent}%</td>
                  <td>{token.sevenDayReservePercent}%</td>
                  <td>
                    {manageable ? (
                      <div className={styles.inlineActions}>
                        <button
                          className={styles.inlineButton}
                          disabled={pendingAction === `refresh:${token.tokenId}`}
                          onClick={() => mutateToken(token, 'refresh')}
                          type="button"
                        >
                          Refresh
                        </button>
                        <button
                          className={styles.inlineButton}
                          disabled={pendingAction === `remove:${token.tokenId}`}
                          onClick={() => mutateToken(token, 'remove')}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <span className={styles.muted}>Owner or creator only</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {tokens.length === 0 ? <div className={styles.emptyState}>No org tokens yet.</div> : null}
    </section>
  );
}
