import type { WalletEffectType } from '../../types/phase2Contracts.js';

export function walletIdForOrgId(orgId: string): string {
  return orgId;
}

export function walletBalanceImpact(input: {
  effectType: WalletEffectType;
  amountMinor: number;
}): number {
  switch (input.effectType) {
    case 'manual_credit':
    case 'payment_credit':
      return input.amountMinor;
    case 'buyer_debit':
    case 'buyer_correction':
    case 'buyer_reversal':
    case 'manual_debit':
    case 'payment_reversal':
      return input.amountMinor * -1;
  }
}
