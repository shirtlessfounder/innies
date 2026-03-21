/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.post('/v1/payments/webhooks/stripe', async (req, res, next) => {
  try {
    const rawBody = (req as typeof req & { inniesRawBodyText?: string }).inniesRawBodyText;
    if (typeof rawBody !== 'string') {
      throw new AppError('invalid_request', 400, 'Missing raw payment webhook body');
    }

    const result = await runtime.services.payments.processWebhook({
      signatureHeader: req.header('stripe-signature'),
      rawBody
    });

    for (const outcome of result.outcomes) {
      await runtime.services.wallets.recordPaymentOutcome({
        walletId: outcome.walletId,
        processorEffectId: outcome.processorEffectId,
        effectType: outcome.effectType
      });
    }
    await runtime.services.payments.markWebhookProcessed(result.processorEventId);

    res.status(200).json({
      ok: true,
      accepted: result.accepted,
      recordedOutcomes: result.outcomes.length
    });
  } catch (error) {
    next(error);
  }
});

export default router;
