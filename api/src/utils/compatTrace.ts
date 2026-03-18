import type { Request } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './hash.js';

type CapturePhase = 'ingress' | 'upstream-request';

type RawBodyCarrier = Request & {
  inniesRawBodyText?: string;
};

function resolveCompatCaptureDir(explicitDir?: string | null): string | null {
  const value = (explicitDir ?? process.env.INNIES_COMPAT_CAPTURE_DIR ?? '').trim();
  return value.length > 0 ? value : null;
}

function sanitizeCapturePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  return normalized.length > 0 ? normalized : 'missing-request-id';
}

export function shouldCaptureCompatBody(input: {
  captureDir?: string | null;
  method?: string | null;
  path?: string | null;
}): boolean {
  return Boolean(resolveCompatCaptureDir(input.captureDir))
    && (input.method ?? '').toUpperCase() === 'POST'
    && input.path === '/v1/messages';
}

export function captureCompatRawBody(input: {
  req: RawBodyCarrier;
  captureDir?: string | null;
  method?: string | null;
  path?: string | null;
  body: Buffer;
  encoding?: BufferEncoding;
}): void {
  if (!shouldCaptureCompatBody(input)) {
    return;
  }
  input.req.inniesRawBodyText = input.body.toString(input.encoding ?? 'utf8');
}

export function redactTraceSecret(value: string): string {
  if (value.length === 0) return '<redacted:empty>';
  return `<redacted:${sha256Hex(value).slice(0, 12)}:${value.length}>`;
}

export function sanitizeTraceHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => {
        const normalizedName = name.toLowerCase();
        if (normalizedName === 'authorization') {
          const match = value.match(/^(\S+)\s+(.+)$/);
          if (match) {
            return [normalizedName, `${match[1]} ${redactTraceSecret(match[2])}`];
          }
          return [normalizedName, redactTraceSecret(value)];
        }
        if (normalizedName === 'x-api-key' || normalizedName === 'api-key') {
          return [normalizedName, redactTraceSecret(value)];
        }
        return [normalizedName, value];
      })
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function collectTraceResponseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    Array.from(headers.entries())
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function persistCompatTraceBody(input: {
  captureDir?: string | null;
  requestId: string;
  phase: CapturePhase;
  attemptNo?: number;
  body: string;
  metadata: Record<string, unknown>;
}): {
  bodyPath: string;
  metaPath: string;
  bodySha256: string;
  bodyBytes: number;
} | null {
  const captureDir = resolveCompatCaptureDir(input.captureDir);
  if (!captureDir) return null;

  const requestDir = join(captureDir, sanitizeCapturePathSegment(input.requestId));
  mkdirSync(requestDir, { recursive: true });

  const prefix = input.phase === 'ingress'
    ? 'ingress'
    : `upstream-request.attempt-${input.attemptNo ?? 1}`;
  const bodyPath = join(requestDir, `${prefix}.body.json`);
  const metaPath = join(requestDir, `${prefix}.meta.json`);
  const bodySha256 = sha256Hex(input.body);
  const bodyBytes = Buffer.byteLength(input.body, 'utf8');

  writeFileSync(bodyPath, input.body, 'utf8');
  writeFileSync(metaPath, `${JSON.stringify({
    request_id: input.requestId,
    phase: input.phase,
    attempt_no: input.attemptNo ?? null,
    body_sha256: bodySha256,
    body_bytes: bodyBytes,
    body_path: bodyPath,
    ...input.metadata
  }, null, 2)}\n`, 'utf8');

  return {
    bodyPath,
    metaPath,
    bodySha256,
    bodyBytes
  };
}
