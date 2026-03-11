/// <reference path="../types/express.d.ts" />

import type { NextFunction, Request, Response } from 'express';
import { ApiKeyRepository, type ApiKeyScope } from '../repos/apiKeyRepository.js';
import { sha256Hex } from '../utils/hash.js';
import { resolveDefaultBuyerProvider } from '../utils/providerPreference.js';

function readToken(req: Request): string | null {
  // Prefer x-api-key over Authorization header.
  // Claude Code may send both an OAuth bearer token (from claude.ai login)
  // and x-api-key (from ANTHROPIC_API_KEY / innies token). The x-api-key
  // is the innies buyer key we need for auth; the bearer token is for
  // Anthropic's API and would fail validation here.
  const xApiKey = req.header('x-api-key');
  if (xApiKey) {
    return xApiKey.trim();
  }

  const auth = req.header('authorization');
  if (auth) {
    const match = auth.match(/^\s*bearer\s+(.+)\s*$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

export function requireApiKey(repo: ApiKeyRepository, allowedScopes: ApiKeyScope[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readToken(req);
      if (!token) {
        res.status(401).json({ code: 'unauthorized', message: 'Missing API key' });
        return;
      }

      const record = await repo.findActiveByHash(sha256Hex(token));
      if (!record || !allowedScopes.includes(record.scope)) {
        res.status(403).json({ code: 'forbidden', message: 'Invalid API key scope' });
        return;
      }

      req.auth = {
        apiKeyId: record.id,
        orgId: record.org_id,
        scope: record.scope,
        preferredProvider: record.scope === 'buyer_proxy'
          ? (record.preferred_provider ?? resolveDefaultBuyerProvider())
          : (record.preferred_provider ?? null),
        preferredProviderSource: record.scope === 'buyer_proxy'
          ? (record.preferred_provider ? 'explicit' : 'default')
          : (record.preferred_provider ? 'explicit' : null)
      };

      await repo.touchLastUsed(record.id);
      next();
    } catch (error) {
      next(error);
    }
  };
}
