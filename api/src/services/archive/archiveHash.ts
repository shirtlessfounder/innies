import { createHash } from 'node:crypto';
import { stableJson } from '../../utils/hash.js';

export function canonicalizeNormalizedPayload(value: unknown): string {
  return stableJson(value);
}

export function hashNormalizedPayload(value: unknown): string {
  return createHash('sha256').update(canonicalizeNormalizedPayload(value)).digest('hex');
}

export function hashRawBytes(value: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(Buffer.from(value)).digest('hex');
}
