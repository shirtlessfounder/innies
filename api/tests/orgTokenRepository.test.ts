import { describe, expect, it } from 'vitest';
import { OrgTokenRepository } from '../src/repos/orgTokenRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('OrgTokenRepository', () => {
  it('lists org token inventory with creator attribution and reserve percentages', async () => {
    const db = new MockSqlClient({
      rows: [{
        token_id: 'token_1',
        provider: 'anthropic',
        created_by_user_id: 'user_1',
        created_by_github_login: 'shirtlessfounder',
        five_hour_reserve_percent: 12,
        seven_day_reserve_percent: 34
      }],
      rowCount: 1
    });
    const repo = new OrgTokenRepository(db);

    expect(await repo.listOrgTokens('org_1')).toEqual([{
      tokenId: 'token_1',
      provider: 'anthropic',
      createdByUserId: 'user_1',
      createdByGithubLogin: 'shirtlessfounder',
      fiveHourReservePercent: 12,
      sevenDayReservePercent: 34
    }]);
    expect(db.queries[0]?.sql).toContain('five_hour_reserve_percent');
    expect(db.queries[0]?.sql).toContain('seven_day_reserve_percent');
  });

  it('lists member tokens and removes member tokens by org and creator', async () => {
    const listDb = new MockSqlClient({
      rows: [{ token_id: 'token_1', provider: 'anthropic' }],
      rowCount: 1
    });
    const listRepo = new OrgTokenRepository(listDb);

    expect(await listRepo.listMemberTokens('org_1', 'user_1')).toEqual([{
      tokenId: 'token_1',
      provider: 'anthropic'
    }]);
    expect(listDb.queries[0]?.sql).toContain('created_by = $2');

    const removeDb = new MockSqlClient({ rows: [], rowCount: 2 });
    const removeRepo = new OrgTokenRepository(removeDb);

    expect(await removeRepo.removeMemberTokens(removeDb, 'org_1', 'user_1')).toBe(2);
    expect(removeDb.queries[0]?.sql).toContain('update in_token_credentials');
    expect(removeDb.queries[0]?.sql).toContain("status = 'revoked'");
    expect(removeDb.queries[0]?.params).toEqual(['org_1', 'user_1']);
  });
});
