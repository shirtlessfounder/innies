'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import analyticsStyles from '../../app/analytics/page.module.css';
import { formatCount, formatTimestamp } from '../../lib/analytics/present';
import type { OrgDashboardPageState } from '../../lib/org/types';

type OrgDashboardMembersProps = Pick<
  OrgDashboardPageState,
  'org' | 'membership' | 'members' | 'pendingInvites'
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

export function OrgDashboardMembers(input: OrgDashboardMembersProps) {
  const { members, membership, org, pendingInvites } = input;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  async function revokeInvite(inviteId: string) {
    if (!membership.isOwner || pendingAction) return;

    setPendingAction(`revoke:${inviteId}`);
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/invites/revoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ inviteId }),
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not revoke this invite.'));
        return;
      }

      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not revoke this invite.');
    } finally {
      setPendingAction(null);
    }
  }

  async function removeMember(member: { userId: string }) {
    if (!membership.isOwner || pendingAction) return;

    setPendingAction(`remove:${member.userId}`);
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/members/${member.userId}/remove`, {
        method: 'POST',
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not remove this member.'));
        return;
      }

      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not remove this member.');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className={analyticsStyles.section}>
      <div className={analyticsStyles.sectionHeader}>
        <div className={analyticsStyles.sectionTitle}>Members</div>
        <div className={analyticsStyles.sectionMeta}>
          {`${formatCount(members.length)} MEMBERS`}
        </div>
      </div>

      {error ? (
        <div className={analyticsStyles.noticeList}>
          <div className={analyticsStyles.noticeError}>{error}</div>
        </div>
      ) : null}

      <div className={analyticsStyles.tableWrap}>
        <table className={analyticsStyles.table}>
          <thead>
            <tr>
              <th>GitHub</th>
              <th>Role</th>
              <th>Membership</th>
              <th className={analyticsStyles.tableActionsColumn}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const canRemove = membership.isOwner
                && member.membershipId !== membership.membershipId
                && !member.isOwner;
              return (
                <tr key={member.membershipId}>
                  <td>{member.githubLogin ?? '--'}</td>
                  <td>{member.isOwner ? 'Owner' : 'Member'}</td>
                  <td>{member.membershipId}</td>
                  <td className={analyticsStyles.tableActionsColumn}>
                    {canRemove ? (
                        <button
                          className={analyticsStyles.managementTableActionButton}
                          disabled={pendingAction === `remove:${member.userId}`}
                          onClick={() => removeMember(member)}
                          type="button"
                        >
                        [remove]
                      </button>
                    ) : (
                      null
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {membership.isOwner ? (
        <div className={analyticsStyles.managementSubsection}>
          <div className={analyticsStyles.sectionHeader}>
            <div className={analyticsStyles.managementSubsectionTitle}>Pending invites</div>
            <div className={analyticsStyles.sectionMeta}>
              {`${formatCount(pendingInvites.length)} PENDING`}
            </div>
          </div>
          {pendingInvites.length === 0 ? (
            <div className={analyticsStyles.emptyStateText}>No pending invites.</div>
          ) : (
            <div className={analyticsStyles.tableWrap}>
              <table className={analyticsStyles.table}>
                <thead>
                  <tr>
                    <th>GitHub</th>
                    <th>Created</th>
                    <th className={analyticsStyles.tableActionsColumn}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingInvites.map((invite) => (
                    <tr key={invite.inviteId}>
                      <td>{invite.githubLogin}</td>
                      <td>{formatTimestamp(invite.createdAt)}</td>
                      <td className={analyticsStyles.tableActionsColumn}>
                        <button
                          className={analyticsStyles.managementTableActionButton}
                          disabled={pendingAction === `revoke:${invite.inviteId}`}
                          onClick={() => revokeInvite(invite.inviteId)}
                          type="button"
                        >
                          [revoke]
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

    </section>
  );
}
