import { describe, expect, it } from 'vitest';
import { FnfOwnershipRepository } from '../src/repos/fnfOwnershipRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('FnfOwnershipRepository', () => {
  it('upserts buyer-key ownership mappings against in_api_keys', async () => {
    const db = new MockSqlClient({
      rows: [{ api_key_id: 'buyer_1', owner_org_id: 'org_fnf' }],
      rowCount: 1
    });
    const repo = new FnfOwnershipRepository(db);

    await repo.upsertBuyerKeyOwnership({
      apiKeyId: 'buyer_1',
      ownerOrgId: 'org_fnf',
      ownerUserId: 'user_darryn'
    });

    expect(db.queries[0].sql).toContain('insert into in_fnf_api_key_ownership');
    expect(db.queries[0].sql).toContain('on conflict (api_key_id)');
    expect(db.queries[0].params).toContain('buyer_1');
    expect(db.queries[0].params).toContain('user_darryn');
  });

  it('upserts provider-credential ownership mappings against in_token_credentials', async () => {
    const db = new MockSqlClient({
      rows: [{ token_credential_id: 'cred_1', owner_org_id: 'org_fnf' }],
      rowCount: 1
    });
    const repo = new FnfOwnershipRepository(db);

    await repo.upsertTokenCredentialOwnership({
      tokenCredentialId: 'cred_1',
      ownerOrgId: 'org_fnf',
      capacityOwnerUserId: 'user_darryn'
    });

    expect(db.queries[0].sql).toContain('insert into in_fnf_token_credential_ownership');
    expect(db.queries[0].sql).toContain('on conflict (token_credential_id)');
    expect(db.queries[0].params).toContain('cred_1');
    expect(db.queries[0].params).toContain('user_darryn');
  });
});
