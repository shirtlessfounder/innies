import assert from 'node:assert/strict';
import test from 'node:test';

test('invite acceptance error mapping keeps invite_no_longer_valid special handling and drops the obsolete single-org rewrite', async () => {
  const { getInviteAcceptanceErrorMessage } = await import('../src/components/org/inviteAcceptanceError.ts');

  assert.equal(
    getInviteAcceptanceErrorMessage(
      { kind: 'invite_no_longer_valid' },
      'fallback',
    ),
    'This invite is no longer valid.',
  );
  assert.equal(
    getInviteAcceptanceErrorMessage(
      { code: 'invite_no_longer_valid' },
      'fallback',
    ),
    'This invite is no longer valid.',
  );
  assert.equal(
    getInviteAcceptanceErrorMessage(
      { message: 'User already has an active org: beta' },
      'fallback',
    ),
    'User already has an active org: beta',
  );
  assert.equal(
    getInviteAcceptanceErrorMessage(null, 'fallback'),
    'fallback',
  );
});
