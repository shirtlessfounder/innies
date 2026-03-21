import { randomBytes } from 'node:crypto';
import Link from 'next/link';
import styles from './dashboard.module.css';
import {
  formatAccountHealth,
  formatCount,
  formatPaymentAttemptKind,
  formatPaymentAttemptStatus,
  formatPaymentTrigger,
  formatPercentRatio,
  formatProvider,
  formatStoredPaymentMethod,
  formatProviderUsageWarning,
  formatRoutingMode,
  formatTimestamp,
  formatUsdMinor,
  formatWalletEffectType,
  formatWithdrawalDestination,
  summarizeRouteDecision,
} from '../../lib/pilot/present';
import type {
  AdminPilotAccountView,
  ConnectedAccount,
  EarningsHistoryEntry,
  EarningsSummary,
  PilotFundingState,
  PilotDashboardData,
  PilotIdentityDiscoveryEntry,
  RequestHistoryRow,
  WalletLedgerEntry,
  Withdrawal,
} from '../../lib/pilot/types';

function Section(input: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>{input.title}</h2>
          {input.hint ? <p className={styles.sectionHint}>{input.hint}</p> : null}
        </div>
        {input.actions}
      </div>
      {input.children}
    </section>
  );
}

function pillClass(kind: 'neutral' | 'good' | 'warn' | 'danger') {
  switch (kind) {
    case 'good':
      return styles.goodPill;
    case 'warn':
      return styles.warnPill;
    case 'danger':
      return styles.dangerPill;
    default:
      return styles.pill;
  }
}

function warningKind(account: ConnectedAccount): 'neutral' | 'good' | 'warn' | 'danger' {
  if (!account.providerUsageWarning) return 'good';
  if (account.providerUsageWarning.includes('exhausted') || account.providerUsageWarning.includes('hard_stale')) {
    return 'danger';
  }
  return 'warn';
}

export function DashboardPage(input: {
  title: string;
  eyebrow: string;
  lede: string;
  actions?: React.ReactNode;
  stats: Array<{ label: string; value: string }>;
  sections: React.ReactNode;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.heroTop}>
            <div>
              <div className={styles.eyebrow}>{input.eyebrow}</div>
              <h1 className={styles.title}>{input.title}</h1>
              <p className={styles.lede}>{input.lede}</p>
            </div>
            {input.actions ? <div className={styles.heroActions}>{input.actions}</div> : null}
          </div>
          <div className={styles.heroStats}>
            {input.stats.map((stat) => (
              <div className={styles.statCard} key={stat.label}>
                <p className={styles.statLabel}>{stat.label}</p>
                <p className={styles.statValue}>{stat.value}</p>
              </div>
            ))}
          </div>
        </section>
        <div className={styles.grid}>{input.sections}</div>
      </div>
    </main>
  );
}

