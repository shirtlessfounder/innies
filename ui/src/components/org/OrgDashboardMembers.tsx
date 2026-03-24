'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './orgDashboard.module.css';
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

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!membership.isOwner || pendingAction) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const githubLogin = String(formData.get('githubLogin') ?? '').trim();
    if (!githubLogin) {
      setError('GitHub login is required.');
      return;
    }

    setPendingAction('invite');
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/invites`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ githubLogin }),
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not create this invite.'));
        return;
      }

      if (body && typeof body === 'object' && (body as Record<string, unknown>).kind === 'already_a_member') {
        setError('That GitHub login is already a member.');
        return;
      }

      form.reset();
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create this invite.');
    } finally {
      setPendingAction(null);
    }
  }

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

  async function leaveOrg() {
    if (membership.isOwner || pendingAction) return;

    setPendingAction('leave');
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/leave`, {
        method: 'POST',
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not leave this org.'));
        return;
      }

      const redirectTo = body && typeof body === 'object' && typeof (body as Record<string, unknown>).redirectTo === 'string'
        ? String((body as Record<string, unknown>).redirectTo)
        : '/';
      router.push(redirectTo);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not leave this org.');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>Members</h2>
          <p className={styles.sectionHint}>
            All active members can see the roster. Owners can create or revoke pending invites and remove members directly from this org surface.
          </p>
        </div>
      </div>

      {error ? <p className={styles.errorBox}>{error}</p> : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>GitHub</th>
              <th>Role</th>
              <th>Membership</th>
              <th>Actions</th>
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
                  <td>
                    {canRemove ? (
                        <button
                          className={styles.inlineButton}
                          disabled={pendingAction === `remove:${member.userId}`}
                          onClick={() => removeMember(member)}
                          type="button"
                        >
                        Remove
                      </button>
                    ) : (
                      <span className={styles.muted}>{member.isOwner ? 'Owner' : 'Active'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {membership.isOwner ? (
        <>
          <form className={styles.cardGrid} onSubmit={handleInvite}>
            <label className={styles.fieldLabel}>
              Invite GitHub login
              <input className={styles.input} name="githubLogin" placeholder="octocat" required type="text" />
            </label>
            <div className={styles.formActions}>
              <button className={styles.actionButton} disabled={pendingAction === 'invite'} type="submit">
                {pendingAction === 'invite' ? 'Inviting...' : 'Create invite'}
              </button>
            </div>
          </form>

          <div className={styles.subsection}>
            <h3 className={styles.cardTitle}>Pending invites</h3>
            {pendingInvites.length === 0 ? (
              <div className={styles.emptyState}>No pending invites.</div>
            ) : (
              <ul className={styles.inviteList}>
                {pendingInvites.map((invite) => (
                  <li className={styles.listRow} key={invite.inviteId}>
                    <div>
                      <strong>{invite.githubLogin}</strong>
                      <div className={styles.muted}>{invite.createdAt}</div>
                    </div>
                    <button
                      className={styles.inlineButton}
                      disabled={pendingAction === `revoke:${invite.inviteId}`}
                      onClick={() => revokeInvite(invite.inviteId)}
                      type="button"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className={styles.subsection}>
          <h3 className={styles.cardTitle}>Leave org</h3>
          <p className={styles.cardMeta}>Owners cannot use the leave flow in MVP.</p>
          <button className={styles.actionButton} disabled={pendingAction === 'leave'} onClick={leaveOrg} type="button">
            Leave org
          </button>
        </div>
      )}

      {membership.isOwner ? (
        <div className={styles.subsection}>
          <h3 className={styles.cardTitle}>Leave org</h3>
          <p className={styles.cardMeta}>The owner cannot use the leave flow in MVP.</p>
        </div>
      ) : null}
    </section>
  );
}
