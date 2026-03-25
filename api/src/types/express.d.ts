import type { OrgWebSession } from '../services/org/orgSessionService.js';

export {};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        apiKeyId: string;
        orgId: string | null;
        scope: 'buyer_proxy' | 'admin';
        buyerKeyLabel?: string | null;
        preferredProvider?: 'anthropic' | 'openai' | null;
        preferredProviderSource?: 'explicit' | 'default' | null;
      };
      orgSession?: OrgWebSession | null;
    }
  }
}
