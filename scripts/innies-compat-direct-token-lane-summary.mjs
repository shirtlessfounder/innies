#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [inputPathArg, outDirArg] = process.argv.slice(2);

if (!inputPathArg) {
  console.error('error: missing direct token lane summary input path');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing summary output dir');
  process.exit(1);
}

const inputPath = path.resolve(inputPathArg);
const outDir = path.resolve(outDirArg);

if (!fs.existsSync(inputPath)) {
  console.error(`error: direct token lane summary input path not found: ${inputPathArg}`);
  process.exit(1);
}

const matrixDir = fs.statSync(inputPath).isDirectory() ? inputPath : path.dirname(inputPath);
const lanesDir = path.join(matrixDir, 'lanes');
const rootSummaryPath = path.join(matrixDir, 'summary.txt');

if (!fs.existsSync(lanesDir) || !fs.statSync(lanesDir).isDirectory()) {
  console.error(`error: direct token lane artifacts not found in ${matrixDir}`);
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
const laneNames = listDirectories(lanesDir);

if (laneNames.length === 0) {
  console.error(`error: no token lane artifacts found in ${matrixDir}`);
  process.exit(1);
}

const runs = laneNames.map((laneName) => {
  const laneDir = path.join(lanesDir, laneName);
  const metaCandidates = [
    path.join(laneDir, 'meta.txt'),
    path.join(laneDir, 'summary.txt')
  ];
  const metaPath = metaCandidates.find((candidate) => fs.existsSync(candidate));
  if (!metaPath) {
    console.error(`error: missing lane meta file: ${laneDir}`);
    process.exit(1);
  }
  const summary = readKeyValueFile(metaPath);
  const status = Number(summary.status ?? NaN);
  const outcome = summary.outcome ?? '';
  if (!Number.isFinite(status) || !outcome) {
    console.error(`error: invalid lane meta file: ${metaPath}`);
    process.exit(1);
  }
  return {
    lane: summary.lane || laneName,
    status,
    outcome,
    providerRequestId: summary.provider_request_id || '',
    requestId: summary.request_id || '',
    tokenSource: summary.token_source || '',
    targetUrl: summary.target_url || '',
    payloadPath: summary.payload_path || '',
    headersTsvPath: summary.headers_tsv_path || ''
  };
});

const runCount = runs.length;
const successRuns = runs.filter((run) => run.outcome === 'request_succeeded');
const invalidRuns = runs.filter((run) => run.outcome === 'reproduced_invalid_request_error');
const otherRuns = runs.filter((run) => !['request_succeeded', 'reproduced_invalid_request_error'].includes(run.outcome));
const uniqueOutcomeTokens = [...new Set(runs.map(outcomeToken))];
const tokenLaneSensitive = runCount > 1 && uniqueOutcomeTokens.length > 1;
const allSuccess = successRuns.length === runCount;
const allInvalidRequest = invalidRuns.length === runCount;
const uniformFailure = runCount > 1 && !allSuccess && uniqueOutcomeTokens.length === 1;

let classification = 'non_uniform_failure';
if (allSuccess) {
  classification = 'all_success';
} else if (runCount === 1) {
  classification = 'single_lane_only';
} else if (tokenLaneSensitive) {
  classification = 'credential_lane_specific';
} else if (uniformFailure) {
  classification = 'uniform_failure_provider_side_candidate';
}

const successfulLanes = runs.filter((run) => run.outcome === 'request_succeeded').map((run) => run.lane);
const failingLanes = runs.filter((run) => run.outcome !== 'request_succeeded').map((run) => run.lane);
const summaryTargetUrl = rootSummary.target_url || runs[0]?.targetUrl || '';
const summaryPayloadPath = rootSummary.payload_path || runs[0]?.payloadPath || '';
const summaryHeadersTsvPath = rootSummary.headers_tsv_path || runs[0]?.headersTsvPath || '';
const summaryTokenMatrixTsv = rootSummary.token_matrix_tsv || '';

const output = {
  mode: 'direct_token_lane_matrix',
  inputPath,
  inputDir: matrixDir,
  outputDir: outDir,
  laneCount: runCount,
  successCount: successRuns.length,
  invalidRequestCount: invalidRuns.length,
  otherCount: otherRuns.length,
  classification,
  tokenLaneSensitive,
  uniformFailure,
  allInvalidRequest,
  allSuccess,
  successfulLanes,
  failingLanes,
  rootSummary,
  laneSummaries: runs
};

const summaryLines = [];
summaryLines.push('mode=direct_token_lane_matrix');
summaryLines.push(`input_dir=${matrixDir}`);
summaryLines.push(`lane_count=${runCount}`);
if (summaryTargetUrl) summaryLines.push(`target_url=${summaryTargetUrl}`);
if (summaryPayloadPath) summaryLines.push(`payload_path=${summaryPayloadPath}`);
if (summaryHeadersTsvPath) summaryLines.push(`headers_tsv_path=${summaryHeadersTsvPath}`);
if (summaryTokenMatrixTsv) summaryLines.push(`token_matrix_tsv=${summaryTokenMatrixTsv}`);
summaryLines.push(`success_count=${successRuns.length}`);
summaryLines.push(`invalid_request_count=${invalidRuns.length}`);
summaryLines.push(`other_count=${otherRuns.length}`);
summaryLines.push(`classification=${classification}`);
summaryLines.push(`token_lane_sensitive=${String(tokenLaneSensitive)}`);
summaryLines.push(`uniform_failure=${String(uniformFailure)}`);
summaryLines.push(`all_invalid_request=${String(allInvalidRequest)}`);
summaryLines.push(`all_success=${String(allSuccess)}`);
summaryLines.push(`successful_lanes=${joinNames(successfulLanes)}`);
summaryLines.push(`failing_lanes=${joinNames(failingLanes)}`);

for (const run of runs) {
  summaryLines.push(
    `lane=${run.lane} status=${run.status} outcome=${run.outcome} provider_request_id=${run.providerRequestId || '-'} request_id=${run.requestId || '-'} token_source=${run.tokenSource || '-'}`
  );
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
