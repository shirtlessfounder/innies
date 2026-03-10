import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type UsageEntryType = 'usage' | 'correction' | 'reversal';

export type UsageLedgerWriteInput = {
  entryType?: UsageEntryType;
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId?: string;
  sellerKeyId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usageUnits: number;
  retailEquivalentMinor: number;
  currency?: string;
  sourceEventId?: string;
  note?: string;
};

export type UsageLedgerRow = {
  id: string;
  entry_type: UsageEntryType;
  request_id: string;
  attempt_no: number;
  org_id: string;
  api_key_id: string | null;
  seller_key_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  usage_units: number;
  retail_equivalent_minor: number;
  currency: string;
  source_event_id: string | null;
  note: string | null;
  created_at: string;
};

export class UsageLedgerRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  createUsageRow(input: UsageLedgerWriteInput): Promise<UsageLedgerRow> {
    return this.insertEntry({ ...input, entryType: input.entryType ?? 'usage' });
  }

  createCorrectionRow(input: UsageLedgerWriteInput & { sourceEventId: string }): Promise<UsageLedgerRow> {
    return this.insertEntry({ ...input, entryType: 'correction' });
  }

  createReversalRow(input: UsageLedgerWriteInput & { sourceEventId: string }): Promise<UsageLedgerRow> {
    return this.insertEntry({ ...input, entryType: 'reversal' });
  }

  async withTransaction<T>(run: (repo: UsageLedgerRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => {
      const transactionalRepo = new UsageLedgerRepository(txClient(tx));
      return run(transactionalRepo);
    });
  }

  private async insertEntry(input: UsageLedgerWriteInput): Promise<UsageLedgerRow> {
    const entryType = input.entryType ?? 'usage';

    if (entryType !== 'usage' && !input.sourceEventId) {
      throw new Error(`${entryType} rows require sourceEventId`);
    }

    if (entryType === 'usage' && input.sourceEventId) {
      throw new Error('usage rows cannot set sourceEventId');
    }

    const sql = `
      insert into ${TABLES.usageLedger} (
        id,
        entry_type,
        request_id,
        attempt_no,
        org_id,
        api_key_id,
        seller_key_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        usage_units,
        retail_equivalent_minor,
        currency,
        source_event_id,
        note
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )
      on conflict on constraint uq_hr_usage_primary_once do nothing
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      entryType,
      input.requestId,
      input.attemptNo,
      input.orgId,
      input.apiKeyId ?? null,
      input.sellerKeyId ?? null,
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.usageUnits,
      input.retailEquivalentMinor,
      input.currency ?? 'USD',
      input.sourceEventId ?? null,
      input.note ?? null
    ];

    const result = await this.db.query<UsageLedgerRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one usage_ledger row to be inserted');
    }

    return result.rows[0];
  }
}

function txClient(tx: TransactionContext): SqlClient {
  return {
    query: (sql, params) => tx.query(sql, params),
    transaction: async (run) => run(tx)
  };
}
