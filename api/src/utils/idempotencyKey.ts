import { AppError } from './errors.js';

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readAndValidateIdempotencyKey(rawValue: string | undefined): string {
  const value = rawValue?.trim();
  if (!value) {
    throw new AppError('invalid_request', 400, 'Missing Idempotency-Key header');
  }

  // C1 contract: UUIDv7 preferred, or opaque token length >= 32.
  if (UUID_V7_REGEX.test(value) || value.length >= 32) {
    return value;
  }

  throw new AppError(
    'invalid_request',
    400,
    'Invalid Idempotency-Key format (expected UUIDv7 or opaque token length >= 32)'
  );
}
