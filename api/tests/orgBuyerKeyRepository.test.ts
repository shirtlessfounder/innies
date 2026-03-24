import { describe, expect, it } from 'vitest';
import { OrgBuyerKeyRepository } from '../src/repos/orgBuyerKeyRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('OrgBuyerKeyRepository', () => {
  it('creates one active buyer key per membership with membership and user attribution', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'api_key_1' }],
      rowCount: 1
    });
    const repo = new OrgBuyerKeyRepository(
      db,
      () => 'api_key_1',
      () => 'in_live_plaintext_key'
    );

    expect(await repo.createMembershipBuyerKey(db, {
      membershipId: 'membership_1',
      orgId: 'org_1',
      userId: 'user_1'
    })).toEqual({
      apiKeyId: 'api_key_1',
      plaintextKey: 'in_live_plaintext_key'
    });
    expect(db.queries[0]?.sql).toContain('insert into in_api_keys');
    expect(db.queries[0]?.params?.[2]).toBe('membership_1');
    expect(db.queries[0]?.params?.[5]).toBe('buyer_proxy');
    expect(db.queries[0]?.params?.[6]).toBe('user_1');
    expect(db.queries[0]?.params?.[4]).not.toBe('in_live_plaintext_key');
  });

  it('revokes the active membership buyer key idempotently', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 1 });
    const repo = new OrgBuyerKeyRepository(db);

    await repo.revokeMembershipBuyerKey(db, 'membership_1');

    expect(db.queries[0]?.sql).toContain('update in_api_keys');
    expect(db.queries[0]?.sql).toContain('revoked_at = now()');
    expect(db.queries[0]?.params).toEqual(['membership_1']);
  });

  it('rotates a membership buyer key by revoking then creating a replacement', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 1 },
      { rows: [{ id: 'api_key_2' }], rowCount: 1 }
    ]);
    const repo = new OrgBuyerKeyRepository(
      db,
      () => 'api_key_2',
      () => 'in_live_rotated_key'
    );

    expect(await repo.rotateMembershipBuyerKey({
      membershipId: 'membership_1',
      orgId: 'org_1',
      userId: 'user_1'
    })).toEqual({
      apiKeyId: 'api_key_2',
      plaintextKey: 'in_live_rotated_key'
    });
    expect(db.queries).toHaveLength(2);
  });

  it('lists org buyer keys with membership and github attribution', async () => {
    const db = new MockSqlClient({
      rows: [{
        api_key_id: 'api_key_1',
        membership_id: 'membership_1',
        user_id: 'user_1',
        github_login: 'shirtlessfounder',
        revoked_at: null
      }],
      rowCount: 1
    });
    const repo = new OrgBuyerKeyRepository(db);

    expect(await repo.listOrgKeysWithMembers('org_1')).toEqual([{
      apiKeyId: 'api_key_1',
      membershipId: 'membership_1',
      userId: 'user_1',
      githubLogin: 'shirtlessfounder',
      revokedAt: null
    }]);
    expect(db.queries[0]?.sql).toContain('left join in_users');
  });
});
