#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [inputArg, outDirArg] = process.argv.slice(2);

if (!inputArg) {
  console.error('error: missing payload-matrix input path');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing summary output dir');
  process.exit(1);
}

function resolveInputDir(inputPathArg) {
  const resolved = path.resolve(inputPathArg);
  if (!fs.existsSync(resolved)) {
    console.error(`error: payload-matrix input path not found: ${inputPathArg}`);
    process.exit(1);
  }
  const stats = fs.statSync(resolved);
  if (stats.isDirectory()) {
    return resolved;
  }
  if (stats.isFile()) {
    return path.dirname(resolved);
  }
  console.error(`error: unsupported payload-matrix input path: ${inputPathArg}`);
  process.exit(1);
}

function readKeyValueFile(filePath) {
  const result = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function listDirectories(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function outcomeToken(run) {
  return `${run.status}:${run.outcome}`;
}

const inputDir = resolveInputDir(inputArg);
const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const rootSummaryPath = path.join(inputDir, 'summary.txt');
const rootSummary = fs.existsSync(rootSummaryPath) ? readKeyValueFile(rootSummaryPath) : {};

const payloadRoot = path.join(inputDir, 'payloads');
const payloadNames = listDirectories(payloadRoot);
if (payloadNames.length === 0) {
  console.error(`error: no payload matrix artifacts found in ${inputDir}`);
  process.exit(1);
}

const payloadSummaries = payloadNames.map((payloadName) => {
  const payloadDir = path.join(payloadRoot, payloadName);
  const metaCandidates = [
    path.join(payloadDir, 'meta.txt'),
    path.join(payloadDir, 'summary.txt')
  ];
  const metaPath = metaCandidates.find((candidate) => fs.existsSync(candidate));
  if (!metaPath) {
    console.error(`error: missing payload metadata for ${payloadName} in ${payloadDir}`);
    process.exit(1);
  }
  const meta = readKeyValueFile(metaPath);
  const status = Number(meta.status ?? Number.NaN);
  const outcome = meta.outcome ?? '';
  if (!Number.isFinite(status) || !outcome) {
    console.error(`error: invalid payload metadata: ${metaPath}`);
    process.exit(1);
  }
  return {
    payload: meta.payload || payloadName,
    status,
    outcome,
    requestId: meta.request_id || '',
    providerRequestId: meta.provider_request_id || '',
    tokenSource: meta.token_source || '',
    payloadSha256: meta.payload_sha256 || '',
    payloadBytes: meta.payload_bytes || '',
    metaPath
  };
});

const runCount = payloadSummaries.length;
const successRuns = payloadSummaries.filter((run) => run.outcome === 'request_succeeded');
const invalidRuns = payloadSummaries.filter((run) => run.outcome === 'reproduced_invalid_request_error');
const otherRuns = payloadSummaries.filter((run) => !['request_succeeded', 'reproduced_invalid_request_error'].includes(run.outcome));
const uniqueOutcomeTokens = [...new Set(payloadSummaries.map(outcomeToken))];
const comparisonPossible = runCount > 1;
const payloadSensitive = comparisonPossible && uniqueOutcomeTokens.length > 1;
const allSuccess = successRuns.length === runCount;
const allInvalidRequest = invalidRuns.length === runCount;
const uniformFailure = comparisonPossible && !allSuccess && uniqueOutcomeTokens.length === 1;

let classification = 'single_payload_inconclusive';
if (allSuccess) {
  classification = comparisonPossible ? 'all_success' : 'single_payload_inconclusive';
} else if (uniformFailure) {
  classification = 'uniform_failure_provider_side_candidate';
} else if (payloadSensitive) {
  classification = 'payload_shape_specific';
}

const successfulPayloads = payloadSummaries
  .filter((run) => run.outcome === 'request_succeeded')
  .map((run) => run.payload);
const failingPayloads = payloadSummaries
  .filter((run) => run.outcome !== 'request_succeeded')
  .map((run) => run.payload);

const output = {
  mode: 'direct_payload_matrix',
  inputDir,
  outputDir: outDir,
  runCount,
  payloadCount: runCount,
  comparisonPossible,
  successCount: successRuns.length,
  invalidRequestCount: invalidRuns.length,
  otherCount: otherRuns.length,
  classification,
  payloadSensitive,
  uniformFailure,
  allInvalidRequest,
  allSuccess,
  rootSummary,
  successfulPayloads,
  failingPayloads,
  payloadSummaries
};

const summaryLines = [];
summaryLines.push('mode=direct_payload_matrix');
summaryLines.push(`input_dir=${inputDir}`);
summaryLines.push(`run_count=${runCount}`);
summaryLines.push(`payload_count=${runCount}`);
summaryLines.push(`comparison_possible=${String(comparisonPossible)}`);
if (rootSummary.target_url) {
  summaryLines.push(`target_url=${rootSummary.target_url}`);
}
if (rootSummary.payload_matrix_tsv) {
  summaryLines.push(`payload_matrix_tsv=${rootSummary.payload_matrix_tsv}`);
}
if (rootSummary.headers_tsv_path) {
  summaryLines.push(`headers_tsv_path=${rootSummary.headers_tsv_path}`);
}
if (rootSummary.direct_access_token_source) {
  summaryLines.push(`direct_access_token_source=${rootSummary.direct_access_token_source}`);
}
summaryLines.push(`success_count=${successRuns.length}`);
summaryLines.push(`invalid_request_count=${invalidRuns.length}`);
summaryLines.push(`other_count=${otherRuns.length}`);
summaryLines.push(`classification=${classification}`);
summaryLines.push(`payload_sensitive=${String(payloadSensitive)}`);
summaryLines.push(`uniform_failure=${String(uniformFailure)}`);
summaryLines.push(`all_invalid_request=${String(allInvalidRequest)}`);
summaryLines.push(`all_success=${String(allSuccess)}`);
summaryLines.push(`successful_payloads=${joinNames(successfulPayloads)}`);
summaryLines.push(`failing_payloads=${joinNames(failingPayloads)}`);

for (const summary of payloadSummaries) {
  summaryLines.push(
    `payload=${summary.payload} status=${summary.status} outcome=${summary.outcome} provider_request_id=${summary.providerRequestId} request_id=${summary.requestId}`
  );
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
