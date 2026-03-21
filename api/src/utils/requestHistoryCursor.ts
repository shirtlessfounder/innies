import { z } from 'zod';
import type { RequestHistoryCursor } from '../repos/routingAttributionRepository.js';
import { AppError } from './errors.js';

export const requestHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional()
});

const requestHistoryCursorSchema = z.object({
  createdAt: z.string().min(1),
  requestId: z.string().min(1),
  attemptNo: z.number().int().min(1)
});

export function encodeRequestHistoryCursor(cursor: RequestHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeRequestHistoryCursor(cursor: string | undefined): RequestHistoryCursor | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return requestHistoryCursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppError('invalid_request', 400, 'Invalid request-history cursor');
  }
}
