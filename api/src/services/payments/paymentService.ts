import { AppError } from '../../utils/errors.js';
import type { TransactionContext } from '../../repos/sqlClient.js';
import type { AutoRechargeSettingsRepository, AutoRechargeSettingsRow } from '../../repos/autoRechargeSettingsRepository.js';
import type { PaymentAttemptRepository, PaymentAttemptRow } from '../../repos/paymentAttemptRepository.js';
import type { PaymentMethodRepository, PaymentMethodRow } from '../../repos/paymentMethodRepository.js';
import type { PaymentOutcomeRepository, PaymentOutcomeRow } from '../../repos/paymentOutcomeRepository.js';
import type { PaymentProfileRepository, PaymentProfileRow } from '../../repos/paymentProfileRepository.js';
import type { PaymentWebhookEventRepository } from '../../repos/paymentWebhookEventRepository.js';
import {
  type AutoRechargeAttemptResult,
  type AutoRechargeTrigger,
  type FundingStateView,
  type NormalizedPaymentOutcome,
  type PaymentWalletEffectType
} from './paymentTypes.js';
import type { StripeClient, StripeWebhookEvent } from './stripeClient.js';

export class PaymentService {
  constructor(private readonly deps: {
    paymentProfiles: Pick<PaymentProfileRepository, 'findByWalletId' | 'ensureProfile' | 'setDefaultPaymentMethod'>;
    paymentMethods: Pick<PaymentMethodRepository, 'upsertMethod' | 'findDefaultByWalletId' | 'findById' | 'findByProcessorPaymentMethodId' | 'markDetached'>;
    autoRechargeSettings: Pick<AutoRechargeSettingsRepository, 'findByWalletId' | 'upsertSettings'>;
    paymentAttempts: Pick<PaymentAttemptRepository, 'createAttempt' | 'findManualTopUpByIdempotencyKey' | 'findPendingAutoRechargeByWalletId' | 'markProcessing' | 'markSucceeded' | 'markFailed' | 'listRecentByWalletId'>;
    paymentOutcomes: Pick<PaymentOutcomeRepository, 'upsertOutcome' | 'findByProcessorEffectId' | 'findLatestUnrecordedAutoRechargeCreditByWalletId' | 'markRecorded'>;
    paymentWebhooks: Pick<PaymentWebhookEventRepository, 'claimEvent' | 'markProcessed'>;
    stripeClient: Pick<StripeClient, 'createCustomer' | 'createSetupSession' | 'createPaymentSession' | 'createOffSessionCharge' | 'detachPaymentMethod' | 'retrievePaymentMethod' | 'constructWebhookEvent'>;
  }) {}

  markWebhookProcessed(processorEventId: string): Promise<void> {
    return this.deps.paymentWebhooks.markProcessed(processorEventId);
  }

  markPaymentOutcomeRecorded(
    processorEffectId: string,
    db?: Pick<TransactionContext, 'query'>
  ): Promise<void> {
    return this.deps.paymentOutcomes.markRecorded(processorEffectId, db);
  }

