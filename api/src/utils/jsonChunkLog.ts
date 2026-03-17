import { stableJson } from './hash.js';

type JsonChunkLogLevel = 'log' | 'info' | 'warn';

function emit(level: JsonChunkLogLevel, label: string, payload: unknown): void {
  if (level === 'warn') {
    console.warn(label, payload);
    return;
  }
  if (level === 'info') {
    console.info(label, payload);
    return;
  }
  console.log(label, payload);
}

export function logJsonChunks(input: {
  label: string;
  value: unknown;
  level?: JsonChunkLogLevel;
  chunkSize?: number;
}): void {
  const {
    label,
    value,
    level = 'warn',
    chunkSize = 6000
  } = input;

  const json = stableJson(value);
  const safeChunkSize = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : 6000;
  const chunkCount = Math.max(1, Math.ceil(json.length / safeChunkSize));

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    emit(level, label, {
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
      json: json.slice(chunkIndex * safeChunkSize, (chunkIndex + 1) * safeChunkSize)
    });
  }
}
