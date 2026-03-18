#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PARSER_PATH="${ROOT_DIR}/scripts/_compatArtifactChunkParser.mjs"

node --input-type=module - "$PARSER_PATH" <<'NODE'
const parserPath = process.argv[2];
const { reconstructEntries } = await import(`file://${parserPath}`);

const blocks = [
  { chunkIndex: 0, chunkCount: 2, jsonChunk: '{"request_id":"req_a","value":"' },
  { chunkIndex: 0, chunkCount: 2, jsonChunk: '{"request_id":"req_b","value":"' },
  { chunkIndex: 1, chunkCount: 2, jsonChunk: 'a"}' },
  { chunkIndex: 1, chunkCount: 2, jsonChunk: 'b"}' },
];

const entries = reconstructEntries(blocks).map((jsonText) => JSON.parse(jsonText));
if (entries.length !== 2) {
  throw new Error(`expected 2 reconstructed entries, got ${entries.length}`);
}

const ids = entries.map((entry) => entry.request_id).sort();
if (ids[0] !== 'req_a' || ids[1] !== 'req_b') {
  throw new Error(`unexpected reconstructed request ids: ${ids.join(',')}`);
}
NODE

echo "ok - innies-compat-artifact-parser"
