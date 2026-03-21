import { describe, expect, it, vi } from 'vitest';
import { PaymentService } from '../src/services/payments/paymentService.js';
import { MockSqlClient } from './testHelpers.js';

describe('PaymentService', () => {
  it('returns not_configured when auto-recharge is disabled or no active stored method exists', async () => {
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor_customer_id: 'cus_1',
          default_payment_method_id: null
        })
      } as any,
      paymentMethods: {
        findDefaultByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          enabled: false,
          amount_minor: 2500,
          currency: 'USD'
        })
      } as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {
        findLatestUnrecordedAutoRechargeCreditByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentWebhooks: {} as any,
      stripeClient: {} as any
    });

    await expect(service.attemptAutoRecharge('org_fnf', 'admission_blocked')).resolves.toEqual({
      kind: 'not_configured'
    });
  });

  it('returns an existing pending attempt instead of starting a second auto-recharge', async () => {
    const createOffSessionCharge = vi.fn();
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor_customer_id: 'cus_1',
          default_payment_method_id: 'paymeth_local_1'
        })
      } as any,
      paymentMethods: {
        findDefaultByWalletId: vi.fn().mockResolvedValue({
          id: 'paymeth_local_1',
          wallet_id: 'org_fnf',
          processor_payment_method_id: 'pm_1',
          status: 'active'
        })
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          enabled: true,
          amount_minor: 2500,
          currency: 'USD'
        })
      } as any,
      paymentAttempts: {
        findPendingAutoRechargeByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_attempt_pending'
        })
      } as any,
      paymentOutcomes: {
        findLatestUnrecordedAutoRechargeCreditByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentWebhooks: {} as any,
      stripeClient: {
        createOffSessionCharge
      } as any
    });

    await expect(service.attemptAutoRecharge('org_fnf', 'admission_blocked')).resolves.toEqual({
      kind: 'charge_pending',
      paymentAttemptId: 'payment_attempt_pending'
    });
    expect(createOffSessionCharge).not.toHaveBeenCalled();
  });

  it('reuses a succeeded auto-recharge outcome that is still waiting on wallet recording', async () => {
    const createAttempt = vi.fn().mockResolvedValue({
      id: 'payment_attempt_new'
    });
    const createOffSessionCharge = vi.fn().mockResolvedValue({
      kind: 'succeeded',
      paymentIntentId: 'pi_new'
    });
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {
        findDefaultByWalletId: vi.fn().mockResolvedValue({
          id: 'paymeth_local_1',
          wallet_id: 'org_fnf',
          processor_customer_id: 'cus_1',
          processor_payment_method_id: 'pm_1',
          status: 'active'
        })
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          enabled: true,
          amount_minor: 2500,
          currency: 'USD'
        })
      } as any,
      paymentAttempts: {
        findPendingAutoRechargeByWalletId: vi.fn().mockResolvedValue(null),
        createAttempt
      } as any,
      paymentOutcomes: {
        findLatestUnrecordedAutoRechargeCreditByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_outcome_1',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_attempt_id: 'payment_attempt_existing',
          processor: 'stripe',
          processor_event_id: 'sync:pi_existing',
          processor_effect_id: 'stripe:payment_intent:pi_existing',
          effect_type: 'payment_credit',
          amount_minor: 2500,
          currency: 'USD',
          metadata: {
            source: 'sync_auto_recharge'
          },
          created_at: '2026-03-21T10:31:00.000Z'
        })
      } as any,
      paymentWebhooks: {} as any,
      stripeClient: {
        createOffSessionCharge
      } as any
    });

    await expect(service.attemptAutoRecharge('org_fnf', 'admission_blocked')).resolves.toEqual({
      kind: 'charge_succeeded',
      processorEffectId: 'stripe:payment_intent:pi_existing'
    });
    expect(createAttempt).not.toHaveBeenCalled();
    expect(createOffSessionCharge).not.toHaveBeenCalled();
  });

  it('reuses the existing manual top-up attempt when the same idempotency key races', async () => {
    const createAttempt = vi.fn().mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      code: '23505'
    }));
    const findManualTopUpByIdempotencyKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'payment_attempt_topup_existing',
        wallet_id: 'org_fnf',
        owner_org_id: 'org_fnf',
        payment_method_id: null,
        processor: 'stripe',
        kind: 'manual_topup',
        trigger: null,
        status: 'pending',
        amount_minor: 5000,
        currency: 'USD',
        processor_checkout_session_id: null,
        processor_payment_intent_id: null,
        processor_effect_id: null,
        initiated_by_user_id: 'user_darryn',
        last_error_code: null,
        last_error_message: null,
        metadata: {
          source: 'pilot_dashboard',
          returnTo: '/pilot'
        },
        created_at: '2026-03-21T12:00:00.000Z',
        updated_at: '2026-03-21T12:00:00.000Z'
      });
    const createPaymentSession = vi.fn().mockResolvedValue({
      id: 'cs_topup_existing',
      url: 'https://checkout.stripe.test/topup-existing'
    });
    const markProcessing = vi.fn().mockResolvedValue(undefined);

    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_profile_1',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor_customer_id: 'cus_1',
          default_payment_method_id: 'paymeth_local_1'
        })
      } as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {
        findManualTopUpByIdempotencyKey,
        createAttempt,
        markProcessing
      } as any,
      paymentOutcomes: {} as any,
      paymentWebhooks: {} as any,
      stripeClient: {
        createPaymentSession
      } as any
    });

    await expect(service.createTopUpSession({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      requestedByUserId: 'user_darryn',
      amountMinor: 5000,
      returnTo: '/pilot',
      idempotencyKey: 'manual-topup-idempotency-key-0001'
    } as any)).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.test/topup-existing'
    });

    expect(createAttempt).toHaveBeenCalledTimes(1);
    expect(findManualTopUpByIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(createPaymentSession).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cus_1',
      amountMinor: 5000,
      idempotencyKey: 'manual-topup-idempotency-key-0001',
      metadata: expect.objectContaining({
        wallet_id: 'org_fnf',
        owner_org_id: 'org_fnf',
        payment_attempt_id: 'payment_attempt_topup_existing'
      })
    }));
    expect(markProcessing).toHaveBeenCalledWith({
      attemptId: 'payment_attempt_topup_existing',
      processorCheckoutSessionId: 'cs_topup_existing'
    });
  });

  it('falls back to /pilot checkout URLs when returnTo uses a slash-backslash host bypass', async () => {
    const createSetupSession = vi.fn().mockResolvedValue({
      id: 'seti_1',
      url: 'https://checkout.stripe.test/setup'
    });
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_profile_1',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor: 'stripe',
          processor_customer_id: 'cus_1',
          default_payment_method_id: null,
          created_at: '2026-03-21T12:00:00.000Z',
          updated_at: '2026-03-21T12:00:00.000Z'
        })
      } as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {} as any,
      paymentWebhooks: {} as any,
      stripeClient: {
        createSetupSession
      } as any
    });

    await service.createSetupSession({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      requestedByUserId: 'user_darryn',
      returnTo: '/\\evil.example.com'
    });

    expect(createSetupSession).toHaveBeenCalledWith(expect.objectContaining({
      successUrl: 'http://localhost:3000/pilot',
      cancelUrl: 'http://localhost:3000/pilot'
    }));
  });

  it('rejects setup-intent webhooks whose customer id does not match the wallet payment profile', async () => {
    const retrievePaymentMethod = vi.fn();
    const upsertMethod = vi.fn();
    const setDefaultPaymentMethod = vi.fn();
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_profile_1',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor: 'stripe',
          processor_customer_id: 'cus_canonical',
          default_payment_method_id: null,
          created_at: '2026-03-21T12:00:00.000Z',
          updated_at: '2026-03-21T12:00:00.000Z'
        }),
        ensureProfile: vi.fn(),
        setDefaultPaymentMethod
      } as any,
      paymentMethods: {
        upsertMethod
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {} as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_setup_wrong_customer'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_setup_wrong_customer',
          type: 'setup_intent.succeeded',
          data: {
            object: {
              id: 'seti_1',
              customer: 'cus_other',
              payment_method: 'pm_1',
              metadata: {
                wallet_id: 'org_fnf',
                owner_org_id: 'org_fnf'
              }
            }
          }
        }),
        retrievePaymentMethod
      } as any
    });

    await expect(service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_setup_wrong_customer"}'
    })).rejects.toThrow('payment profile customer mismatch');

    expect(retrievePaymentMethod).not.toHaveBeenCalled();
    expect(upsertMethod).not.toHaveBeenCalled();
    expect(setDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('omits detached default payment methods from funding state', async () => {
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {
        findDefaultByWalletId: vi.fn().mockResolvedValue({
          id: 'paymeth_detached',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_profile_id: 'payment_profile_1',
          processor: 'stripe',
          processor_payment_method_id: 'pm_detached',
          processor_customer_id: 'cus_1',
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2031,
          funding: 'credit',
          status: 'detached',
          created_at: '2026-03-21T12:00:00.000Z',
          updated_at: '2026-03-21T12:00:00.000Z',
          detached_at: '2026-03-21T12:05:00.000Z'
        })
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentAttempts: {
        listRecentByWalletId: vi.fn().mockResolvedValue([])
      } as any,
      paymentOutcomes: {} as any,
      paymentWebhooks: {} as any,
      stripeClient: {} as any
    });

    await expect(service.getFundingState({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf'
    })).resolves.toEqual({
      paymentMethod: null,
      autoRecharge: {
        enabled: false,
        amountMinor: 2500,
        currency: 'USD'
      },
      attempts: []
    });
  });

  it('treats detached default methods as not configured for auto-recharge attempts', async () => {
    const createOffSessionCharge = vi.fn();
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor_customer_id: 'cus_1',
          default_payment_method_id: 'paymeth_detached'
        })
      } as any,
      paymentMethods: {
        findDefaultByWalletId: vi.fn().mockResolvedValue({
          id: 'paymeth_detached',
          wallet_id: 'org_fnf',
          payment_profile_id: 'payment_profile_1',
          owner_org_id: 'org_fnf',
          processor_payment_method_id: 'pm_detached',
          processor_customer_id: 'cus_1',
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2031,
          funding: 'credit',
          status: 'detached'
        })
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          enabled: true,
          amount_minor: 2500,
          currency: 'USD'
        })
      } as any,
      paymentAttempts: {
        findPendingAutoRechargeByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentOutcomes: {
        findLatestUnrecordedAutoRechargeCreditByWalletId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentWebhooks: {} as any,
      stripeClient: {
        createOffSessionCharge
      } as any
    });

    await expect(service.attemptAutoRecharge('org_fnf', 'admission_blocked')).resolves.toEqual({
      kind: 'not_configured'
    });
    expect(createOffSessionCharge).not.toHaveBeenCalled();
  });

  it('reuses an unrecorded auto-recharge credit before stale settings or pending attempts can mask it', async () => {
    const findDefaultByWalletId = vi.fn();
    const findPendingAutoRechargeByWalletId = vi.fn();
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {
        findDefaultByWalletId
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          enabled: false,
          amount_minor: 2500,
          currency: 'USD'
        })
      } as any,
      paymentAttempts: {
        findPendingAutoRechargeByWalletId
      } as any,
      paymentOutcomes: {
        findLatestUnrecordedAutoRechargeCreditByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_outcome_1',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_attempt_id: 'payment_attempt_1',
          processor: 'stripe',
          processor_event_id: 'sync:pi_existing',
          processor_effect_id: 'stripe:payment_intent:pi_existing',
          effect_type: 'payment_credit',
          amount_minor: 2500,
          currency: 'USD',
          metadata: {
            source: 'sync_auto_recharge'
          },
          wallet_recorded_at: null,
          created_at: '2026-03-21T12:00:00.000Z'
        })
      } as any,
      paymentWebhooks: {} as any,
      stripeClient: {} as any
    });

    await expect(service.attemptAutoRecharge('org_fnf', 'admission_blocked')).resolves.toEqual({
      kind: 'charge_succeeded',
      processorEffectId: 'stripe:payment_intent:pi_existing'
    });
    expect(findDefaultByWalletId).not.toHaveBeenCalled();
    expect(findPendingAutoRechargeByWalletId).not.toHaveBeenCalled();
  });

  it('normalizes a succeeded payment-intent webhook into a wallet payment credit outcome', async () => {
    const recordOutcome = vi.fn().mockResolvedValue({
      id: 'payment_outcome_1',
      wallet_id: 'org_fnf',
      owner_org_id: 'org_fnf',
      payment_attempt_id: 'payment_attempt_1',
      processor: 'stripe',
      processor_event_id: 'evt_1',
      processor_effect_id: 'stripe:payment_intent:pi_1',
      effect_type: 'payment_credit',
      amount_minor: 2500,
      currency: 'USD',
      metadata: {
        eventType: 'payment_intent.succeeded'
      },
      created_at: '2026-03-20T10:31:00.000Z'
    });
    const markSucceeded = vi.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {
        markSucceeded
      } as any,
      paymentOutcomes: {
        upsertOutcome: recordOutcome
      } as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_1'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_1',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_1',
              amount: 2500,
              currency: 'usd',
              metadata: {
                wallet_id: 'org_fnf',
                payment_attempt_id: 'payment_attempt_1'
              }
            }
          }
        })
      } as any
    });

    const result = await service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_1"}'
    });

    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'org_fnf',
      processorEffectId: 'stripe:payment_intent:pi_1',
      effectType: 'payment_credit',
      amountMinor: 2500,
      currency: 'USD',
      paymentAttemptId: 'payment_attempt_1',
      processorEventId: 'evt_1'
    }));
    expect(markSucceeded).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'payment_attempt_1',
      processorEffectId: 'stripe:payment_intent:pi_1'
    }));
    expect(result).toEqual({
      accepted: true,
      processorEventId: 'evt_1',
      outcomes: [expect.objectContaining({
        walletId: 'org_fnf',
        processorEffectId: 'stripe:payment_intent:pi_1',
        effectType: 'payment_credit'
      })]
    });
  });

  it('reprocesses an existing unprocessed webhook event instead of swallowing the retry', async () => {
    const recordOutcome = vi.fn().mockResolvedValue({
      id: 'payment_outcome_1',
      wallet_id: 'org_fnf',
      owner_org_id: 'org_fnf',
      payment_attempt_id: 'payment_attempt_1',
      processor: 'stripe',
      processor_event_id: 'evt_retry',
      processor_effect_id: 'stripe:payment_intent:pi_retry',
      effect_type: 'payment_credit',
      amount_minor: 2500,
      currency: 'USD',
      metadata: {
        eventType: 'payment_intent.succeeded'
      },
      created_at: '2026-03-20T10:31:00.000Z'
    });
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {
        markSucceeded: vi.fn().mockResolvedValue(undefined)
      } as any,
      paymentOutcomes: {
        upsertOutcome: recordOutcome
      } as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'pending_retry',
          processorEventId: 'evt_retry'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_retry',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_retry',
              amount: 2500,
              currency: 'usd',
              metadata: {
                wallet_id: 'org_fnf',
                payment_attempt_id: 'payment_attempt_1'
              }
            }
          }
        })
      } as any
    });

    const result = await service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_retry"}'
    });

    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(result.processorEventId).toBe('evt_retry');
    expect(result.outcomes).toHaveLength(1);
  });

  it('records partial refund deltas instead of the charge cumulative refunded total', async () => {
    const recordOutcome = vi.fn().mockResolvedValue({
      id: 'payment_outcome_refund',
      wallet_id: 'org_fnf',
      owner_org_id: 'org_fnf',
      payment_attempt_id: 'payment_attempt_1',
      processor: 'stripe',
      processor_event_id: 'evt_refund',
      processor_effect_id: 'stripe:refund:re_2',
      effect_type: 'payment_reversal',
      amount_minor: 100,
      currency: 'USD',
      metadata: {
        eventType: 'charge.refunded'
      },
      created_at: '2026-03-20T10:31:00.000Z'
    });
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {
        upsertOutcome: recordOutcome,
        findByProcessorEffectId: vi.fn().mockResolvedValue({
          id: 'payment_outcome_credit',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_attempt_id: 'payment_attempt_1',
          processor: 'stripe',
          processor_event_id: 'evt_credit',
          processor_effect_id: 'stripe:payment_intent:pi_1',
          effect_type: 'payment_credit',
          amount_minor: 200,
          currency: 'USD',
          metadata: null,
          created_at: '2026-03-20T10:00:00.000Z'
        })
      } as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_refund'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_refund',
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_1',
              payment_intent: 'pi_1',
              amount_refunded: 200,
              currency: 'usd',
              refunds: {
                data: [
                  { id: 're_2', amount: 100 },
                  { id: 're_1', amount: 100 }
                ]
              }
            }
          }
        })
      } as any
    });

    await service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_refund"}'
    });

    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      processorEffectId: 'stripe:refund:re_2',
      amountMinor: 100
    }));
  });

  it('normalizes refund.created webhooks from the refund object instead of charge refund list ordering', async () => {
    const recordOutcome = vi.fn().mockResolvedValue({
      id: 'payment_outcome_refund',
      wallet_id: 'org_fnf',
      owner_org_id: 'org_fnf',
      payment_attempt_id: 'payment_attempt_1',
      processor: 'stripe',
      processor_event_id: 'evt_refund_created',
      processor_effect_id: 'stripe:refund:re_2',
      effect_type: 'payment_reversal',
      amount_minor: 100,
      currency: 'USD',
      metadata: {
        eventType: 'refund.created'
      },
      created_at: '2026-03-20T10:31:00.000Z'
    });
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {
        upsertOutcome: recordOutcome,
        findByProcessorEffectId: vi.fn().mockResolvedValue({
          id: 'payment_outcome_credit',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_attempt_id: 'payment_attempt_1',
          processor: 'stripe',
          processor_event_id: 'evt_credit',
          processor_effect_id: 'stripe:payment_intent:pi_1',
          effect_type: 'payment_credit',
          amount_minor: 200,
          currency: 'USD',
          metadata: null,
          created_at: '2026-03-20T10:00:00.000Z'
        })
      } as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_refund_created'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_refund_created',
          type: 'refund.created',
          data: {
            object: {
              id: 're_2',
              payment_intent: 'pi_1',
              amount: 100,
              currency: 'usd'
            }
          }
        })
      } as any
    });

    await service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_refund_created"}'
    });

    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      processorEventId: 'evt_refund_created',
      processorEffectId: 'stripe:refund:re_2',
      amountMinor: 100,
      effectType: 'payment_reversal'
    }));
  });

  it('does not acknowledge charge.refunded before the original payment credit exists', async () => {
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {
        findByProcessorEffectId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_refund_pending_credit'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_refund_pending_credit',
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_1',
              payment_intent: 'pi_missing',
              amount_refunded: 100,
              currency: 'usd',
              refunds: {
                data: [
                  { id: 're_1', amount: 100 }
                ]
              }
            }
          }
        })
      } as any
    });

    await expect(service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_refund_pending_credit"}'
    })).rejects.toThrow('original payment credit outcome not found');
  });

  it('does not acknowledge dispute reversals before the original payment credit exists', async () => {
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {} as any,
      paymentMethods: {} as any,
      autoRechargeSettings: {} as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {
        findByProcessorEffectId: vi.fn().mockResolvedValue(null)
      } as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_dispute_pending_credit'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_dispute_pending_credit',
          type: 'charge.dispute.funds_withdrawn',
          data: {
            object: {
              id: 'dp_1',
              payment_intent: 'pi_missing',
              amount: 2500,
              currency: 'usd'
            }
          }
        })
      } as any
    });

    await expect(service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_dispute_pending_credit"}'
    })).rejects.toThrow('original payment credit outcome not found');
  });

  it('keeps the active default method and auto-recharge settings when Stripe detaches a non-default card', async () => {
    const markDetached = vi.fn().mockResolvedValue(undefined);
    const setDefaultPaymentMethod = vi.fn().mockResolvedValue(undefined);
    const upsertSettings = vi.fn().mockResolvedValue(undefined);
    const service = new PaymentService({
      sql: new MockSqlClient(),
      paymentProfiles: {
        findByWalletId: vi.fn().mockResolvedValue({
          id: 'payment_profile_1',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          processor: 'stripe',
          processor_customer_id: 'cus_1',
          default_payment_method_id: 'paymeth_default',
          created_at: '2026-03-21T12:00:00.000Z',
          updated_at: '2026-03-21T12:00:00.000Z'
        }),
        setDefaultPaymentMethod
      } as any,
      paymentMethods: {
        findByProcessorPaymentMethodId: vi.fn().mockResolvedValue({
          id: 'paymeth_old',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_profile_id: 'payment_profile_1',
          processor: 'stripe',
          processor_payment_method_id: 'pm_old',
          processor_customer_id: 'cus_1',
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2031,
          funding: 'credit',
          status: 'active',
          created_at: '2026-03-21T12:00:00.000Z',
          updated_at: '2026-03-21T12:00:00.000Z',
          detached_at: null
        }),
        markDetached
      } as any,
      autoRechargeSettings: {
        findByWalletId: vi.fn().mockResolvedValue({
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          enabled: true,
          amount_minor: 2500,
          currency: 'USD',
          payment_method_id: 'paymeth_default',
          updated_by_user_id: 'user_darryn',
          created_at: '2026-03-21T12:00:00.000Z',
          updated_at: '2026-03-21T12:00:00.000Z'
        }),
        upsertSettings
      } as any,
      paymentAttempts: {} as any,
      paymentOutcomes: {} as any,
      paymentWebhooks: {
        claimEvent: vi.fn().mockResolvedValue({
          state: 'claimed',
          processorEventId: 'evt_pm_detached'
        }),
        markProcessed: vi.fn().mockResolvedValue(undefined)
      } as any,
      stripeClient: {
        constructWebhookEvent: vi.fn().mockReturnValue({
          id: 'evt_pm_detached',
          type: 'payment_method.detached',
          data: {
            object: {
              id: 'pm_old'
            }
          }
        })
      } as any
    });

    await service.processWebhook({
      signatureHeader: 'stripe-signature',
      rawBody: '{"id":"evt_pm_detached"}'
    });

    expect(markDetached).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      paymentMethodId: 'paymeth_old'
    });
    expect(setDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(upsertSettings).not.toHaveBeenCalled();
  });
});
