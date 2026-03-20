/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { runtime } from '../services/runtime.js';

const router = Router();

const githubCallbackSchema = z.object({
  code: z.string().trim().min(1),
  mode: z.enum(['darryn', 'admin']),
  redirectUri: z.string().trim().url().optional()
});

const impersonationSchema = z.object({
  githubLogin: z.string().trim().min(1)
});

router.get('/v1/pilot/auth/github/callback', async (req, res, next) => {
  try {
    const input = githubCallbackSchema.parse({
      code: typeof req.query.code === 'string' ? req.query.code : undefined,
      mode: typeof req.query.mode === 'string' ? req.query.mode : undefined,
      redirectUri: typeof req.query.redirectUri === 'string' ? req.query.redirectUri : undefined
    });
    const result = await runtime.services.pilotSessions.createSessionFromGithubCallback(input);

    res.setHeader('Set-Cookie', runtime.services.pilotSessions.buildSessionCookie(result.token));
    res.status(200).json({
      ok: true,
      token: result.token,
      session: result.session
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/pilot/session', async (req, res, next) => {
  try {
    const session = runtime.services.pilotSessions.readFromRequest(req);
    res.status(200).json({
      ok: true,
      session
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/session/impersonate', async (req, res, next) => {
  try {
    const input = impersonationSchema.parse(req.body);
    const result = await runtime.services.pilotSessions.impersonateFromRequest(req, input.githubLogin);

    res.setHeader('Set-Cookie', runtime.services.pilotSessions.buildSessionCookie(result.token));
    res.status(200).json({
      ok: true,
      token: result.token,
      session: result.session
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/pilot/session/impersonation/clear', async (req, res, next) => {
  try {
    const result = await runtime.services.pilotSessions.clearImpersonationFromRequest(req);

    res.setHeader('Set-Cookie', runtime.services.pilotSessions.buildSessionCookie(result.token));
    res.status(200).json({
      ok: true,
      token: result.token,
      session: result.session
    });
  } catch (error) {
    next(error);
  }
});

export default router;
