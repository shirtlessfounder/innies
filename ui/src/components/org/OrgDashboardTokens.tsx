'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import analyticsStyles from '../../app/analytics/page.module.css';
import { formatCount } from '../../lib/analytics/present';
import type { OrgDashboardPageState, OrgTokenStatus } from '../../lib/org/types';

type OrgDashboardTokensProps = Pick<
  OrgDashboardPageState,
  'org' | 'membership' | 'tokenPermissions' | 'tokens'
>;

type ReserveDraft = {
  fiveHourReservePercent: string;
  sevenDayReservePercent: string;
};

function buildReserveDrafts(tokens: OrgDashboardTokensProps['tokens']): Record<string, ReserveDraft> {
  return Object.fromEntries(tokens.map((token) => [
    token.tokenId,
    {
      fiveHourReservePercent: String(token.fiveHourReservePercent),
      sevenDayReservePercent: String(token.sevenDayReservePercent),
    },
  ]));
}

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

function canManageToken(
  githubLogin: string,
  canManageAllTokens: boolean,
  createdByGithubLogin: string | null,
): boolean {
  return canManageAllTokens || (githubLogin.length > 0 && githubLogin === createdByGithubLogin);
}

function parseReservePercent(value: string, label: '5h' | '1w'): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} reserve percent is required.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${label} reserve percent must be between 0 and 100.`);
  }
  return parsed;
}

function formatTokenLabel(debugLabel: string | null): string {
  const trimmed = debugLabel?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '--';
}

function canProbeToken(status: OrgTokenStatus): boolean {
  return status === 'active' || status === 'maxed';
}

export function OrgDashboardTokens(input: OrgDashboardTokensProps) {
  const { membership, org, tokenPermissions, tokens } = input;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [reserveDrafts, setReserveDrafts] = useState<Record<string, ReserveDraft>>(() => buildReserveDrafts(tokens));

  useEffect(() => {
    setReserveDrafts(buildReserveDrafts(tokens));
  }, [tokens]);

  async function mutateToken(token: { tokenId: string }, action: 'probe' | 'remove') {
    if (pendingAction) return;

    setPendingAction(`${action}:${token.tokenId}`);
    setError(null);

    try {
      const path = action === 'probe'
        ? `/api/orgs/${org.slug}/tokens/${token.tokenId}/probe`
        : `/api/orgs/${org.slug}/tokens/${token.tokenId}/remove`;
      const response = await fetch(path, {
        method: 'POST',
      });
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

  function updateReserveDraft(
    tokenId: string,
    field: keyof ReserveDraft,
    value: string,
  ) {
    setReserveDrafts((current) => ({
      ...current,
      [tokenId]: {
        ...(current[tokenId] ?? {
          fiveHourReservePercent: '0',
          sevenDayReservePercent: '0',
        }),
        [field]: value,
      },
    }));
  }

  async function saveReserveFloors(token: {
    tokenId: string;
    fiveHourReservePercent: number;
    sevenDayReservePercent: number;
  }) {
    if (pendingAction) return;

    const draft = reserveDrafts[token.tokenId] ?? {
      fiveHourReservePercent: String(token.fiveHourReservePercent),
      sevenDayReservePercent: String(token.sevenDayReservePercent),
    };

    let fiveHourReservePercent: number;
    let sevenDayReservePercent: number;

    try {
      fiveHourReservePercent = parseReservePercent(draft.fiveHourReservePercent, '5h');
      sevenDayReservePercent = parseReservePercent(draft.sevenDayReservePercent, '1w');
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Reserve values are invalid.');
      return;
    }

    setPendingAction(`reserve:${token.tokenId}`);
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/tokens/${token.tokenId}/reserve-floors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fiveHourReservePercent,
          sevenDayReservePercent,
        }),
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not save reserve floors for this token.'));
        return;
      }

      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not save reserve floors for this token.');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className={analyticsStyles.section}>
      <div className={analyticsStyles.sectionHeader}>
        <div className={analyticsStyles.sectionTitle}>Org tokens</div>
        <div className={analyticsStyles.sectionMeta}>
          {`${formatCount(tokens.length)} TOKENS`}
        </div>
      </div>

      {error ? (
        <div className={analyticsStyles.noticeList}>
          <div className={analyticsStyles.noticeError}>{error}</div>
        </div>
      ) : null}

      {tokens.length === 0 ? (
        <div className={analyticsStyles.emptyStateText}>No org tokens yet.</div>
      ) : (
      <div className={analyticsStyles.tableWrap}>
        <table className={analyticsStyles.table}>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Creator</th>
              <th>Token</th>
              <th className={analyticsStyles.numeric}>5h</th>
              <th className={analyticsStyles.numeric}>1w</th>
              <th className={analyticsStyles.tableActionsColumn}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => {
              const manageable = canManageToken(
                membership.githubLogin,
                tokenPermissions.canManageAllTokens,
                token.createdByGithubLogin,
              );
              const reserveDraft = reserveDrafts[token.tokenId] ?? {
                fiveHourReservePercent: String(token.fiveHourReservePercent),
                sevenDayReservePercent: String(token.sevenDayReservePercent),
              };
              const probeEnabled = canProbeToken(token.status);
              const reserveDirty = reserveDraft.fiveHourReservePercent !== String(token.fiveHourReservePercent)
                || reserveDraft.sevenDayReservePercent !== String(token.sevenDayReservePercent);
              return (
                <tr key={token.tokenId}>
                  <td>{token.provider === 'openai' ? 'Codex' : 'Claude'}</td>
                  <td>{token.createdByGithubLogin ?? token.createdByUserId ?? '--'}</td>
                  <td>{formatTokenLabel(token.debugLabel)}</td>
                  <td className={analyticsStyles.numeric}>
                    {tokenPermissions.canManageAllTokens ? (
                      <label className={analyticsStyles.tableBracketField}>
                        <span className={analyticsStyles.tableBracketAffix} aria-hidden="true">[</span>
                        <input
                          className={analyticsStyles.tableBracketInput}
                          inputMode="numeric"
                          max={100}
                          min={0}
                          name="fiveHourReservePercent"
                          onChange={(event) => updateReserveDraft(token.tokenId, 'fiveHourReservePercent', event.target.value)}
                          type="number"
                          value={reserveDraft.fiveHourReservePercent}
                        />
                        <span className={analyticsStyles.tableBracketAffix} aria-hidden="true">]</span>
                      </label>
                    ) : <span className={analyticsStyles.tableBracketValue}>[{token.fiveHourReservePercent}]</span>}
                  </td>
                  <td className={analyticsStyles.numeric}>
                    {tokenPermissions.canManageAllTokens ? (
                      <label className={analyticsStyles.tableBracketField}>
                        <span className={analyticsStyles.tableBracketAffix} aria-hidden="true">[</span>
                        <input
                          className={analyticsStyles.tableBracketInput}
                          inputMode="numeric"
                          max={100}
                          min={0}
                          name="sevenDayReservePercent"
                          onChange={(event) => updateReserveDraft(token.tokenId, 'sevenDayReservePercent', event.target.value)}
                          type="number"
                          value={reserveDraft.sevenDayReservePercent}
                        />
                        <span className={analyticsStyles.tableBracketAffix} aria-hidden="true">]</span>
                      </label>
                    ) : <span className={analyticsStyles.tableBracketValue}>[{token.sevenDayReservePercent}]</span>}
                  </td>
                  <td className={analyticsStyles.tableActionsColumn}>
                    {manageable ? (
                      <div className={analyticsStyles.managementInlineActions}>
                        <button
                          className={analyticsStyles.managementTableActionButton}
                          disabled={pendingAction !== null || !reserveDirty}
                          onClick={() => {
                            void saveReserveFloors(token);
                          }}
                          type="button"
                        >
                          [save]
                        </button>
                        {probeEnabled ? (
                          <button
                            className={analyticsStyles.managementTableActionButton}
                            disabled={pendingAction !== null}
                            onClick={() => mutateToken(token, 'probe')}
                            type="button"
                          >
                            [probe]
                          </button>
                        ) : null}
                        <button
                          className={analyticsStyles.managementTableActionButton}
                          disabled={pendingAction !== null}
                          onClick={() => mutateToken(token, 'remove')}
                          type="button"
                        >
                          [remove]
                        </button>
                      </div>
                    ) : (
                      <span className={analyticsStyles.managementMuted}>Owner or creator only</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}
