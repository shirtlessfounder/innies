import type { NextFunction, Request, Response } from 'express';
import { ApiKeyRepository, type ApiKeyScope } from '../repos/apiKeyRepository.js';
import { sha256Hex } from '../utils/hash.js';

function readToken(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth) {
    const match = auth.match(/^\s*bearer\s+(.+)\s*$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const xApiKey = req.header('x-api-key');
  return xApiKey ? xApiKey.trim() : null;
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
        scope: record.scope
      };

      await repo.touchLastUsed(record.id);
      next();
    } catch (error) {
      next(error);
    }
  };
}
