import { describe, expect, it } from 'vitest';
import { readAndValidateIdempotencyKey } from '../src/utils/idempotencyKey.js';

describe('idempotency key validation', () => {
  it('accepts uuidv7', () => {
    const key = '018f95c8-4d21-7b2a-a8d5-2f7d3c4b5a6e';
    expect(readAndValidateIdempotencyKey(key)).toBe(key);
  });

  it('accepts opaque keys with length >= 32', () => {
    const key = 'abcdefghijklmnopqrstuvwxyz123456';
    expect(readAndValidateIdempotencyKey(key)).toBe(key);
  });

  it('rejects short opaque keys', () => {
    expect(() => readAndValidateIdempotencyKey('short-key')).toThrowError(/Invalid Idempotency-Key format/);
  });
});
