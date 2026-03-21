import type { WalletEffectType } from '../../types/phase2Contracts.js';

export type PaymentProcessor = 'stripe';

export type StoredPaymentMethodStatus = 'active' | 'detached';

export type PaymentAttemptKind = 'manual_topup' | 'auto_recharge';

export type PaymentAttemptStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export type AutoRechargeTrigger = 'admission_blocked' | 'post_finalization_negative';

export type PaymentWalletEffectType = Extract<WalletEffectType, 'payment_credit' | 'payment_reversal'>;

export type AutoRechargeAttemptResult =
  | { kind: 'not_configured' }
  | { kind: 'charge_succeeded'; processorEffectId: string }
  | { kind: 'charge_failed'; processorEffectId: string | null }
  | { kind: 'charge_pending'; paymentAttemptId: string };

export type NormalizedPaymentOutcome = {
  walletId: string;
  ownerOrgId: string;
  paymentAttemptId: string | null;
  processor: PaymentProcessor;
  processorEventId: string;
  processorEffectId: string;
  effectType: PaymentWalletEffectType;
  amountMinor: number;
  currency: string;
  metadata?: Record<string, unknown> | null;
};

export type StoredPaymentMethodView = {
  id: string;
  processor: PaymentProcessor;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  funding: string | null;
  status: StoredPaymentMethodStatus;
};

export type AutoRechargeSettingsView = {
  enabled: boolean;
  amountMinor: number;
  currency: string;
};

export type PaymentAttemptView = {
  id: string;
  kind: PaymentAttemptKind;
  trigger: AutoRechargeTrigger | null;
  status: PaymentAttemptStatus;
  amountMinor: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type FundingStateView = {
  paymentMethod: StoredPaymentMethodView | null;
  autoRecharge: AutoRechargeSettingsView;
  attempts: PaymentAttemptView[];
};
