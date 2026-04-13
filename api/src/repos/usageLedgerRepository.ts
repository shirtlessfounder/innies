import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';

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
      on conflict (org_id, request_id, attempt_no) where entry_type = 'usage' do nothing
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
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = entryType === 'usage'
      ? await this.findExistingUsageRow({
          requestId: input.requestId,
          attemptNo: input.attemptNo,
          orgId: input.orgId
        })
      : null;
    if (!existing) {
      throw new Error('expected one usage_ledger row to be inserted');
    }

    assertUsageLedgerReplayMatches(input, existing);
    return existing;
  }

  private async findExistingUsageRow(input: {
    requestId: string;
    attemptNo: number;
    orgId: string;
  }): Promise<UsageLedgerRow | null> {
    const sql = `
      select *
      from ${TABLES.usageLedger}
      where org_id = $1
        and request_id = $2
        and attempt_no = $3
        and entry_type = 'usage'
      limit 1
    `;
    const result = await this.db.query<UsageLedgerRow>(sql, [
      input.orgId,
      input.requestId,
      input.attemptNo
    ]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

function txClient(tx: TransactionContext): SqlClient {
  return {
    query: (sql, params) => tx.query(sql, params),
    transaction: async (run) => run(tx)
  };
}

function assertUsageLedgerReplayMatches(input: UsageLedgerWriteInput, row: UsageLedgerRow): void {
  assertIdempotentReplayMatches('usage ledger', [
    { field: 'entryType', expected: input.entryType ?? 'usage', actual: row.entry_type },
    { field: 'requestId', expected: input.requestId, actual: row.request_id },
    { field: 'attemptNo', expected: input.attemptNo, actual: row.attempt_no },
    { field: 'orgId', expected: input.orgId, actual: row.org_id },
    { field: 'apiKeyId', expected: input.apiKeyId ?? null, actual: row.api_key_id },
    { field: 'sellerKeyId', expected: input.sellerKeyId ?? null, actual: row.seller_key_id },
    { field: 'provider', expected: input.provider, actual: row.provider },
    { field: 'model', expected: input.model, actual: row.model },
    { field: 'inputTokens', expected: input.inputTokens, actual: row.input_tokens },
    { field: 'outputTokens', expected: input.outputTokens, actual: row.output_tokens },
    { field: 'usageUnits', expected: input.usageUnits, actual: row.usage_units },
    { field: 'retailEquivalentMinor', expected: input.retailEquivalentMinor, actual: row.retail_equivalent_minor },
    { field: 'currency', expected: input.currency ?? 'USD', actual: row.currency },
    { field: 'sourceEventId', expected: input.sourceEventId ?? null, actual: row.source_event_id },
    { field: 'note', expected: input.note ?? null, actual: row.note }
  ]);
}
