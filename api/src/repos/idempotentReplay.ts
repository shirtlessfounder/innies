type ReplayField = {
  field: string;
  expected: unknown;
  actual: unknown;
};

export function assertIdempotentReplayMatches(context: string, fields: ReplayField[]): void {
  const mismatched = fields
    .filter((field) => !valuesEqual(field.expected, field.actual))
    .map((field) => field.field);

  if (mismatched.length > 0) {
    throw new Error(`${context} idempotent replay mismatch: ${mismatched.join(', ')}`);
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left == null || right == null) {
    return left == null && right == null;
  }

  if (isBinaryLike(left) || isBinaryLike(right)) {
    return isBinaryLike(left)
      && isBinaryLike(right)
      && Buffer.from(left).equals(Buffer.from(right));
  }

  if (isNumericLike(left) && isNumericLike(right)) {
    return BigInt(String(left)) === BigInt(String(right));
  }

  if (isPlainObject(left) || isPlainObject(right) || Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
  }

  return left === right;
}

function isNumericLike(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isInteger(value))
    || (typeof value === 'string' && /^-?\d+$/.test(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function isBinaryLike(value: unknown): value is Buffer | Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson(value[key])])
    );
  }

  return value ?? null;
}