  async getFundingState(input: {
    walletId: string;
    ownerOrgId: string;
  }): Promise<FundingStateView> {
    const [storedPaymentMethod, settings, attempts] = await Promise.all([
      this.deps.paymentMethods.findDefaultByWalletId(input.walletId),
      this.deps.autoRechargeSettings.findByWalletId(input.walletId),
      this.deps.paymentAttempts.listRecentByWalletId({
        walletId: input.walletId,
        limit: 10
      })
    ]);
    const paymentMethod = activePaymentMethod(storedPaymentMethod);

    return {
      paymentMethod: paymentMethod ? mapPaymentMethod(paymentMethod) : null,
      autoRecharge: settings ? mapAutoRecharge(settings) : defaultAutoRechargeSettings(),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        kind: attempt.kind,
        trigger: attempt.trigger,
        status: attempt.status,
        amountMinor: Number(attempt.amount_minor),
        currency: attempt.currency,
        createdAt: attempt.created_at,
        updatedAt: attempt.updated_at,
        lastErrorCode: attempt.last_error_code,
        lastErrorMessage: attempt.last_error_message
      }))
    };
  }

  async createSetupSession(input: {
    walletId: string;
    ownerOrgId: string;
    requestedByUserId: string | null;
    returnTo?: string | null;
  }): Promise<{ checkoutUrl: string }> {
    const profile = await this.ensureCustomerProfile({
      walletId: input.walletId,
      ownerOrgId: input.ownerOrgId
    });
    const urls = buildCheckoutUrls(input.returnTo);
    const session = await this.deps.stripeClient.createSetupSession({
      customerId: profile.processor_customer_id,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      metadata: {
        wallet_id: input.walletId,
        owner_org_id: input.ownerOrgId,
        requested_by_user_id: input.requestedByUserId ?? ''
      }
    });

    return {
      checkoutUrl: session.url
    };
  }

  async createTopUpSession(input: {
    walletId: string;
    ownerOrgId: string;
    requestedByUserId: string | null;
    amountMinor: number;
    returnTo?: string | null;
    idempotencyKey: string;
  }): Promise<{ checkoutUrl: string }> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new AppError('invalid_request', 400, 'Top-up amount must be a positive integer', {
        amountMinor: input.amountMinor
      });
    }

    const profile = await this.ensureCustomerProfile({
      walletId: input.walletId,
      ownerOrgId: input.ownerOrgId
    });
    const attempt = await this.findOrCreateManualTopUpAttempt(input);
    const urls = buildCheckoutUrls(input.returnTo);
    const session = await this.deps.stripeClient.createPaymentSession({
      customerId: profile.processor_customer_id,
      amountMinor: input.amountMinor,
      currency: 'USD',
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      idempotencyKey: input.idempotencyKey,
      metadata: {
        wallet_id: input.walletId,
        owner_org_id: input.ownerOrgId,
        payment_attempt_id: attempt.id
      }
    });
    await this.deps.paymentAttempts.markProcessing({
      attemptId: attempt.id,
      processorCheckoutSessionId: session.id
    });

    return {
      checkoutUrl: session.url
    };
  }

  async removeStoredPaymentMethod(input: {
    walletId: string;
    ownerOrgId: string;
  }): Promise<{ removed: boolean }> {
    const paymentMethod = activePaymentMethod(await this.deps.paymentMethods.findDefaultByWalletId(input.walletId));
    if (!paymentMethod) {
      return {
        removed: false
      };
    }

    await this.deps.stripeClient.detachPaymentMethod(paymentMethod.processor_payment_method_id);
    await this.deps.paymentMethods.markDetached({
      walletId: input.walletId,
      paymentMethodId: paymentMethod.id
    });
    await this.deps.paymentProfiles.setDefaultPaymentMethod({
      walletId: input.walletId,
      paymentMethodId: null
    });

    const existing = await this.deps.autoRechargeSettings.findByWalletId(input.walletId);
    if (existing) {
      await this.deps.autoRechargeSettings.upsertSettings({
        walletId: input.walletId,
        ownerOrgId: input.ownerOrgId,
        enabled: false,
        amountMinor: Number(existing.amount_minor),
        currency: existing.currency,
        paymentMethodId: null,
        updatedByUserId: null
      });
    }

    return {
      removed: true
    };
  }

  async updateAutoRechargeSettings(input: {
    walletId: string;
    ownerOrgId: string;
    enabled: boolean;
    amountMinor: number;
    updatedByUserId?: string | null;
  }): Promise<FundingStateView['autoRecharge']> {
    const paymentMethod = activePaymentMethod(await this.deps.paymentMethods.findDefaultByWalletId(input.walletId));
    if (input.enabled && !paymentMethod) {
      throw new AppError('invalid_request', 400, 'Auto-recharge requires a stored payment method');
    }

    const settings = await this.deps.autoRechargeSettings.upsertSettings({
      walletId: input.walletId,
      ownerOrgId: input.ownerOrgId,
      enabled: input.enabled,
      amountMinor: input.amountMinor,
      currency: 'USD',
      paymentMethodId: input.enabled ? paymentMethod?.id ?? null : null,
      updatedByUserId: input.updatedByUserId ?? null
    });

    return mapAutoRecharge(settings);
  }

  async attemptAutoRecharge(walletId: string, trigger: AutoRechargeTrigger): Promise<AutoRechargeAttemptResult> {
    const unrecorded = await this.deps.paymentOutcomes.findLatestUnrecordedAutoRechargeCreditByWalletId(walletId);
    if (unrecorded) {
      return {
        kind: 'charge_succeeded',
        processorEffectId: unrecorded.processor_effect_id
      };
    }

    const settings = await this.deps.autoRechargeSettings.findByWalletId(walletId);
    if (!settings?.enabled) {
      return {
        kind: 'not_configured'
      };
    }

    const paymentMethod = activePaymentMethod(await this.deps.paymentMethods.findDefaultByWalletId(walletId));
    if (!paymentMethod) {
      return {
        kind: 'not_configured'
      };
    }

    const pending = await this.deps.paymentAttempts.findPendingAutoRechargeByWalletId(walletId);
    if (pending) {
      return {
        kind: 'charge_pending',
        paymentAttemptId: pending.id
      };
    }

    const attempt = await this.deps.paymentAttempts.createAttempt({
      walletId,
      ownerOrgId: settings.owner_org_id,
      paymentMethodId: paymentMethod.id,
      kind: 'auto_recharge',
      trigger,
      amountMinor: Number(settings.amount_minor),
      currency: settings.currency,
      metadata: {
        trigger
      }
    });

    const charge = await this.deps.stripeClient.createOffSessionCharge({
      customerId: paymentMethod.processor_customer_id,
      paymentMethodId: paymentMethod.processor_payment_method_id,
      amountMinor: Number(settings.amount_minor),
      currency: settings.currency,
      metadata: {
        wallet_id: walletId,
        owner_org_id: settings.owner_org_id,
        payment_attempt_id: attempt.id,
        auto_recharge_trigger: trigger
      }
    });

    if (charge.kind === 'succeeded') {
      const outcome = await this.deps.paymentOutcomes.upsertOutcome({
        walletId,
        ownerOrgId: settings.owner_org_id,
        paymentAttemptId: attempt.id,
        processorEventId: `sync:${charge.paymentIntentId}`,
        processorEffectId: buildPaymentIntentEffectId(charge.paymentIntentId),
        effectType: 'payment_credit',
        amountMinor: Number(settings.amount_minor),
        currency: settings.currency,
        metadata: {
          trigger,
          source: 'sync_auto_recharge'
        }
      });
      await this.deps.paymentAttempts.markSucceeded({
        attemptId: attempt.id,
        processorEffectId: outcome.processor_effect_id,
        processorPaymentIntentId: charge.paymentIntentId
      });
      return {
        kind: 'charge_succeeded',
        processorEffectId: outcome.processor_effect_id
      };
    }

    if (charge.kind === 'pending') {
      await this.deps.paymentAttempts.markProcessing({
        attemptId: attempt.id,
        processorPaymentIntentId: charge.paymentIntentId
      });
      return {
        kind: 'charge_pending',
        paymentAttemptId: attempt.id
      };
    }

    await this.deps.paymentAttempts.markFailed({
      attemptId: attempt.id,
      processorEffectId: null,
      processorPaymentIntentId: charge.paymentIntentId,
      lastErrorCode: charge.errorCode,
      lastErrorMessage: charge.errorMessage
    });
    return {
      kind: 'charge_failed',
      processorEffectId: null
    };
  }

  async getNormalizedPaymentOutcome(input: {
    processorEffectId: string;
    effectType: PaymentWalletEffectType;
  }): Promise<NormalizedPaymentOutcome | null> {
    const outcome = await this.deps.paymentOutcomes.findByProcessorEffectId(input);
    return outcome ? mapNormalizedOutcome(outcome) : null;
  }

  async processWebhook(input: {
    signatureHeader: string | undefined;
    rawBody: string;
  }): Promise<{
    accepted: boolean;
    processorEventId: string;
    outcomes: NormalizedPaymentOutcome[];
  }> {
    const event = this.deps.stripeClient.constructWebhookEvent(input);
    const claimed = await this.deps.paymentWebhooks.claimEvent({
      processor: 'stripe',
      processorEventId: event.id,
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>
    });
    if (claimed.state === 'already_processed') {
      return {
        accepted: true,
        processorEventId: claimed.processorEventId,
        outcomes: []
      };
    }

    const outcomes: NormalizedPaymentOutcome[] = [];

    switch (event.type) {
      case 'setup_intent.succeeded':
        await this.handleSetupIntentSucceeded(event);
        break;
      case 'payment_intent.succeeded': {
        const outcome = await this.handlePaymentIntentSucceeded(event);
        if (outcome) outcomes.push(outcome);
        break;
      }
      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentFailed(event);
        break;
      case 'refund.created':
      case 'charge.refunded': {
        const outcome = await this.handleRefundCreated(event);
        if (outcome) outcomes.push(outcome);
        break;
      }
      case 'charge.dispute.funds_withdrawn': {
        const outcome = await this.handleChargeDisputeFundsWithdrawn(event);
        if (outcome) outcomes.push(outcome);
        break;
      }
      case 'payment_method.detached':
        await this.handlePaymentMethodDetached(event);
        break;
      default:
        break;
    }

    return {
      accepted: true,
      processorEventId: claimed.processorEventId,
      outcomes
    };
  }

  private async handleSetupIntentSucceeded(event: StripeWebhookEvent): Promise<void> {
    const object = event.data.object;
    const walletId = readMetadataString(object.metadata, 'wallet_id');
    const ownerOrgId = readMetadataString(object.metadata, 'owner_org_id') ?? walletId;
    const customerId = readRequiredString(object.customer);
    const paymentMethodId = readRequiredString(object.payment_method);
    if (!walletId || !ownerOrgId) {
      return;
    }

    const profile = await this.ensureCustomerProfile({
      walletId,
      ownerOrgId,
      processorCustomerId: customerId
    });
    const remoteMethod = await this.deps.stripeClient.retrievePaymentMethod(paymentMethodId);
    const remoteMethodType = readOptionalString(remoteMethod.type);
    if (remoteMethodType && remoteMethodType !== 'card') {
      throw new Error(`unsupported payment method type: ${remoteMethodType}`);
    }
    const card = asRecord(remoteMethod.card);
    if (!card) {
      throw new Error('unsupported payment method type');
    }
    const method = await this.deps.paymentMethods.upsertMethod({
      walletId,
      ownerOrgId,
      paymentProfileId: profile.id,
      processorPaymentMethodId: paymentMethodId,
      processorCustomerId: customerId,
      brand: readRequiredString(card?.brand),
      last4: readRequiredString(card?.last4),
      expMonth: Number(card?.exp_month),
      expYear: Number(card?.exp_year),
      funding: readOptionalString(card?.funding)
    });
    await this.deps.paymentProfiles.setDefaultPaymentMethod({
      walletId,
      paymentMethodId: method.id
    });

    const existing = await this.deps.autoRechargeSettings.findByWalletId(walletId);
    if (existing) {
      await this.deps.autoRechargeSettings.upsertSettings({
        walletId,
        ownerOrgId,
        enabled: existing.enabled,
        amountMinor: Number(existing.amount_minor),
        currency: existing.currency,
        paymentMethodId: method.id,
        updatedByUserId: existing.updated_by_user_id
      });
    }
  }

  private async handlePaymentIntentSucceeded(event: StripeWebhookEvent): Promise<NormalizedPaymentOutcome | null> {
    const object = event.data.object;
    const walletId = readMetadataString(object.metadata, 'wallet_id');
    const ownerOrgId = readMetadataString(object.metadata, 'owner_org_id') ?? walletId;
    if (!walletId || !ownerOrgId) {
      return null;
    }

    const paymentAttemptId = readMetadataString(object.metadata, 'payment_attempt_id');
    const outcome = await this.deps.paymentOutcomes.upsertOutcome({
      walletId,
      ownerOrgId,
      paymentAttemptId,
      processorEventId: event.id,
      processorEffectId: buildPaymentIntentEffectId(readRequiredString(object.id)),
      effectType: 'payment_credit',
      amountMinor: Number(object.amount_received ?? object.amount ?? 0),
      currency: normalizeCurrency(object.currency),
      metadata: {
        eventType: event.type
      }
    });

    if (paymentAttemptId) {
      await this.deps.paymentAttempts.markSucceeded({
        attemptId: paymentAttemptId,
        processorEffectId: outcome.processor_effect_id,
        processorPaymentIntentId: readRequiredString(object.id)
      });
    }

    return mapNormalizedOutcome(outcome);
  }

  private async handlePaymentIntentFailed(event: StripeWebhookEvent): Promise<void> {
    const object = event.data.object;
    const paymentAttemptId = readMetadataString(object.metadata, 'payment_attempt_id');
    if (!paymentAttemptId) {
      return;
    }

    await this.deps.paymentAttempts.markFailed({
      attemptId: paymentAttemptId,
      processorPaymentIntentId: readRequiredString(object.id),
      lastErrorCode: readMetadataString(object.last_payment_error, 'code'),
      lastErrorMessage: readMetadataString(object.last_payment_error, 'message') ?? 'Payment failed'
    });
  }

  private async handleRefundCreated(event: StripeWebhookEvent): Promise<NormalizedPaymentOutcome | null> {
    const object = event.data.object;
    const originalOutcome = await this.findOriginalCreditOutcome(object);
    if (!originalOutcome) {
      throw new Error('original payment credit outcome not found');
    }

    const outcome = await this.deps.paymentOutcomes.upsertOutcome({
      walletId: originalOutcome.wallet_id,
      ownerOrgId: originalOutcome.owner_org_id,
      paymentAttemptId: originalOutcome.payment_attempt_id,
      processorEventId: event.id,
      processorEffectId: buildRefundEffectId(object),
      effectType: 'payment_reversal',
      amountMinor: readRefundAmount(object),
      currency: normalizeCurrency(object.currency),
      metadata: {
        eventType: event.type
      }
    });
    return mapNormalizedOutcome(outcome);
  }

  private async handleChargeDisputeFundsWithdrawn(event: StripeWebhookEvent): Promise<NormalizedPaymentOutcome | null> {
    const object = event.data.object;
    const paymentIntentId = readRequiredString(object.payment_intent);
    const originalOutcome = await this.deps.paymentOutcomes.findByProcessorEffectId({
      processorEffectId: buildPaymentIntentEffectId(paymentIntentId),
      effectType: 'payment_credit'
    });
    if (!originalOutcome) {
      throw new Error('original payment credit outcome not found');
    }

    const disputeId = buildDisputeEffectId(readRequiredString(object.id));
    const outcome = await this.deps.paymentOutcomes.upsertOutcome({
      walletId: originalOutcome.wallet_id,
      ownerOrgId: originalOutcome.owner_org_id,
      paymentAttemptId: originalOutcome.payment_attempt_id,
      processorEventId: event.id,
      processorEffectId: disputeId,
      effectType: 'payment_reversal',
      amountMinor: Number(object.amount ?? 0),
      currency: normalizeCurrency(object.currency),
      metadata: {
        eventType: event.type
      }
    });
    return mapNormalizedOutcome(outcome);
  }

  private async handlePaymentMethodDetached(event: StripeWebhookEvent): Promise<void> {
    const object = event.data.object;
    const paymentMethod = await this.deps.paymentMethods.findByProcessorPaymentMethodId(readRequiredString(object.id));
    if (!paymentMethod) {
      return;
    }
    const profile = await this.deps.paymentProfiles.findByWalletId(paymentMethod.wallet_id);
    const detachedDefaultMethod = profile?.default_payment_method_id === paymentMethod.id;

    await this.deps.paymentMethods.markDetached({
      walletId: paymentMethod.wallet_id,
      paymentMethodId: paymentMethod.id
    });
    if (!detachedDefaultMethod) {
      return;
    }
    await this.deps.paymentProfiles.setDefaultPaymentMethod({
      walletId: paymentMethod.wallet_id,
      paymentMethodId: null
    });

    const settings = await this.deps.autoRechargeSettings.findByWalletId(paymentMethod.wallet_id);
    if (settings) {
      await this.deps.autoRechargeSettings.upsertSettings({
        walletId: paymentMethod.wallet_id,
        ownerOrgId: paymentMethod.owner_org_id,
        enabled: false,
        amountMinor: Number(settings.amount_minor),
        currency: settings.currency,
        paymentMethodId: null,
        updatedByUserId: null
      });
    }
  }

  private async ensureCustomerProfile(input: {
    walletId: string;
    ownerOrgId: string;
    processorCustomerId?: string;
  }): Promise<PaymentProfileRow> {
    const existing = await this.deps.paymentProfiles.findByWalletId(input.walletId);
    if (existing) {
      if (
        input.processorCustomerId
        && existing.processor_customer_id !== input.processorCustomerId
      ) {
        throw new Error('payment profile customer mismatch');
      }
      return existing;
    }

    const customer = input.processorCustomerId
      ? { customerId: input.processorCustomerId }
      : await this.deps.stripeClient.createCustomer({
        metadata: {
          wallet_id: input.walletId,
          owner_org_id: input.ownerOrgId
        }
      });
    return this.deps.paymentProfiles.ensureProfile({
      walletId: input.walletId,
      ownerOrgId: input.ownerOrgId,
      processorCustomerId: customer.customerId
    });
  }

  private async findOrCreateManualTopUpAttempt(input: {
    walletId: string;
    ownerOrgId: string;
    requestedByUserId: string | null;
    amountMinor: number;
    returnTo?: string | null;
    idempotencyKey: string;
  }): Promise<PaymentAttemptRow> {
    const existing = await this.deps.paymentAttempts.findManualTopUpByIdempotencyKey({
      walletId: input.walletId,
      idempotencyKey: input.idempotencyKey
    });
    if (existing) {
      return validateManualTopUpAttempt(existing, input);
    }

    try {
      return await this.deps.paymentAttempts.createAttempt({
        walletId: input.walletId,
        ownerOrgId: input.ownerOrgId,
        kind: 'manual_topup',
        amountMinor: input.amountMinor,
        idempotencyKey: input.idempotencyKey,
        initiatedByUserId: input.requestedByUserId,
        metadata: {
          source: 'pilot_dashboard',
          returnTo: normalizeReturnTo(input.returnTo)
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const retried = await this.deps.paymentAttempts.findManualTopUpByIdempotencyKey({
        walletId: input.walletId,
        idempotencyKey: input.idempotencyKey
      });
      if (!retried) {
        throw error;
      }
      return validateManualTopUpAttempt(retried, input);
    }
  }

  private async findOriginalCreditOutcome(object: Record<string, any>): Promise<PaymentOutcomeRow | null> {
    const paymentIntentId = readOptionalString(object.payment_intent);
    if (!paymentIntentId) {
      return null;
    }
    return this.deps.paymentOutcomes.findByProcessorEffectId({
      processorEffectId: buildPaymentIntentEffectId(paymentIntentId),
      effectType: 'payment_credit'
    });
  }
}

function buildCheckoutUrls(returnTo: string | null | undefined): {
  successUrl: string;
  cancelUrl: string;
} {
  const baseUrl = (process.env.PILOT_UI_BASE_URL ?? process.env.UI_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const safeReturnTo = normalizeReturnTo(returnTo) ?? '/pilot';
  return {
    successUrl: `${baseUrl}${safeReturnTo}`,
    cancelUrl: `${baseUrl}${safeReturnTo}`
  };
}

function normalizeReturnTo(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!normalized.startsWith('/')) return null;
  if (normalized.startsWith('//')) return null;
  if (normalized.includes('\\')) return null;
  return normalized;
}

function validateManualTopUpAttempt(existing: PaymentAttemptRow, input: {
  walletId: string;
  ownerOrgId: string;
  requestedByUserId: string | null;
  amountMinor: number;
  returnTo?: string | null;
}): PaymentAttemptRow {
  const existingReturnTo = readMetadataString(existing.metadata, 'returnTo');
  const requestedReturnTo = normalizeReturnTo(input.returnTo);
  if (
    existing.wallet_id !== input.walletId
    || existing.owner_org_id !== input.ownerOrgId
    || Number(existing.amount_minor) !== input.amountMinor
    || (existing.initiated_by_user_id ?? null) !== (input.requestedByUserId ?? null)
    || existingReturnTo !== requestedReturnTo
  ) {
    throw new AppError('idempotency_mismatch', 409, 'Top-up idempotency key re-used with different request payload');
  }

  if (existing.status !== 'pending' && existing.status !== 'processing') {
    throw new AppError('conflict', 409, 'Top-up request already finalized; refresh and try again');
  }

  return existing;
}

function buildPaymentIntentEffectId(paymentIntentId: string): string {
  return `stripe:payment_intent:${paymentIntentId}`;
}

function buildRefundEffectId(object: Record<string, any>): string {
  const refundId = readOptionalString(object.id);
  if (refundId?.startsWith('re_')) {
    return `stripe:refund:${refundId}`;
  }

  const refunds = Array.isArray(object.refunds?.data) ? object.refunds.data : [];
  const latestRefund = refunds[0];
  const latestRefundId = readOptionalString(latestRefund?.id);
  return latestRefundId ? `stripe:refund:${latestRefundId}` : `stripe:charge_refund:${readRequiredString(object.id)}`;
}

function readRefundAmount(object: Record<string, any>): number {
  if (readOptionalString(object.id)?.startsWith('re_')) {
    return Number(object.amount ?? 0);
  }

  const refunds = Array.isArray(object.refunds?.data) ? object.refunds.data : [];
  const latestRefund = refunds[0];
  const latestAmount = latestRefund?.amount;
  if (typeof latestAmount === 'number' && Number.isFinite(latestAmount)) {
    return Number(latestAmount);
  }
  return Number(object.amount_refunded ?? 0);
}

function buildDisputeEffectId(disputeId: string): string {
  return `stripe:dispute:${disputeId}`;
}

function normalizeCurrency(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.toUpperCase() : 'USD';
}

function mapPaymentMethod(row: PaymentMethodRow): FundingStateView['paymentMethod'] {
  return {
    id: row.id,
    processor: 'stripe',
    brand: row.brand,
    last4: row.last4,
    expMonth: Number(row.exp_month),
    expYear: Number(row.exp_year),
    funding: row.funding,
    status: row.status === 'detached' ? 'detached' : 'active'
  };
}

function activePaymentMethod(row: PaymentMethodRow | null | undefined): PaymentMethodRow | null {
  if (!row || row.status !== 'active') {
    return null;
  }
  return row;
}

function defaultAutoRechargeSettings(): FundingStateView['autoRecharge'] {
  return {
    enabled: false,
    amountMinor: 2500,
    currency: 'USD'
  };
}

function mapAutoRecharge(row: AutoRechargeSettingsRow): FundingStateView['autoRecharge'] {
  return {
    enabled: row.enabled,
    amountMinor: Number(row.amount_minor),
    currency: row.currency
  };
}

function mapNormalizedOutcome(row: PaymentOutcomeRow): NormalizedPaymentOutcome {
  return {
    walletId: row.wallet_id,
    ownerOrgId: row.owner_org_id,
    paymentAttemptId: row.payment_attempt_id,
    processor: 'stripe',
    processorEventId: row.processor_event_id,
    processorEffectId: row.processor_effect_id,
    effectType: row.effect_type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    metadata: row.metadata
  };
}

function readRequiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('payment_processor_error', 502, 'Payment processor response was missing a required id');
  }
  return value;
}

function readMetadataString(metadata: unknown, key: string): string | null {
  const record = asRecord(metadata);
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, any> : null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '23505';
}
