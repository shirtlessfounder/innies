export {};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        apiKeyId: string;
        orgId: string | null;
        scope: 'buyer_proxy' | 'admin';
      };
    }
  }
}
