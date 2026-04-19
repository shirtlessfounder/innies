import { Router } from 'express';
import type express from 'express';
import { getSharedNotesRepository } from '../services/v2Notes/sharedNotesRuntime.js';
import type { SharedNotesRepository } from '../services/v2Notes/sharedNotesRepository.js';

const MAX_NOTES_LENGTH = 50_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const FALLBACK_ORIGINS = [
  'https://innies.work',
  'https://www.innies.work',
  'http://localhost:3000'
];

type V2NotesRouterDeps = {
  repository?: Pick<SharedNotesRepository, 'getDocument' | 'saveDocument' | 'listen'>;
  env?: NodeJS.ProcessEnv;
};

function readAllowedOrigins(env: NodeJS.ProcessEnv | undefined): Set<string> {
  const configured = (env?.V2_NOTES_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : FALLBACK_ORIGINS);
}

function appendVary(res: express.Response, value: string): void {
  const existing = String(res.getHeader('Vary') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!existing.includes(value)) existing.push(value);
  res.setHeader('Vary', existing.join(', '));
}

function applyCors(req: express.Request, res: express.Response, env: NodeJS.ProcessEnv | undefined, methods: string): void {
  const origin = req.header('origin');
  const allowed = readAllowedOrigins(env);
  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  appendVary(res, 'Origin');
}

export function buildV2NotesRouter(deps: V2NotesRouterDeps = {}): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const getRepo = (): Pick<SharedNotesRepository, 'getDocument' | 'saveDocument' | 'listen'> =>
    deps.repository ?? getSharedNotesRepository();

  router.options('/v2/notes', (req, res) => {
    applyCors(req, res, env, 'GET, PUT, OPTIONS');
    res.status(204).end();
  });

  router.options('/v2/notes/stream', (req, res) => {
    applyCors(req, res, env, 'GET, OPTIONS');
    res.status(204).end();
  });

  router.get('/v2/notes', async (req, res, next) => {
    applyCors(req, res, env, 'GET, PUT, OPTIONS');
    try {
      const document = await getRepo().getDocument();
      res.setHeader('Cache-Control', 'no-store');
      res.json(document);
    } catch (error) {
      next(error);
    }
  });

  router.put('/v2/notes', async (req, res, next) => {
    applyCors(req, res, env, 'GET, PUT, OPTIONS');
    try {
      const payload = req.body as { content?: unknown; baseRevision?: unknown } | undefined;
      const content = payload?.content;
      const baseRevisionRaw = payload?.baseRevision;

      if (typeof content !== 'string') {
        res.status(400).json({ error: '`content` must be a string' });
        return;
      }

      if (content.length > MAX_NOTES_LENGTH) {
        res.status(400).json({ error: 'Shared notes content is too large' });
        return;
      }

      let baseRevision: number | null = null;
      if (baseRevisionRaw !== undefined && baseRevisionRaw !== null) {
        if (typeof baseRevisionRaw !== 'number' || Number.isNaN(baseRevisionRaw)) {
          res.status(400).json({ error: '`baseRevision` must be a number when provided' });
          return;
        }
        baseRevision = baseRevisionRaw;
      }

      const document = await getRepo().saveDocument(content, baseRevision);
      res.setHeader('Cache-Control', 'no-store');
      res.json(document);
    } catch (error) {
      next(error);
    }
  });

  router.get('/v2/notes/stream', async (req, res, next) => {
    applyCors(req, res, env, 'GET, OPTIONS');
    try {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const repo = getRepo();
      let closed = false;

      const push = (event: string, payload: unknown) => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const initial = await repo.getDocument();
      push('notes', initial);

      const heartbeat = setInterval(() => {
        if (closed || res.writableEnded) return;
        res.write(': keepalive\n\n');
      }, HEARTBEAT_INTERVAL_MS);

      const disposeListener = await repo.listen(async (document) => {
        push('notes', document);
      });

      const shutdown = async () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          await disposeListener();
        } catch {}
        try {
          res.end();
        } catch {}
      };

      req.on('close', () => {
        void shutdown();
      });
      req.on('aborted', () => {
        void shutdown();
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default buildV2NotesRouter();
