#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  collectChunkBlocks,
  parseEntriesByLabel,
} from './_compatArtifactChunks.mjs';

const [, , artifactPath, requestId, outDir] = process.argv;

if (!artifactPath || !requestId || !outDir) {
  console.error(
    'usage: innies-compat-artifact-extract.mjs <artifact-path> <request-id> <out-dir>',
  );
  process.exit(1);
}

function findEntry(entriesByLabel, label, id) {
  const entries = entriesByLabel.get(label) ?? [];
  return entries.find((entry) => entry?.request_id === id) ?? null;
}

function writeJson(outputPath, value) {
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSummary(outputPath, bundle) {
  const summaryLines = [
    `request_id=${requestId}`,
    `provider=${bundle.upstreamRequest?.provider ?? bundle.ingress?.provider ?? 'unknown'}`,
    `body_sha256=${bundle.upstreamRequest?.body_sha256 ?? ''}`,
    `body_bytes=${bundle.upstreamRequest?.body_bytes ?? ''}`,
    `upstream_status=${bundle.upstreamResponse?.upstream_status ?? ''}`,
    `upstream_request_id=${
      bundle.upstreamResponse?.parsed_body?.request_id ??
      bundle.upstreamResponse?.response_headers?.['request-id'] ??
      ''
    }`,
    `ingress_anthropic_beta=${bundle.ingress?.anthropic_beta ?? ''}`,
    `upstream_anthropic_beta=${bundle.upstreamRequest?.headers?.['anthropic-beta'] ?? ''}`,
    `upstream_user_agent=${bundle.upstreamRequest?.headers?.['user-agent'] ?? ''}`,
    `payload_available=${bundle.invalidPayload?.payload ? 'true' : 'false'}`,
  ];

  fs.writeFileSync(outputPath, `${summaryLines.join('\n')}\n`);
}

const artifactContents = fs.readFileSync(artifactPath, 'utf8');
const chunkBlocks = collectChunkBlocks(artifactContents);
const entriesByLabel = parseEntriesByLabel(chunkBlocks);

const bundle = {
  ingress: findEntry(entriesByLabel, 'compat-invalid-request-debug-json-chunk', requestId),
  invalidPayload: findEntry(
    entriesByLabel,
    'compat-invalid-request-payload-json-chunk',
    requestId,
  ),
  upstreamRequest: findEntry(entriesByLabel, 'compat-upstream-request-json-chunk', requestId),
  upstreamResponse: findEntry(entriesByLabel, 'compat-upstream-response-json-chunk', requestId),
};

if (
  !bundle.upstreamRequest &&
  !bundle.upstreamResponse &&
  !bundle.ingress &&
  !bundle.invalidPayload
) {
  console.error(`request_id ${requestId} not found in ${artifactPath}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

if (bundle.ingress) {
  writeJson(path.join(outDir, 'ingress.json'), bundle.ingress);
}

if (bundle.invalidPayload) {
  writeJson(path.join(outDir, 'invalid-request-payload.json'), bundle.invalidPayload);
  if (bundle.invalidPayload.payload) {
    writeJson(path.join(outDir, 'payload.json'), bundle.invalidPayload.payload);
  }
}

if (bundle.upstreamRequest) {
  writeJson(path.join(outDir, 'upstream-request.json'), bundle.upstreamRequest);
}

if (bundle.upstreamResponse) {
  writeJson(path.join(outDir, 'upstream-response.json'), bundle.upstreamResponse);
}

writeSummary(path.join(outDir, 'summary.txt'), bundle);
