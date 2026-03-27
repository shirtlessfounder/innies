import { gunzipSync, gzipSync } from 'node:zlib';
import { stableJson } from '../../utils/hash.js';
import type { ArchiveEncodedRawBlob, ArchiveRawInput } from './archiveTypes.js';

export function toArchiveRawBuffer(value: ArchiveRawInput): Buffer {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }

  return Buffer.from(stableJson(value), 'utf8');
}

export function encodeArchiveRawBlob(value: ArchiveRawInput): ArchiveEncodedRawBlob {
  const rawBuffer = toArchiveRawBuffer(value);
  const payload = gzipSync(rawBuffer);
  return {
    encoding: 'gzip',
    bytesCompressed: payload.length,
    bytesUncompressed: rawBuffer.length,
    payload,
    rawBuffer
  };
}

export function decodeArchiveRawBlob(input: {
  encoding: 'gzip' | 'none';
  payload: Buffer;
}): Buffer {
  if (input.encoding === 'none') {
    return Buffer.from(input.payload);
  }

  return gunzipSync(input.payload);
}
