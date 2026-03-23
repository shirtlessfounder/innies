/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { runtime } from '../services/runtime.js';
import { buildConnectedAccountInventory } from '../services/pilot/pilotConnectedAccountInventory.js';
import {
  buildClearedPilotSessionCookie,
  buildPilotSessionCookie,
  buildPilotUiRedirectUrl
} from '../services/pilot/pilotSessionCookie.js';
import { AppError } from '../utils/errors.js';
import { sha256Hex, stableJson } from '../utils/hash.js';
import { readAndValidateIdempotencyKey } from '../utils/idempotencyKey.js';
import {
  decodeRequestHistoryCursor,
  encodeRequestHistoryCursor,
  requestHistoryQuerySchema
} from '../utils/requestHistoryCursor.js';

const router = Router();

const pilotAuthStartQuerySchema = z.object({
  returnTo: z.string().min(1).optional()
});

const pilotAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

const createWithdrawalSchema = z.object({
  amountMinor: z.number().int().positive(),
  destination: z.record(z.string(), z.unknown()),
  note: z.string().trim().min(1).max(500).optional(),
});

const walletLedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional()
});

const walletLedgerCursorSchema = z.object({
  createdAt: z.string().min(1),
  id: z.string().uuid()
});

const paymentSetupSchema = z.object({
  returnTo: z.string().min(1).optional()
});

const paymentTopUpSchema = z.object({
  amountMinor: z.number().int().positive(),
  returnTo: z.string().min(1).optional()
});

const autoRechargeSettingsSchema = z.object({
  enabled: z.boolean(),
  amountMinor: z.number().int().positive()
});

function normalizePilotReturnTo(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!normalized.startsWith('/')) return undefined;
  if (normalized.startsWith('//')) return undefined;
  if (normalized.includes('\\')) return undefined;
  return normalized;
}

function readPilotSession(req: {
  header(name: string): string | undefined;
}) {
  const token = runtime.services.pilotSessions.readTokenFromRequest(req);
  if (!token) {
    throw new AppError('unauthorized', 401, 'Missing pilot session');
  }

  const session = runtime.services.pilotSessions.readSession(token);
  if (!session) {
    throw new AppError('unauthorized', 401, 'Invalid pilot session');
  }

  return session;
}

function readPilotSessionContext(req: {
  header(name: string): string | undefined;
}): {
  ownerOrgId: string;
  contributorUserId: string;
} {
  const session = readPilotSession(req);
  const contributorUserId = session.impersonatedUserId ?? session.actorUserId;
  if (!contributorUserId) {
    throw new AppError('forbidden', 403, 'Pilot session is not scoped to a contributor');
  }

  return {
    ownerOrgId: session.effectiveOrgId,
    contributorUserId
  };
}

function decodeWalletLedgerCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return walletLedgerCursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppError('invalid_request', 400, 'Invalid wallet-ledger cursor');
  }
}

function encodeWalletLedgerCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

