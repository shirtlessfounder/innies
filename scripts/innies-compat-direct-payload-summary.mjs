#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [inputPathArg, outDirArg] = process.argv.slice(2);

if (!inputPathArg) {
  console.error('error: missing payload matrix input path');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing summary output dir');
  process.exit(1);
}

const inputPath = path.resolve(inputPathArg);
const outDir = path.resolve(outDirArg);

if (!fs.existsSync(inputPath)) {
  console.error(`error: payload summary input path not found: ${inputPathArg}`);
  process.exit(1);
}

const matrixDir = fs.statSync(inputPath).isDirectory() ? inputPath : path.dirname(inputPath);
const payloadsDir = path.join(matrixDir, 'payloads');
const rootSummaryPath = path.join(matrixDir, 'summary.txt');

if (!fs.existsSync(payloadsDir) || !fs.statSync(payloadsDir).isDirectory()) {
  console.error(`error: payload matrix artifacts not found in ${matrixDir}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

function readKeyValueFile(filePath) {
  const result = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

function listDirectories(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function outcomeToken(run) {
  return `${run.status}:${run.outcome}`;
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

const rootSummary = fs.existsSync(rootSummaryPath) ? readKeyValueFile(rootSummaryPath) : {};
const payloadNames = listDirectories(payloadsDir);

if (payloadNames.length === 0) {
  console.error(`error: no payload artifacts found in ${matrixDir}`);
  process.exit(1);
}

const runs = payloadNames.map((payloadName) => {
  const metaPath = path.join(payloadsDir, payloadName, 'meta.txt');
  if (!fs.existsSync(metaPath)) {
    console.error(`error: missing payload meta file: ${metaPath}`);
    process.exit(1);
  }
  const summary = readKeyValueFile(metaPath);
  const status = Number(summary.status ?? NaN);
  const outcome = summary.outcome ?? '';
  if (!Number.isFinite(status) || !outcome) {
    console.error(`error: invalid payload meta file: ${metaPath}`);
    process.exit(1);
  }
  return {
    payload: summary.payload || payloadName,
    status,
    outcome,
    providerRequestId: summary.provider_request_id || '',
    requestId: summary.request_id || '',
    tokenSource: summary.token_source || '',
    payloadSha256: summary.payload_sha256 || '',
    payloadBytes: summary.payload_bytes || ''
  };
});

const runCount = runs.length;
const successRuns = runs.filter((run) => run.outcome === 'request_succeeded');
const invalidRuns = runs.filter((run) => run.outcome === 'reproduced_invalid_request_error');
const otherRuns = runs.filter((run) => !['request_succeeded', 'reproduced_invalid_request_error'].includes(run.outcome));
const uniqueOutcomeTokens = [...new Set(runs.map(outcomeToken))];
const allSuccess = successRuns.length === runCount;
const allInvalidRequest = invalidRuns.length === runCount;
const payloadSensitive = runCount > 1 && uniqueOutcomeTokens.length > 1;
const uniformFailure = runCount > 1 && !allSuccess && uniqueOutcomeTokens.length === 1;

let classification = 'non_uniform_failure';
if (allSuccess) {
  classification = 'all_success';
} else if (runCount === 1) {
  classification = 'single_payload_only';
} else if (payloadSensitive) {
  classification = 'transcript_shape_specific';
} else if (uniformFailure) {
  classification = 'uniform_failure_provider_side_candidate';
}

const successfulPayloads = runs.filter((run) => run.outcome === 'request_succeeded').map((run) => run.payload);
const failingPayloads = runs.filter((run) => run.outcome !== 'request_succeeded').map((run) => run.payload);

const output = {
  mode: 'payload_matrix',
  inputPath,
  inputDir: matrixDir,
  outputDir: outDir,
  payloadCount: runCount,
  successCount: successRuns.length,
  invalidRequestCount: invalidRuns.length,
  otherCount: otherRuns.length,
  classification,
  payloadSensitive,
  uniformFailure,
  allInvalidRequest,
  allSuccess,
  successfulPayloads,
  failingPayloads,
  rootSummary,
  payloadSummaries: runs
};

const summaryLines = [];
summaryLines.push('mode=payload_matrix');
summaryLines.push(`input_dir=${matrixDir}`);
summaryLines.push(`payload_count=${runCount}`);
if (rootSummary.target_url) summaryLines.push(`target_url=${rootSummary.target_url}`);
if (rootSummary.payload_matrix_tsv) summaryLines.push(`payload_matrix_tsv=${rootSummary.payload_matrix_tsv}`);
if (rootSummary.headers_tsv_path) summaryLines.push(`headers_tsv_path=${rootSummary.headers_tsv_path}`);
if (rootSummary.direct_access_token_source) summaryLines.push(`direct_access_token_source=${rootSummary.direct_access_token_source}`);
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

for (const run of runs) {
  summaryLines.push(
    `payload=${run.payload} status=${run.status} outcome=${run.outcome} provider_request_id=${run.providerRequestId || '-'} payload_bytes=${run.payloadBytes || '-'}`
  );
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
