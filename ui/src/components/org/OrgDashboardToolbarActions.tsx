'use client';

import Link from 'next/link';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import analyticsStyles from '../../app/analytics/page.module.css';
import type { OrgDashboardPageState } from '../../lib/org/types';
import { OrgModalShell } from './OrgModalShell';

type ToolbarView = 'analytics' | 'management';

type OrgDashboardToolbarActionsProps = Pick<OrgDashboardPageState, 'org' | 'membership'> & {
  view: ToolbarView;
};

type ActiveModal = 'token' | 'invite' | 'leave' | null;

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

export function OrgDashboardToolbarActions(input: OrgDashboardToolbarActionsProps) {
  const { membership, org, view } = input;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [pendingAction, setPendingAction] = useState<'add-token' | 'invite-member' | 'leave-org' | null>(null);
  const modalOpen = activeModal !== null;
  const inviteEnabled = membership.isOwner && view === 'management';

  function closeModal() {
    if (pendingAction) return;
    setError(null);
    setActiveModal(null);
  }

  function openTokenModal() {
    setError(null);
    setActiveModal('token');
  }

  function openInviteModal() {
    setError(null);
    setActiveModal('invite');
  }

  function openLeaveModal() {
    setError(null);
    setActiveModal('leave');
  }

  useEffect(() => {
    function handleOpenRequest() {
      openTokenModal();
    }

    globalThis.addEventListener('innies:add-token-modal', handleOpenRequest);
    return () => globalThis.removeEventListener('innies:add-token-modal', handleOpenRequest);
  }, []);

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
    const debugLabel = String(formData.get('debugLabel') ?? '').trim();
    const token = String(formData.get('token') ?? '').trim();
    const refreshToken = String(formData.get('refreshToken') ?? '').trim();
    if (!provider || !debugLabel || !token || !refreshToken) {
      setError('Provider, debug label, oauth token, and refresh token are required.');
      return;
    }

    setPendingAction('add-token');
    setError(null);

    try {
      const response = await fetch(`/api/orgs/${org.slug}/tokens/add`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider,
          debugLabel,
          token,
          refreshToken,
          ...(fiveHourReservePercent === undefined ? {} : { fiveHourReservePercent }),
          ...(sevenDayReservePercent === undefined ? {} : { sevenDayReservePercent }),
        }),
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setError(readErrorMessage(body, 'Could not add this token.'));
        return;
      }

      setActiveModal(null);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not add this token.');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleInviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!membership.isOwner || pendingAction) return;

    const formData = new FormData(event.currentTarget);
    const githubLogin = String(formData.get('githubLogin') ?? '').trim();
    if (!githubLogin) {
      setError('GitHub username is required.');
      return;
    }

    setPendingAction('invite-member');
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
        setError('That GitHub username is already a member.');
        return;
      }

      setActiveModal(null);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create this invite.');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleLeaveOrg() {
    if (membership.isOwner || pendingAction) return;

    setPendingAction('leave-org');
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

      setActiveModal(null);
      router.push(redirectTo);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not leave this org.');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <button
        className={analyticsStyles.controlButton}
        onClick={openTokenModal}
        type="button"
      >
        ADD TOKEN
      </button>

      {inviteEnabled ? (
        <button className={analyticsStyles.controlButton} onClick={openInviteModal} type="button">
          INVITE MEMBER
        </button>
      ) : membership.isOwner ? (
        <button className={analyticsStyles.controlButton} disabled type="button">
          LEAVE ORG
        </button>
      ) : (
        <button className={analyticsStyles.controlButton} onClick={openLeaveModal} type="button">
          LEAVE ORG
        </button>
      )}

      {modalOpen ? (
        <OrgModalShell
          dismissOnBackdrop
          dismissOnEscape
          eyebrow={activeModal === 'token' ? 'Add token' : activeModal === 'invite' ? 'Invite member' : 'Leave org'}
          onRequestClose={closeModal}
          title={
            activeModal === 'token'
              ? `add token to ${org.slug}`
              : activeModal === 'invite'
                ? `invite member to ${org.slug}`
                : `leave ${org.slug}`
          }
        >
          {activeModal === 'token' ? (
            <>
              <div className={analyticsStyles.noticeList}>
                <div className={analyticsStyles.noticeText}>
                  <Link className={analyticsStyles.modalInlineLink} href="/onboard">
                    Click here for guide to obtain tokens.
                  </Link>
                </div>
                {error ? <div className={analyticsStyles.noticeError}>{error}</div> : null}
              </div>

              <form className={analyticsStyles.modalFormStack} onSubmit={handleAddToken}>
                <label className={analyticsStyles.managementField}>
                  <span>Provider *</span>
                  <select className={analyticsStyles.managementSelect} defaultValue="anthropic" name="provider" required>
                    <option value="anthropic">Claude</option>
                    <option value="openai">Codex</option>
                  </select>
                </label>

                <label className={analyticsStyles.managementField}>
                  <span>Debug label *</span>
                  <input
                    className={analyticsStyles.managementInput}
                    name="debugLabel"
                    placeholder="testing-test-claude-main"
                    required
                    type="text"
                  />
                </label>

                <label className={analyticsStyles.managementField}>
                  <span>OAuth token *</span>
                  <input className={analyticsStyles.managementInput} name="token" placeholder="Paste oauth token" required type="password" />
                </label>

                <label className={analyticsStyles.managementField}>
                  <span>Refresh token *</span>
                  <input className={analyticsStyles.managementInput} name="refreshToken" placeholder="Paste refresh token" required type="password" />
                </label>

                <div className={analyticsStyles.modalFormPair}>
                  <label className={analyticsStyles.managementField}>
                    <span>5h reserve %</span>
                    <input
                      className={analyticsStyles.managementInput}
                      inputMode="numeric"
                      max={100}
                      min={0}
                      name="fiveHourReservePercent"
                      placeholder="For you only"
                      type="number"
                    />
                  </label>

                  <label className={analyticsStyles.managementField}>
                    <span>1w reserve %</span>
                    <input
                      className={analyticsStyles.managementInput}
                      inputMode="numeric"
                      max={100}
                      min={0}
                      name="sevenDayReservePercent"
                      placeholder="For you only"
                      type="number"
                    />
                  </label>
                </div>

                <div className={analyticsStyles.managementActionRow}>
                  <button className={analyticsStyles.managementPrimaryButton} disabled={pendingAction === 'add-token'} type="submit">
                    {pendingAction === 'add-token' ? 'Adding token...' : 'Add token'}
                  </button>
                </div>
              </form>
            </>
          ) : activeModal === 'invite' ? (
            <>
              <div className={analyticsStyles.noticeList}>
                <div className={analyticsStyles.noticeText}>
                  Invite a GitHub username to this org. They will see the invite the next time they open this org route.
                </div>
                {error ? <div className={analyticsStyles.noticeError}>{error}</div> : null}
              </div>

              <form className={analyticsStyles.modalFormStack} onSubmit={handleInviteMember}>
                <label className={analyticsStyles.managementField}>
                  <span>GitHub username *</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    className={analyticsStyles.managementInput}
                    name="githubLogin"
                    placeholder="octocat"
                    required
                    spellCheck={false}
                    type="text"
                  />
                </label>

                <div className={analyticsStyles.managementActionRow}>
                  <button className={analyticsStyles.managementPrimaryButton} disabled={pendingAction === 'invite-member'} type="submit">
                    {pendingAction === 'invite-member' ? 'Inviting...' : 'Create invite'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className={analyticsStyles.noticeList}>
                <div className={analyticsStyles.noticeText}>
                  Remove yourself from this org if you no longer need access.
                </div>
                {error ? <div className={analyticsStyles.noticeError}>{error}</div> : null}
              </div>

              <div className={analyticsStyles.managementActionRow}>
                <button
                  className={analyticsStyles.managementSecondaryButton}
                  disabled={pendingAction === 'leave-org'}
                  onClick={handleLeaveOrg}
                  type="button"
                >
                  {pendingAction === 'leave-org' ? 'Leaving...' : 'Leave org'}
                </button>
              </div>
            </>
          )}
        </OrgModalShell>
      ) : null}
    </>
  );
}
