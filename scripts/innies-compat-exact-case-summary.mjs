#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [inputDirArg, outDirArg] = process.argv.slice(2);

if (!inputDirArg) {
  console.error('error: missing matrix input dir');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing summary output dir');
  process.exit(1);
}

const inputDir = path.resolve(inputDirArg);
const outDir = path.resolve(outDirArg);

if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  console.error(`error: matrix input dir not found: ${inputDirArg}`);
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
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function normalizeBoolean(value) {
  return String(value).toLowerCase() === 'true';
}

function outcomeToken(run) {
  return `${run.status}:${run.outcome}`;
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function parseCaseMatrix(caseNames) {
  const runs = [];
  for (const caseName of caseNames) {
    const summaryPath = path.join(inputDir, 'cases', caseName, 'summary.txt');
    const summary = readKeyValueFile(summaryPath);
    const status = Number(summary.status ?? NaN);
    const outcome = summary.outcome ?? '';
    if (!Number.isFinite(status) || !outcome) {
      console.error(`error: invalid case summary file: ${summaryPath}`);
      process.exit(1);
    }
    runs.push({
      lane: 'direct',
      case: summary.case || caseName,
      status,
      outcome,
      providerRequestId: summary.provider_request_id || '',
      anthropicBeta: summary.anthropic_beta || '',
      identityHeaders: normalizeBoolean(summary.identity_headers || 'false')
    });
  }
  return runs;
}

function parseCaseLaneMatrix(laneNames) {
  const runs = [];
  for (const laneName of laneNames) {
    const casesRoot = path.join(inputDir, 'lanes', laneName, 'cases');
    const caseNames = listDirectories(casesRoot);
    for (const caseName of caseNames) {
      const metaCandidates = [
        path.join(casesRoot, caseName, 'meta.txt'),
        path.join(casesRoot, caseName, 'summary.txt')
      ];
      const metaPath = metaCandidates.find((candidate) => fs.existsSync(candidate));
      if (!metaPath) {
        continue;
      }
      const summary = readKeyValueFile(metaPath);
      const status = Number(summary.status ?? NaN);
      const outcome = summary.outcome ?? '';
      if (!Number.isFinite(status) || !outcome) {
        console.error(`error: invalid lane/case summary file: ${metaPath}`);
        process.exit(1);
      }
      runs.push({
        lane: summary.lane || laneName,
        case: summary.case || caseName,
        status,
        outcome,
        providerRequestId: summary.provider_request_id || '',
        tokenSource: summary.token_source || ''
      });
    }
  }
  return runs;
}

const rootSummaryPath = path.join(inputDir, 'summary.txt');
const rootSummary = fs.existsSync(rootSummaryPath) ? readKeyValueFile(rootSummaryPath) : {};

const laneNames = listDirectories(path.join(inputDir, 'lanes'));
const caseNamesFromRoot = listDirectories(path.join(inputDir, 'cases'));

let mode;
let runs;

if (laneNames.length > 0) {
  mode = 'case_lane_matrix';
  runs = parseCaseLaneMatrix(laneNames);
} else if (caseNamesFromRoot.length > 0) {
  mode = 'case_matrix';
  runs = parseCaseMatrix(caseNamesFromRoot);
} else {
  console.error(`error: no exact-case matrix artifacts found in ${inputDir}`);
  process.exit(1);
}

if (runs.length === 0) {
  console.error(`error: no runnable matrix entries found in ${inputDir}`);
  process.exit(1);
}

const caseNames = [...new Set(runs.map((run) => run.case))].sort();
const runLaneNames = [...new Set(runs.map((run) => run.lane))].sort();
const runCount = runs.length;
const successRuns = runs.filter((run) => run.outcome === 'request_succeeded');
const invalidRuns = runs.filter((run) => run.outcome === 'reproduced_invalid_request_error');
const otherRuns = runs.filter((run) => !['request_succeeded', 'reproduced_invalid_request_error'].includes(run.outcome));

const casePatterns = caseNames.map((caseName) =>
  runLaneNames.map((laneName) => {
    const run = runs.find((candidate) => candidate.case === caseName && candidate.lane === laneName);
    return run ? outcomeToken(run) : 'missing';
  }).join('|')
);

const lanePatterns = runLaneNames.map((laneName) =>
  caseNames.map((caseName) => {
    const run = runs.find((candidate) => candidate.case === caseName && candidate.lane === laneName);
    return run ? outcomeToken(run) : 'missing';
  }).join('|')
);

const uniqueOutcomeTokens = [...new Set(runs.map(outcomeToken))];
const headerSensitive = caseNames.length > 1 && new Set(casePatterns).size > 1;
const tokenLaneSensitive = runLaneNames.length > 1 && new Set(lanePatterns).size > 1;
const allSuccess = successRuns.length === runCount;
const allInvalidRequest = invalidRuns.length === runCount;
const uniformFailure = !allSuccess && uniqueOutcomeTokens.length === 1;

let classification = 'non_uniform_failure';
if (allSuccess) {
  classification = 'all_success';
} else if (uniformFailure) {
  classification = 'uniform_failure_provider_side_candidate';
} else if (headerSensitive && tokenLaneSensitive) {
  classification = 'mixed_case_and_lane_specific';
} else if (headerSensitive) {
  classification = 'header_case_specific';
} else if (tokenLaneSensitive) {
  classification = 'credential_lane_specific';
}

const caseSummaries = caseNames.map((caseName) => {
  const caseRuns = runs.filter((run) => run.case === caseName);
  const successfulLanes = [...new Set(caseRuns.filter((run) => run.outcome === 'request_succeeded').map((run) => run.lane))].sort();
  const failingLanes = runLaneNames.filter((laneName) => !successfulLanes.includes(laneName));
  return {
    case: caseName,
    successCount: caseRuns.filter((run) => run.outcome === 'request_succeeded').length,
    invalidRequestCount: caseRuns.filter((run) => run.outcome === 'reproduced_invalid_request_error').length,
    otherCount: caseRuns.filter((run) => !['request_succeeded', 'reproduced_invalid_request_error'].includes(run.outcome)).length,
    successfulLanes,
    failingLanes
  };
});

const laneSummaries = runLaneNames.map((laneName) => {
  const laneRuns = runs.filter((run) => run.lane === laneName);
  const successfulCases = [...new Set(laneRuns.filter((run) => run.outcome === 'request_succeeded').map((run) => run.case))].sort();
  const failingCases = caseNames.filter((caseName) => !successfulCases.includes(caseName));
  return {
    lane: laneName,
    successCount: laneRuns.filter((run) => run.outcome === 'request_succeeded').length,
    invalidRequestCount: laneRuns.filter((run) => run.outcome === 'reproduced_invalid_request_error').length,
    otherCount: laneRuns.filter((run) => !['request_succeeded', 'reproduced_invalid_request_error'].includes(run.outcome)).length,
    successfulCases,
    failingCases
  };
});

const successfulCases = caseSummaries.filter((summary) => summary.successCount > 0).map((summary) => summary.case);
const failingCases = caseSummaries.filter((summary) => summary.successCount === 0).map((summary) => summary.case);
const successfulLanes = laneSummaries.filter((summary) => summary.successCount > 0).map((summary) => summary.lane);
const failingLanes = laneSummaries.filter((summary) => summary.successCount === 0).map((summary) => summary.lane);

const output = {
  mode,
  inputDir,
  outputDir: outDir,
  runCount,
  caseCount: caseNames.length,
  laneCount: runLaneNames.length,
  successCount: successRuns.length,
  invalidRequestCount: invalidRuns.length,
  otherCount: otherRuns.length,
  classification,
  headerSensitive,
  tokenLaneSensitive,
  uniformFailure,
  allInvalidRequest,
  allSuccess,
  successfulCases,
  failingCases,
  successfulLanes,
  failingLanes,
  rootSummary,
  caseSummaries,
  laneSummaries,
  runs
};

const summaryLines = [];
summaryLines.push(`mode=${mode}`);
summaryLines.push(`input_dir=${inputDir}`);
summaryLines.push(`run_count=${runCount}`);
summaryLines.push(`case_count=${caseNames.length}`);
summaryLines.push(`lane_count=${runLaneNames.length}`);
if (rootSummary.body_bytes) summaryLines.push(`body_bytes=${rootSummary.body_bytes}`);
if (rootSummary.body_sha256) summaryLines.push(`body_sha256=${rootSummary.body_sha256}`);
if (rootSummary.target_url) summaryLines.push(`target_url=${rootSummary.target_url}`);
summaryLines.push(`success_count=${successRuns.length}`);
summaryLines.push(`invalid_request_count=${invalidRuns.length}`);
summaryLines.push(`other_count=${otherRuns.length}`);
summaryLines.push(`classification=${classification}`);
summaryLines.push(`header_sensitive=${String(headerSensitive)}`);
summaryLines.push(`token_lane_sensitive=${String(tokenLaneSensitive)}`);
summaryLines.push(`uniform_failure=${String(uniformFailure)}`);
summaryLines.push(`all_invalid_request=${String(allInvalidRequest)}`);
summaryLines.push(`all_success=${String(allSuccess)}`);
summaryLines.push(`successful_cases=${joinNames(successfulCases)}`);
summaryLines.push(`failing_cases=${joinNames(failingCases)}`);
summaryLines.push(`successful_lanes=${joinNames(successfulLanes)}`);
summaryLines.push(`failing_lanes=${joinNames(failingLanes)}`);

for (const summary of laneSummaries) {
  if (mode !== 'case_lane_matrix') {
    continue;
  }
  summaryLines.push(
    `lane=${summary.lane} success_count=${summary.successCount} invalid_request_count=${summary.invalidRequestCount} successful_cases=${joinNames(summary.successfulCases)} failing_cases=${joinNames(summary.failingCases)}`
  );
}

for (const summary of caseSummaries) {
  summaryLines.push(
    `case=${summary.case} success_count=${summary.successCount} invalid_request_count=${summary.invalidRequestCount} successful_lanes=${joinNames(summary.successfulLanes)} failing_lanes=${joinNames(summary.failingLanes)}`
  );
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
