import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type ReconciliationInput = {
  runDate: string;
  provider: string;
  expectedUnits: number;
  actualUnits: number;
  deltaMinor?: number;
  notes?: string;
};

export type ReconciliationWriteResult = {
  id: string;
  status: 'ok' | 'warn' | 'breach';
  deltaPct: number;
};

export class ReconciliationRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async upsertRun(input: ReconciliationInput): Promise<ReconciliationWriteResult> {
    const deltaUnits = Math.abs(input.expectedUnits - input.actualUnits);
    const deltaPct = input.expectedUnits === 0 ? 0 : deltaUnits / input.expectedUnits;
    const status: ReconciliationWriteResult['status'] =
      deltaPct <= 0.01 ? 'ok' : deltaPct <= 0.02 ? 'warn' : 'breach';

    const sql = `
      insert into ${TABLES.reconciliationRuns} (
        id,
        run_date,
        provider,
        status,
        expected_units,
        actual_units,
        delta_units,
        delta_pct,
        delta_minor,
        notes,
        created_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      on conflict (run_date, provider)
      do update set
        status = excluded.status,
        expected_units = excluded.expected_units,
        actual_units = excluded.actual_units,
        delta_units = excluded.delta_units,
        delta_pct = excluded.delta_pct,
        delta_minor = excluded.delta_minor,
        notes = excluded.notes
      returning id, status, delta_pct
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.runDate,
      input.provider,
      status,
      input.expectedUnits,
      input.actualUnits,
      deltaUnits,
      deltaPct,
      input.deltaMinor ?? null,
      input.notes ?? null
    ];

    const result = await this.db.query<{ id: string; status: ReconciliationWriteResult['status']; delta_pct: number }>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one reconciliation run upsert');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      status: row.status,
      deltaPct: row.delta_pct
    };
  }
}
