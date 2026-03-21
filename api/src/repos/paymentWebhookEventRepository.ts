import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type PaymentWebhookClaimResult = {
  state: 'claimed' | 'pending_retry' | 'already_processed';
  processorEventId: string;
};

type PaymentWebhookEventStateRow = {
  processed_at: string | null;
};

export class PaymentWebhookEventRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async claimEvent(input: {
    processor?: string;
    processorEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<PaymentWebhookClaimResult> {
    const sql = `
      insert into ${TABLES.paymentWebhookEvents} (
        id,
        processor,
        processor_event_id,
        event_type,
        payload
      ) values (
        $1,$2,$3,$4,$5
      )
      on conflict (processor_event_id) do nothing
      returning id
    `;
    const params: SqlValue[] = [
      this.createId(),
      input.processor ?? 'stripe',
      input.processorEventId,
      input.eventType,
      JSON.stringify(input.payload)
    ];
    const result = await this.db.query<{ id: string }>(sql, params);
    if (result.rowCount === 1) {
      return {
        state: 'claimed',
        processorEventId: input.processorEventId
      };
    }

    const existing = await this.db.query<PaymentWebhookEventStateRow>(`
      select processed_at
      from ${TABLES.paymentWebhookEvents}
      where processor_event_id = $1
      limit 1
    `, [input.processorEventId]);
    const row = existing.rows[0];
    return {
      state: row?.processed_at ? 'already_processed' : 'pending_retry',
      processorEventId: input.processorEventId
    };
  }

  async markProcessed(processorEventId: string): Promise<void> {
    const sql = `
      update ${TABLES.paymentWebhookEvents}
      set processed_at = now()
      where processor_event_id = $1
    `;
    await this.db.query(sql, [processorEventId]);
  }
}