export function WalletSection(input: {
  wallet: PilotDashboardData['wallet'] | AdminPilotAccountView['wallet'];
  ledger: WalletLedgerEntry[];
}) {
  return (
    <Section
      title="Wallet"
      hint="Balance, manual top-ups, and all wallet ledger movement are shown here from the append-only wallet ledger."
    >
      <div className={styles.pillRow}>
        <span className={styles.goodPill}>Balance {formatUsdMinor(input.wallet.balanceMinor)}</span>
        <span className={styles.pill}>Wallet id {input.wallet.walletId}</span>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Entry</th>
              <th>Amount</th>
              <th>When</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {input.ledger.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <strong>{formatWalletEffectType(entry)}</strong>
                  <div className={styles.muted}>{entry.effect_type}</div>
                </td>
                <td>{formatUsdMinor(entry.amount_minor)}</td>
                <td>{formatTimestamp(entry.created_at ?? null)}</td>
                <td>{entry.reason || '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {input.ledger.length === 0 ? <div className={styles.emptyState}>No wallet history yet.</div> : null}
    </Section>
  );
}

export function PaymentFundingSection(input: {
  funding: PilotFundingState;
  returnTo: string;
}) {
  const manualTopUpIdempotencyKey = randomBytes(24).toString('hex');

  return (
    <Section
      title="Payments & Auto-Recharge"
      hint="Stored card metadata, wallet top-up sessions, and auto-recharge controls stay aligned with processor state while wallet remains the single ledger writer."
    >
      <div className={styles.cardGrid}>
        <article className={styles.identityCard}>
          <div className={styles.cardTitleRow}>
            <div>
              <h3 className={styles.cardTitle}>Stored payment method</h3>
              <p className={styles.cardMeta}>
                {input.funding.paymentMethod
                  ? `${formatStoredPaymentMethod(input.funding.paymentMethod)} · exp ${String(input.funding.paymentMethod.expMonth).padStart(2, '0')}/${input.funding.paymentMethod.expYear}`
                  : 'No stored card on file yet.'}
              </p>
            </div>
            <span className={input.funding.paymentMethod ? styles.goodPill : styles.pill}>
              {input.funding.paymentMethod?.status || 'not_configured'}
            </span>
          </div>
          <div className={styles.pillRow}>
            <span className={styles.pill}>Processor Stripe</span>
            <span className={styles.pill}>Funding {input.funding.paymentMethod?.funding || '--'}</span>
          </div>
          <div className={styles.formActions}>
            <form action="/api/pilot/payments/setup" method="post">
              <input name="returnTo" type="hidden" value={input.returnTo} />
              <button className={styles.actionButton} type="submit">
                {input.funding.paymentMethod ? 'Replace Card' : 'Add Card'}
              </button>
            </form>
            {input.funding.paymentMethod ? (
              <form action="/api/pilot/payments/remove" method="post">
                <input name="returnTo" type="hidden" value={input.returnTo} />
                <button className={styles.ghostButton} type="submit">Remove Card</button>
              </form>
            ) : null}
          </div>
          <form action="/api/pilot/payments/top-up" method="post">
            <input name="idempotencyKey" type="hidden" value={manualTopUpIdempotencyKey} />
            <input name="returnTo" type="hidden" value={input.returnTo} />
            <div className={styles.formGrid}>
              <label className={styles.fieldLabel}>
                Manual top-up (minor units)
                <input
                  className={styles.input}
                  defaultValue="5000"
                  min="1"
                  name="amountMinor"
                  step="1"
                  type="number"
                />
              </label>
            </div>
            <div className={styles.formActions}>
              <button className={styles.actionButton} disabled={!input.funding.paymentMethod} type="submit">
                Create Top-Up Session
              </button>
            </div>
          </form>
        </article>

        <article className={styles.identityCard}>
          <div className={styles.cardTitleRow}>
            <div>
              <h3 className={styles.cardTitle}>Auto-recharge</h3>
              <p className={styles.cardMeta}>
                Admission-time and post-finalization recharge attempts use the stored card only when this wallet setting is enabled.
              </p>
            </div>
            <span className={input.funding.autoRecharge.enabled ? styles.goodPill : styles.warnPill}>
              {input.funding.autoRecharge.enabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          <form action="/api/pilot/payments/auto-recharge" method="post">
            <div className={styles.formGrid}>
              <label className={styles.fieldLabel}>
                Auto-recharge state
                <select className={styles.select} defaultValue={input.funding.autoRecharge.enabled ? 'true' : 'false'} name="enabled">
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <label className={styles.fieldLabel}>
                Recharge amount (minor units)
                <input
                  className={styles.input}
                  defaultValue={String(input.funding.autoRecharge.amountMinor)}
                  min="1"
                  name="amountMinor"
                  step="1"
                  type="number"
                />
              </label>
            </div>
            <div className={styles.formActions}>
              <input name="returnTo" type="hidden" value={input.returnTo} />
              <button className={styles.actionButton} type="submit">Save Auto-Recharge</button>
            </div>
          </form>
        </article>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Trigger</th>
              <th>Amount</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {input.funding.attempts.map((attempt) => (
              <tr key={attempt.id}>
                <td>
                  <strong>{formatPaymentAttemptKind(attempt)}</strong>
                  <div className={styles.muted}>{formatPaymentAttemptStatus(attempt)}</div>
                  {attempt.lastErrorMessage ? <div className={styles.muted}>{attempt.lastErrorMessage}</div> : null}
                </td>
                <td>{formatPaymentTrigger(attempt)}</td>
                <td>{formatUsdMinor(attempt.amountMinor)}</td>
                <td>{formatTimestamp(attempt.updatedAt || attempt.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {input.funding.attempts.length === 0 ? <div className={styles.emptyState}>No payment attempts yet.</div> : null}
    </Section>
  );
}

export function RequestHistorySection(input: {
  orgId: string;
  requests: RequestHistoryRow[];
  adminBasePath?: string;
}) {
  return (
    <Section
      title="Request History"
      hint="Post-cutover request history with routing attribution, money movement, and request previews."
    >
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Request</th>
              <th>Route</th>
              <th>Money</th>
              <th>Usage</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {input.requests.map((row) => (
              <tr key={`${row.request_id}:${row.attempt_no}`}>
                <td>
                  <strong>{row.request_id}</strong>
                  <div className={styles.muted}>{formatProvider(row.provider)} · {row.model}</div>
                  <div className={styles.muted}>{summarizeRouteDecision(row)}</div>
                  {input.adminBasePath ? (
                    <Link
                      className={styles.inlineButton}
                      href={`${input.adminBasePath}?explain=${encodeURIComponent(row.request_id)}`}
                    >
                      Explain
                    </Link>
                  ) : null}
                </td>
                <td>
                  <div>{formatRoutingMode(row.admission_routing_mode)}</div>
                  <div className={styles.muted}>{row.serving_org_id}</div>
                </td>
                <td>
                  <div>Debit {formatUsdMinor(row.buyer_debit_minor)}</div>
                  <div className={styles.muted}>Earnings {formatUsdMinor(row.contributor_earnings_minor)}</div>
                </td>
                <td>
                  <div>{formatCount(row.usage_units)} units</div>
                  <div className={styles.muted}>{formatCount(row.input_tokens)} in · {formatCount(row.output_tokens)} out</div>
                </td>
                <td>{formatTimestamp(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {input.requests.length === 0 ? <div className={styles.emptyState}>No post-cutover request history for {input.orgId}.</div> : null}
    </Section>
  );
}

export function ConnectedAccountsSection(input: {
  accounts: ConnectedAccount[];
  editable: boolean;
  returnTo: string;
}) {
  return (
    <Section
      title="Connected Accounts"
      hint="Connected account status, provider freshness, and Reserve Floors are shown per credential."
    >
      <div className={styles.cardGrid}>
        {input.accounts.map((account) => (
          <article className={styles.accountCard} key={account.credentialId}>
            <div className={styles.cardTitleRow}>
              <div>
                <h3 className={styles.cardTitle}>{account.debugLabel || account.credentialId}</h3>
                <p className={styles.cardMeta}>{formatProvider(account.provider)} · {account.credentialId}</p>
              </div>
              <span className={pillClass(warningKind(account))}>{account.status}</span>
            </div>
            <p className={styles.cardMeta}>{formatAccountHealth(account)}</p>
            <div className={styles.metricGrid}>
              <div>
                <p className={styles.metricLabel}>Provider Usage</p>
                <p className={styles.metricValue}>{account.providerUsageState.replaceAll('_', ' ')}</p>
              </div>
              <div>
                <p className={styles.metricLabel}>Fetched</p>
                <p className={styles.metricValue}>{formatTimestamp(account.providerUsageFetchedAt)}</p>
              </div>
              <div>
                <p className={styles.metricLabel}>5h Used</p>
                <p className={styles.metricValue}>{formatPercentRatio(account.fiveHourUtilizationRatio)}</p>
              </div>
              <div>
                <p className={styles.metricLabel}>7d Used</p>
                <p className={styles.metricValue}>{formatPercentRatio(account.sevenDayUtilizationRatio)}</p>
              </div>
            </div>
            <div className={styles.pillRow}>
              <span className={styles.pill}>Auth {account.authDiagnosis || 'ok'}</span>
              <span className={styles.pill}>Refresh {account.refreshTokenState || '--'}</span>
              <span className={pillClass(warningKind(account))}>{formatProviderUsageWarning(account)}</span>
            </div>
            {input.editable ? (
              <form action="/api/pilot/reserve-floors" method="post">
                <input name="credentialId" type="hidden" value={account.credentialId} />
                <input name="returnTo" type="hidden" value={input.returnTo} />
                <div className={styles.formGrid}>
                  <label className={styles.fieldLabel}>
                    Reserve Floors · 5h
                    <input
                      className={styles.input}
                      defaultValue={String(account.fiveHourReservePercent)}
                      max="100"
                      min="0"
                      name="fiveHourReservePercent"
                      type="number"
                    />
                  </label>
                  <label className={styles.fieldLabel}>
                    Reserve Floors · 1w
                    <input
                      className={styles.input}
                      defaultValue={String(account.sevenDayReservePercent)}
                      max="100"
                      min="0"
                      name="sevenDayReservePercent"
                      type="number"
                    />
                  </label>
                </div>
                <div className={styles.formActions}>
                  <button className={styles.actionButton} type="submit">Save Reserve Floors</button>
                </div>
              </form>
            ) : null}
          </article>
        ))}
      </div>
      {input.accounts.length === 0 ? <div className={styles.emptyState}>No connected pilot accounts found.</div> : null}
    </Section>
  );
}

export function EarningsSection(input: {
  summary: EarningsSummary | null;
  history: EarningsHistoryEntry[];
}) {
  return (
    <Section
      title="Earnings"
      hint="Contributor earnings are shown from the earnings ledger and grouped into pending, withdrawable, reserved, settled, and adjusted balances."
    >
      {input.summary ? (
        <div className={styles.heroStats}>
          <div className={styles.statCard}>
            <p className={styles.statLabel}>Pending</p>
            <p className={styles.statValue}>{formatUsdMinor(input.summary.pendingMinor)}</p>
          </div>
          <div className={styles.statCard}>
            <p className={styles.statLabel}>Withdrawable</p>
            <p className={styles.statValue}>{formatUsdMinor(input.summary.withdrawableMinor)}</p>
          </div>
          <div className={styles.statCard}>
            <p className={styles.statLabel}>Reserved</p>
            <p className={styles.statValue}>{formatUsdMinor(input.summary.reservedForPayoutMinor)}</p>
          </div>
          <div className={styles.statCard}>
            <p className={styles.statLabel}>Settled</p>
            <p className={styles.statValue}>{formatUsdMinor(input.summary.settledMinor)}</p>
          </div>
        </div>
      ) : (
        <div className={styles.emptyState}>No contributor earnings summary is available for this pilot account.</div>
      )}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Entry</th>
              <th>Bucket</th>
              <th>Amount</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {input.history.map((entry, index) => (
              <tr key={entry.id || entry.earnings_ledger_entry_id || String(index)}>
                <td>{entry.effect_type || 'ledger entry'}</td>
                <td>{entry.bucket || '--'}</td>
                <td>{formatUsdMinor(entry.amount_minor ?? null)}</td>
                <td>{formatTimestamp(entry.created_at ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {input.history.length === 0 ? <div className={styles.emptyState}>No earnings history yet.</div> : null}
    </Section>
  );
}

export function PilotWithdrawalsSection(input: {
  withdrawals: Withdrawal[];
  returnTo: string;
}) {
  return (
    <Section
      title="Withdrawals"
      hint="Create a withdrawal request and track status changes from requested through settlement."
    >
      <form action="/api/pilot/withdrawals" method="post">
        <input name="returnTo" type="hidden" value={input.returnTo} />
        <div className={styles.formGrid}>
          <label className={styles.fieldLabel}>
            Amount (minor units)
            <input className={styles.input} min="1" name="amountMinor" step="1" type="number" />
          </label>
          <label className={styles.fieldLabel}>
            Destination rail
            <input className={styles.input} defaultValue="manual_usdc" name="destinationRail" type="text" />
          </label>
          <label className={styles.fieldLabel}>
            Destination address
            <input className={styles.input} name="destinationAddress" type="text" />
          </label>
          <label className={styles.fieldLabel}>
            Note
            <input className={styles.input} name="note" type="text" />
          </label>
        </div>
        <div className={styles.formActions}>
          <button className={styles.actionButton} type="submit">Create Withdrawal</button>
        </div>
      </form>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Withdrawal</th>
              <th>Status</th>
              <th>Destination</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {input.withdrawals.map((withdrawal) => (
              <tr key={withdrawal.id}>
                <td>
                  <strong>{formatUsdMinor(withdrawal.amount_minor)}</strong>
                  <div className={styles.muted}>{withdrawal.id}</div>
                </td>
                <td>{withdrawal.status}</td>
                <td>{formatWithdrawalDestination(withdrawal)}</td>
                <td>{formatTimestamp(withdrawal.created_at ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {input.withdrawals.length === 0 ? <div className={styles.emptyState}>No withdrawals yet.</div> : null}
    </Section>
  );
}

export function AdminWithdrawalReviewSection(input: {
  withdrawals: Withdrawal[];
  returnTo: string;
}) {
  return (
    <Section
      title="Withdrawal Review"
      hint="Run review actions against the backend-owned pilot withdrawal workflow."
    >
      {input.withdrawals.length === 0 ? <div className={styles.emptyState}>No pilot withdrawals found for this account.</div> : null}
      <div className={styles.cardGrid}>
        {input.withdrawals.map((withdrawal) => (
          <article className={styles.identityCard} key={withdrawal.id}>
            <div className={styles.cardTitleRow}>
              <div>
                <h3 className={styles.cardTitle}>{formatUsdMinor(withdrawal.amount_minor)}</h3>
                <p className={styles.cardMeta}>{withdrawal.id} · {withdrawal.status}</p>
              </div>
              <span className={styles.pill}>{formatWithdrawalDestination(withdrawal)}</span>
            </div>
            <form action={`/api/admin/pilot/withdrawals/${encodeURIComponent(withdrawal.id)}`} method="post">
              <input name="returnTo" type="hidden" value={input.returnTo} />
              <div className={styles.formGrid}>
                <label className={styles.fieldLabel}>
                  Action
                  <select className={styles.select} defaultValue="approve" name="action">
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                    <option value="mark_settled">Mark settled</option>
                    <option value="mark_settlement_failed">Mark settlement failed</option>
                  </select>
                </label>
                <label className={styles.fieldLabel}>
                  Reason
                  <input className={styles.input} name="reason" type="text" />
                </label>
                <label className={styles.fieldLabel}>
                  Settlement reference
                  <input className={styles.input} name="settlementReference" type="text" />
                </label>
                <label className={styles.fieldLabel}>
                  Adjustment (minor)
                  <input className={styles.input} min="-99999999" name="adjustmentMinor" step="1" type="number" />
                </label>
              </div>
              <label className={styles.fieldLabel}>
                Adjustment / failure detail
                <textarea className={styles.textarea} name="adjustmentReason" />
              </label>
              <div className={styles.formActions}>
                <button className={styles.actionButton} type="submit">Submit Review Action</button>
              </div>
            </form>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function RequestExplanationSection(input: {
  request: RequestHistoryRow | null;
}) {
  if (!input.request) return null;

  return (
    <Section
      title="Request Explanation"
      hint="Expanded routing and money attribution pulled from the backend explanation endpoint."
    >
      <pre className={styles.codeBlock}>{JSON.stringify(input.request, null, 2)}</pre>
    </Section>
  );
}

export function PilotIdentityListSection(input: {
  identities: PilotIdentityDiscoveryEntry[];
}) {
  return (
    <Section
      title="Pilot Identities"
      hint="Admin identity discovery feeds the impersonation entry flow without guessing user or org ids."
    >
      <div className={styles.cardGrid}>
        {input.identities.map((identity) => (
          <article className={styles.identityCard} key={`${identity.targetOrgId}:${identity.targetUserId}`}>
            <div className={styles.cardTitleRow}>
              <div>
                <h3 className={styles.cardTitle}>{identity.displayName || identity.userEmail}</h3>
                <p className={styles.cardMeta}>{identity.targetOrgName || identity.targetOrgId}</p>
              </div>
              <span className={styles.pill}>{identity.targetOrgSlug || 'pilot'}</span>
            </div>
            <div className={styles.pillRow}>
              <span className={styles.pill}>{identity.userEmail}</span>
              {identity.githubLogin ? <span className={styles.pill}>{identity.githubLogin}</span> : null}
            </div>
            <div className={styles.formActions}>
              <Link className={styles.ghostButton} href={`/admin/pilot/accounts/${encodeURIComponent(identity.targetOrgId)}`}>
                View Account
              </Link>
              <form action="/api/admin/pilot/impersonate" method="post">
                <input name="targetUserId" type="hidden" value={identity.targetUserId} />
                <input name="targetOrgId" type="hidden" value={identity.targetOrgId} />
                <input name="targetOrgSlug" type="hidden" value={identity.targetOrgSlug || ''} />
                <input name="targetOrgName" type="hidden" value={identity.targetOrgName || ''} />
                <input name="githubLogin" type="hidden" value={identity.githubLogin || ''} />
                <input name="userEmail" type="hidden" value={identity.userEmail} />
                <button className={styles.actionButton} type="submit">Impersonate</button>
              </form>
            </div>
          </article>
        ))}
      </div>
      {input.identities.length === 0 ? <div className={styles.emptyState}>No pilot identities are available.</div> : null}
    </Section>
  );
}
