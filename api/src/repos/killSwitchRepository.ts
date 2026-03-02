import type { SqlClient, SqlValue } from './sqlClient.js';
import { newId } from '../utils/ids.js';

export type DisableScope = 'seller_key' | 'org' | 'model' | 'global';

export type KillSwitchInput = {
  scope: DisableScope;
  targetId: string;
  isDisabled: boolean;
  reason: string;
  triggeredBy?: string;
};

export class KillSwitchRepository {
  constructor(private readonly db: SqlClient) {}

  async createEvent(input: KillSwitchInput): Promise<{ id: string }> {
    const id = newId();
    const sql = `
      insert into hr_kill_switch_events (
        id,
        scope,
        target_id,
        is_disabled,
        reason,
        triggered_by,
        created_at
      ) values ($1,$2,$3,$4,$5,$6,now())
    `;

    const params: SqlValue[] = [
      id,
      input.scope,
      input.targetId,
      input.isDisabled,
      input.reason,
      input.triggeredBy ?? null
    ];

    await this.db.query(sql, params);
    return { id };
  }

  async isDisabled(scope: DisableScope, targetId: string): Promise<boolean> {
    const sql = `
      select is_disabled
      from hr_kill_switch_current
      where scope = $1 and target_id = $2
      limit 1
    `;
    const result = await this.db.query<{ is_disabled: boolean }>(sql, [scope, targetId]);
    return result.rowCount === 1 ? result.rows[0].is_disabled : false;
  }
}
