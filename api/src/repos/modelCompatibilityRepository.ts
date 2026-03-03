import type { SqlClient } from './sqlClient.js';

export type ModelCompatibilityRule = {
  id: string;
  provider: string;
  model: string;
  supports_streaming: boolean;
  supports_tools: boolean;
  is_enabled: boolean;
};

export class ModelCompatibilityRepository {
  constructor(private readonly db: SqlClient) {}

  async findActive(provider: string, model: string, now: Date = new Date()): Promise<ModelCompatibilityRule | null> {
    const sql = `
      select id, provider, model, supports_streaming, supports_tools, is_enabled
      from in_model_compatibility_rules
      where provider = $1
        and model = $2
        and is_enabled = true
        and effective_from <= $3
        and (effective_to is null or effective_to > $3)
      order by effective_from desc
      limit 1
    `;

    const result = await this.db.query<ModelCompatibilityRule>(sql, [provider, model, now]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}
