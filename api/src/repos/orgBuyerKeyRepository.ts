import { randomBytes } from 'node:crypto';
import type { SqlClient, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { sha256Hex } from '../utils/hash.js';

type KeyFactory = () => string;

function generateBuyerKey(): string {
  return `in_live_${randomBytes(24).toString('base64url')}`;
}

function buildMembershipBuyerKeyName(membershipId: string): string {
  return `membership:${membershipId}`;
}

export class OrgBuyerKeyRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4,
    private readonly generateKey: KeyFactory = generateBuyerKey
  ) {}

  async createMembershipBuyerKey(
    tx: TransactionContext,
    input: { membershipId: string; orgId: string; userId: string }
  ): Promise<{ apiKeyId: string; plaintextKey: string }> {
    const id = this.createId();
    const plaintextKey = this.generateKey();
    const keyHash = sha256Hex(plaintextKey);
    const keyName = buildMembershipBuyerKeyName(input.membershipId);

    await tx.query(
      `insert into in_api_keys (id, org_id, name, membership_id, is_active, key_hash, scope, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.orgId, keyName, input.membershipId, true, keyHash, 'buyer_proxy', input.userId]
    );

    return { apiKeyId: id, plaintextKey };
  }

  async revokeMembershipBuyerKey(
    tx: TransactionContext,
    membershipId: string
  ): Promise<void> {
    await tx.query(
      `update in_api_keys set revoked_at = now() where membership_id = $1 and revoked_at is null`,
      [membershipId]
    );
  }

  async rotateMembershipBuyerKey(input: {
    membershipId: string;
    orgId: string;
    userId: string;
  }): Promise<{ apiKeyId: string; plaintextKey: string }> {
    await this.revokeMembershipBuyerKey(this.db, input.membershipId);
    return this.createMembershipBuyerKey(this.db, input);
  }

  async listOrgKeysWithMembers(orgId: string): Promise<Array<{
    apiKeyId: string;
    membershipId: string;
    userId: string;
    githubLogin: string;
    revokedAt: string | null;
  }>> {
    const result = await this.db.query<{
      api_key_id: string;
      membership_id: string;
      user_id: string;
      github_login: string;
      revoked_at: string | null;
    }>(
      `select
        k.id as api_key_id,
        k.membership_id,
        membership.user_id,
        u.github_login,
        k.revoked_at
      from in_api_keys k
      join in_memberships membership on membership.id = k.membership_id
      left join in_users u on u.id = membership.user_id
      where k.org_id = $1
        and k.membership_id is not null
      order by k.created_at asc`,
      [orgId]
    );
    return result.rows.map((row) => ({
      apiKeyId: row.api_key_id,
      membershipId: row.membership_id,
      userId: row.user_id,
      githubLogin: row.github_login,
      revokedAt: row.revoked_at
    }));
  }
}
