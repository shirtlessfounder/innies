#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [inputDirArg, outDirArg] = process.argv.slice(2);

const CASE_PRIORITY = [
  'compat-exact',
  'shared',
  'compat-with-direct-beta',
  'compat-with-direct-identity',
  'compat-with-direct-beta-and-identity',
  'compat-with-all-direct-deltas',
  'direct-exact'
];

const CASE_TO_DELTA = {
  'compat-exact': 'none',
  'shared': 'shared_headers_only',
  'compat-with-direct-beta': 'beta_only',
  'compat-with-direct-identity': 'identity_only',
  'compat-with-direct-beta-and-identity': 'beta_and_identity',
  'compat-with-all-direct-deltas': 'additional_direct_delta',
  'direct-exact': 'direct_exact_only'
};

const CASE_TO_CONCLUSION = {
  'shared': 'shared_headers_only_candidate',
  'compat-with-direct-beta': 'beta_headers_only_candidate',
  'compat-with-direct-identity': 'identity_headers_only_candidate',
  'compat-with-direct-beta-and-identity': 'beta_and_identity_candidate',
  'compat-with-all-direct-deltas': 'additional_direct_delta_candidate',
  'direct-exact': 'direct_exact_only_candidate'
};

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!inputDirArg) {
  fail('missing matrix input dir');
}

if (!outDirArg) {
  fail('missing minimal-delta output dir');
}

const inputDir = path.resolve(inputDirArg);
const outDir = path.resolve(outDirArg);

if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  fail(`matrix input dir not found: ${inputDirArg}`);
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
    .map((entry) => entry.name);
}

function sortCaseNames(caseNames) {
  return caseNames.slice().sort((left, right) => {
    const leftIndex = CASE_PRIORITY.indexOf(left);
    const rightIndex = CASE_PRIORITY.indexOf(right);
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return left.localeCompare(right);
  });
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function parseCaseMatrix(caseNames) {
  return caseNames.map((caseName) => {
    const summaryPath = path.join(inputDir, 'cases', caseName, 'summary.txt');
    if (!fs.existsSync(summaryPath)) {
      fail(`missing case summary: ${summaryPath}`);
    }
    const summary = readKeyValueFile(summaryPath);
    const status = Number(summary.status ?? NaN);
    const outcome = summary.outcome ?? '';
    if (!Number.isFinite(status) || !outcome) {
      fail(`invalid case summary: ${summaryPath}`);
    }
    return {
      lane: 'direct',
      case: summary.case || caseName,
      status,
      outcome
    };
  });
}

function parseCaseLaneMatrix(laneNames) {
  const runs = [];
  for (const laneName of laneNames) {
    const casesRoot = path.join(inputDir, 'lanes', laneName, 'cases');
    const caseNames = listDirectories(casesRoot);
    for (const caseName of caseNames) {
      const summaryPath = ['meta.txt', 'summary.txt']
        .map((fileName) => path.join(casesRoot, caseName, fileName))
        .find((candidate) => fs.existsSync(candidate));
      if (!summaryPath) continue;
      const summary = readKeyValueFile(summaryPath);
      const status = Number(summary.status ?? NaN);
      const outcome = summary.outcome ?? '';
      if (!Number.isFinite(status) || !outcome) {
        fail(`invalid lane/case summary: ${summaryPath}`);
      }
      runs.push({
        lane: summary.lane || laneName,
        case: summary.case || caseName,
        status,
        outcome
      });
    }
  }
  return runs;
}

function deltaForCase(caseName) {
  if (!caseName) return null;
  return CASE_TO_DELTA[caseName] ?? 'custom_case';
}

function conclusionForSharedCase(caseName) {
  if (!caseName) return 'no_controlled_case_success';
  return CASE_TO_CONCLUSION[caseName] ?? 'custom_case_candidate';
}

const rootSummaryPath = path.join(inputDir, 'summary.txt');
const rootSummary = fs.existsSync(rootSummaryPath) ? readKeyValueFile(rootSummaryPath) : {};

const laneNames = listDirectories(path.join(inputDir, 'lanes')).sort();
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
  fail(`no exact-case matrix artifacts found in ${inputDir}`);
}

if (runs.length === 0) {
  fail(`no runnable matrix entries found in ${inputDir}`);
}

const caseNames = sortCaseNames([...new Set(runs.map((run) => run.case))]);
const runLaneNames = [...new Set(runs.map((run) => run.lane))].sort();
const baselineCase = caseNames.includes('compat-exact') ? 'compat-exact' : (caseNames[0] ?? null);

function findRun(laneName, caseName) {
  return runs.find((run) => run.lane === laneName && run.case === caseName) ?? null;
}

