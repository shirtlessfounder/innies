import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import adminRoutes from './routes/admin.js';
import anthropicCompatRoutes from './routes/anthropicCompat.js';
import proxyRoutes from './routes/proxy.js';
import sellerKeysRoutes from './routes/sellerKeys.js';
import usageRoutes from './routes/usage.js';
import { startBackgroundJobs } from './services/runtime.js';
import { AppError } from './utils/errors.js';

export function createApp(): express.Express {
  const app = express();
  const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '20mb';
  app.use(express.json({ limit: jsonBodyLimit }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(adminRoutes);
  app.use(anthropicCompatRoutes);
  app.use(sellerKeysRoutes);
  app.use(usageRoutes);
  app.use(proxyRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ code: 'invalid_request', message: 'Invalid request', issues: err.issues });
      return;
    }

    if (err instanceof AppError) {
      res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
      return;
    }

    const message = err instanceof Error ? err.message : 'Unexpected error';
    res.status(500).json({ code: 'internal_error', message });
  });

  return app;
}

export function startServer(port = Number(process.env.PORT || 4010)): void {
  const app = createApp();
  app.listen(port, () => {
    startBackgroundJobs();
    // eslint-disable-next-line no-console
    console.log(`innies api listening on :${port}`);
  });
}

startServer();