router.get('/v1/pilot/session', async (req, res, next) => {
  try {
    const session = readPilotSession(req);

    res.status(200).json({
      ok: true,
      session
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/wallet', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const wallet = await runtime.services.wallets.getWalletSnapshot(
      runtime.services.wallets.walletIdForOrgId(session.effectiveOrgId)
    );
    res.status(200).json({
      ok: true,
      wallet
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/connected-accounts', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const credentials = await runtime.repos.tokenCredentials.listByOrg(session.effectiveOrgId);
    const snapshots = await runtime.repos.tokenCredentialProviderUsage.listByTokenCredentialIds(
      credentials.map((credential) => credential.id)
    );

    res.status(200).json({
      ok: true,
      accounts: buildConnectedAccountInventory({
        credentials,
        snapshots
      })
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/requests', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const query = requestHistoryQuerySchema.parse(req.query ?? {});
    const cursor = decodeRequestHistoryCursor(query.cursor);
    const rows = await runtime.repos.routingAttribution.listOrgRequestHistory({
      orgId: session.effectiveOrgId,
      limit: query.limit,
      cursor,
      historyScope: 'post_cutover'
    });

    const last = rows[rows.length - 1];
    res.status(200).json({
      orgId: session.effectiveOrgId,
      requests: rows,
      nextCursor: rows.length === query.limit && last ? encodeRequestHistoryCursor({
        createdAt: last.created_at,
        requestId: last.request_id,
        attemptNo: last.attempt_no
      }) : null
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/wallet/ledger', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const query = walletLedgerQuerySchema.parse(req.query ?? {});
    const result = await runtime.services.wallets.listWalletLedger({
      walletId: runtime.services.wallets.walletIdForOrgId(session.effectiveOrgId),
      limit: query.limit,
      cursor: decodeWalletLedgerCursor(query.cursor)
    });
    res.status(200).json({
      ok: true,
      ledger: result.entries,
      nextCursor: result.nextCursor ? encodeWalletLedgerCursor(result.nextCursor) : null
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/payments', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const funding = await runtime.services.payments.getFundingState({
      walletId: runtime.services.wallets.walletIdForOrgId(session.effectiveOrgId),
      ownerOrgId: session.effectiveOrgId
    });
    res.status(200).json({
      ok: true,
      funding
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/payments/setup-session', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const parsed = paymentSetupSchema.parse(req.body ?? {});
    const result = await runtime.services.payments.createSetupSession({
      walletId: runtime.services.wallets.walletIdForOrgId(session.effectiveOrgId),
      ownerOrgId: session.effectiveOrgId,
      requestedByUserId: session.impersonatedUserId ?? session.actorUserId,
      returnTo: normalizePilotReturnTo(parsed.returnTo)
    });
    res.status(200).json({
      ok: true,
      checkoutUrl: result.checkoutUrl
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/payments/top-up-session', async (req, res, next) => {
  try {
    const context = readPilotSessionContext(req);
    const walletId = runtime.services.wallets.walletIdForOrgId(context.ownerOrgId);
    const parsed = paymentTopUpSchema.parse(req.body ?? {});
    const returnTo = normalizePilotReturnTo(parsed.returnTo);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const requestHash = sha256Hex(stableJson({
      effectiveOrgId: context.ownerOrgId,
      requestedByUserId: context.contributorUserId,
      amountMinor: parsed.amountMinor,
      returnTo: returnTo ?? null
    }));
    const idemStart = await runtime.services.idempotency.start({
      scope: 'pilot_payment_topup_session_v1',
      tenantScope: walletId,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const result = await runtime.services.payments.createTopUpSession({
      walletId,
      ownerOrgId: context.ownerOrgId,
      requestedByUserId: context.contributorUserId,
      amountMinor: parsed.amountMinor,
      returnTo,
      idempotencyKey
    });
    const responseBody = {
      ok: true,
      checkoutUrl: result.checkoutUrl
    } as const;

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: walletId
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/payments/payment-method/remove', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const result = await runtime.services.payments.removeStoredPaymentMethod({
      walletId: runtime.services.wallets.walletIdForOrgId(session.effectiveOrgId),
      ownerOrgId: session.effectiveOrgId
    });
    res.status(200).json({
      ok: true,
      removed: result.removed
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/payments/auto-recharge', async (req, res, next) => {
  try {
    const session = readPilotSession(req);
    const parsed = autoRechargeSettingsSchema.parse(req.body ?? {});
    const autoRecharge = await runtime.services.payments.updateAutoRechargeSettings({
      walletId: runtime.services.wallets.walletIdForOrgId(session.effectiveOrgId),
      ownerOrgId: session.effectiveOrgId,
      enabled: parsed.enabled,
      amountMinor: parsed.amountMinor,
      updatedByUserId: session.impersonatedUserId ?? session.actorUserId
    });
    res.status(200).json({
      ok: true,
      autoRecharge
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/auth/github/start', async (req, res, next) => {
  try {
    const query = pilotAuthStartQuerySchema.parse(req.query ?? {});
    const redirectUrl = runtime.services.pilotGithubAuth.buildAuthorizationUrl({
      returnTo: normalizePilotReturnTo(query.returnTo)
    });
    res.redirect(302, redirectUrl);
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/auth/github/callback', async (req, res, next) => {
  try {
    const query = pilotAuthCallbackQuerySchema.parse(req.query ?? {});
    const result = await runtime.services.pilotGithubAuth.finishOauthCallback({
      code: query.code,
      state: query.state
    });

    res.setHeader('set-cookie', buildPilotSessionCookie(result.sessionToken));
    res.redirect(302, buildPilotUiRedirectUrl(normalizePilotReturnTo(result.returnTo) ?? '/pilot'));
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/session/logout', async (_req, res, next) => {
  try {
    res.setHeader('set-cookie', buildClearedPilotSessionCookie());
    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/earnings/summary', async (req, res, next) => {
  try {
    const context = readPilotSessionContext(req);
    const summary = await runtime.services.withdrawals.getContributorSummary(context);
    res.status(200).json({
      ok: true,
      summary
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/earnings/history', async (req, res, next) => {
  try {
    const context = readPilotSessionContext(req);
    const entries = await runtime.services.withdrawals.listContributorHistory(context);
    res.status(200).json({
      ok: true,
      entries
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/withdrawals', async (req, res, next) => {
  try {
    const context = readPilotSessionContext(req);
    const withdrawals = await runtime.services.withdrawals.listContributorWithdrawals(context);
    res.status(200).json({
      ok: true,
      withdrawals
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/withdrawals', async (req, res, next) => {
  try {
    const context = readPilotSessionContext(req);
    const parsed = createWithdrawalSchema.parse(req.body);
    const withdrawal = await runtime.services.withdrawals.createWithdrawalRequest({
      ownerOrgId: context.ownerOrgId,
      contributorUserId: context.contributorUserId,
      requestedByUserId: context.contributorUserId,
      amountMinor: parsed.amountMinor,
      destination: parsed.destination,
      note: parsed.note
    });

    res.status(200).json({
      ok: true,
      withdrawal
    });
  } catch (error) {
    next(error);
  }
});

export default router;
