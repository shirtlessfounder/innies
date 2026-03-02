import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type SecretEnvelopeV1 = {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
};

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_ENV = 'SELLER_SECRET_ENC_KEY_B64';

function readEncryptionKey(): Buffer {
  const encoded = process.env[KEY_ENV];
  if (!encoded) {
    throw new Error(`Missing required env ${KEY_ENV}`);
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`${KEY_ENV} must decode to ${KEY_BYTES} bytes`);
  }

  return key;
}

function parseEnvelope(raw: string): SecretEnvelopeV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SecretEnvelopeV1>;
    if (
      parsed.v === 1
      && parsed.alg === ALGORITHM
      && typeof parsed.iv === 'string'
      && typeof parsed.tag === 'string'
      && typeof parsed.ct === 'string'
    ) {
      return parsed as SecretEnvelopeV1;
    }
    return null;
  } catch {
    return null;
  }
}

export function encryptSecret(plaintext: string): Buffer {
  const key = readEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: SecretEnvelopeV1 = {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64')
  };

  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function decryptSecret(value: Buffer | string): string {
  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const envelope = parseEnvelope(raw);

  // Backward compatibility with pre-encryption rows in development environments.
  if (!envelope) {
    return raw;
  }

  const key = readEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
}