const laneAnalyses = runLaneNames.map((laneName) => {
  const baselineRun = baselineCase ? findRun(laneName, baselineCase) : null;
  const successfulCases = caseNames.filter((caseName) => {
    const run = findRun(laneName, caseName);
    return run?.outcome === 'request_succeeded';
  });
  const minimalSuccessCase = successfulCases[0] ?? null;
  const baselineOutcome = baselineRun?.outcome ?? 'missing';

  return {
    lane: laneName,
    baselineOutcome,
    baselineReproduced: baselineOutcome === 'reproduced_invalid_request_error',
    minimalSuccessCase,
    minimalSuccessDelta: deltaForCase(minimalSuccessCase),
    successfulCases
  };
});

const baselineDoesNotReproduce = laneAnalyses.some((analysis) => analysis.baselineOutcome === 'request_succeeded');
const successfulLaneAnalyses = laneAnalyses.filter((analysis) => analysis.minimalSuccessCase !== null);
const blockedLanes = laneAnalyses
  .filter((analysis) => analysis.minimalSuccessCase === null)
  .map((analysis) => analysis.lane);
const successfulLanes = successfulLaneAnalyses.map((analysis) => analysis.lane);

const uniqueMinimalSuccessCases = [...new Set(successfulLaneAnalyses.map((analysis) => analysis.minimalSuccessCase))];
const sharedMinimalSuccessCase = (
  successfulLaneAnalyses.length > 0 &&
  blockedLanes.length === 0 &&
  uniqueMinimalSuccessCases.length === 1
) ? uniqueMinimalSuccessCases[0] : null;

let conclusion;
if (baselineDoesNotReproduce) {
  conclusion = 'baseline_does_not_reproduce';
} else if (successfulLaneAnalyses.length === 0) {
  conclusion = 'no_controlled_case_success';
} else if (mode === 'case_lane_matrix' && (blockedLanes.length > 0 || uniqueMinimalSuccessCases.length > 1)) {
  conclusion = 'lane_specific_followup_required';
} else {
  conclusion = conclusionForSharedCase(sharedMinimalSuccessCase ?? successfulLaneAnalyses[0].minimalSuccessCase);
}

const minimalSuccessCase = mode === 'case_matrix'
  ? (laneAnalyses[0]?.minimalSuccessCase ?? null)
  : sharedMinimalSuccessCase;

const minimalSuccessDelta = deltaForCase(minimalSuccessCase);

const output = {
  mode,
  inputDir,
  outputDir: outDir,
  caseCount: caseNames.length,
  laneCount: runLaneNames.length,
  baselineCase,
  baselineReproduced: laneAnalyses.every((analysis) => analysis.baselineReproduced),
  baselineDoesNotReproduce,
  conclusion,
  minimalSuccessCase,
  minimalSuccessDelta,
  sharedMinimalSuccessCase,
  sharedMinimalSuccessDelta: deltaForCase(sharedMinimalSuccessCase),
  successfulLanes,
  blockedLanes,
  bodyBytes: rootSummary.body_bytes ?? null,
  bodySha256: rootSummary.body_sha256 ?? null,
  laneAnalyses
};

const summaryLines = [
  `mode=${mode}`,
  `input_dir=${inputDir}`,
  `case_count=${caseNames.length}`,
  `lane_count=${runLaneNames.length}`,
  `baseline_case=${baselineCase ?? '-'}`,
  `baseline_reproduced=${String(output.baselineReproduced)}`,
  `baseline_does_not_reproduce=${String(baselineDoesNotReproduce)}`,
  `conclusion=${conclusion}`,
  `minimal_success_case=${minimalSuccessCase ?? '-'}`,
  `minimal_success_delta=${minimalSuccessDelta ?? '-'}`,
  `shared_minimal_success_case=${sharedMinimalSuccessCase ?? '-'}`,
  `shared_minimal_success_delta=${output.sharedMinimalSuccessDelta ?? '-'}`,
  `successful_lanes=${joinNames(successfulLanes)}`,
  `blocked_lanes=${joinNames(blockedLanes)}`
];

if (output.bodyBytes) summaryLines.push(`body_bytes=${output.bodyBytes}`);
if (output.bodySha256) summaryLines.push(`body_sha256=${output.bodySha256}`);

for (const analysis of laneAnalyses) {
  summaryLines.push(
    `lane=${analysis.lane} baseline_outcome=${analysis.baselineOutcome} minimal_success_case=${analysis.minimalSuccessCase ?? '-'} minimal_success_delta=${analysis.minimalSuccessDelta ?? '-'} successful_cases=${joinNames(analysis.successfulCases)}`
  );
}

fs.writeFileSync(path.join(outDir, 'minimal-delta.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'minimal-delta.txt'), `${summaryLines.join('\n')}\n`);
