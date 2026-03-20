/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const pilotAuthStartQuerySchema = z.object({
  returnTo: z.string().min(1).optional()
});

const pilotAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

function normalizePilotReturnTo(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!normalized.startsWith('/')) return undefined;
  if (normalized.startsWith('//')) return undefined;
  return normalized;
}

router.get('/v1/pilot/session', async (req, res, next) => {
  try {
    const token = runtime.services.pilotSessions.readTokenFromRequest(req);
    if (!token) {
      throw new AppError('unauthorized', 401, 'Missing pilot session');
    }

    const session = runtime.services.pilotSessions.readSession(token);
    if (!session) {
      throw new AppError('unauthorized', 401, 'Invalid pilot session');
    }

    res.status(200).json({
      ok: true,
      session
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
    res.redirect(302, normalizePilotReturnTo(result.returnTo) ?? '/pilot');
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

export function buildPilotSessionCookie(token: string): string {
  return `innies_pilot_session=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

export function buildClearedPilotSessionCookie(): string {
  return 'innies_pilot_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export default router;
