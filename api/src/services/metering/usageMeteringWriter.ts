import { UsageLedgerRepository, type UsageLedgerRow, type UsageLedgerWriteInput } from '../../repos/usageLedgerRepository.js';

export type MeteringEvent = Omit<UsageLedgerWriteInput, 'entryType' | 'sourceEventId'>;

export class UsageMeteringWriter {
  constructor(private readonly usageLedgerRepo: UsageLedgerRepository) {}

  async recordUsage(event: MeteringEvent): Promise<UsageLedgerRow> {
    return this.usageLedgerRepo.createUsageRow({
      ...event,
      entryType: 'usage'
    });
  }

  async recordCorrection(sourceEventId: string, event: MeteringEvent, note: string): Promise<UsageLedgerRow> {
    return this.usageLedgerRepo.createCorrectionRow({
      ...event,
      entryType: 'correction',
      sourceEventId,
      note
    });
  }

  async recordReversal(sourceEventId: string, event: MeteringEvent, note: string): Promise<UsageLedgerRow> {
    return this.usageLedgerRepo.createReversalRow({
      ...event,
      entryType: 'reversal',
      sourceEventId,
      note
    });
  }
}
