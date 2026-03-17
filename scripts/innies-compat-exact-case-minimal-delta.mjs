#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [matrixDirArg, casesDirArgRaw = '', outDirArg] = process.argv.slice(2);

if (!matrixDirArg) {
  console.error('error: missing matrix dir');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing summary output dir');
  process.exit(1);
}

const matrixDir = path.resolve(matrixDirArg);
const outDir = path.resolve(outDirArg);

if (!fs.existsSync(matrixDir) || !fs.statSync(matrixDir).isDirectory()) {
  console.error(`error: matrix dir not found: ${matrixDirArg}`);
  process.exit(1);
}

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

function listCaseFiles(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return [];
  }
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsv'))
    .map((entry) => entry.name)
    .sort();
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function normalizeHeaderName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function normalizeHeaderValue(value) {
  return String(value ?? '').trim();
}

const IGNORED_DELTA_HEADERS = new Set([
  'authorization',
  'content-length',
  'host',
  'x-request-id'
]);

function isFunctionalHeader(name) {
  if (!name) return false;
  if (name.startsWith(':')) return false;
  return !IGNORED_DELTA_HEADERS.has(name);
}

function readHeadersTsv(filePath) {
  const headers = new Map();
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf('\t');
    const headerName = normalizeHeaderName(index === -1 ? line : line.slice(0, index));
    const headerValue = normalizeHeaderValue(index === -1 ? '' : line.slice(index + 1));
    if (!headerName || !isFunctionalHeader(headerName)) continue;
    headers.set(headerName, headerValue);
  }
  return headers;
}

function selectBaselineCase(caseNames) {
  const preferred = ['compat-exact', 'captured-baseline', 'shared'];
  for (const caseName of preferred) {
    if (caseNames.includes(caseName)) {
      return caseName;
    }
  }
  const compatLike = caseNames.find((caseName) => /compat|baseline/.test(caseName));
  return compatLike ?? caseNames[0] ?? null;
}

function parseCaseMatrix() {
  const caseNames = listDirectories(path.join(matrixDir, 'cases'));
  const runs = [];
  for (const caseName of caseNames) {
    const summaryPath = path.join(matrixDir, 'cases', caseName, 'summary.txt');
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
      outcome
    });
  }
  return { mode: 'case_matrix', runs };
}

function parseCaseLaneMatrix() {
  const laneNames = listDirectories(path.join(matrixDir, 'lanes'));
  const runs = [];
  for (const laneName of laneNames) {
    const casesRoot = path.join(matrixDir, 'lanes', laneName, 'cases');
    const caseNames = listDirectories(casesRoot);
    for (const caseName of caseNames) {
      const metaCandidates = [
        path.join(casesRoot, caseName, 'meta.txt'),
        path.join(casesRoot, caseName, 'summary.txt')
      ];
      const metaPath = metaCandidates.find((candidate) => fs.existsSync(candidate));
      if (!metaPath) continue;
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
        outcome
      });
    }
  }
  return { mode: 'case_lane_matrix', runs };
}

function parseMatrixRuns() {
  if (listDirectories(path.join(matrixDir, 'lanes')).length > 0) {
    return parseCaseLaneMatrix();
  }
  if (listDirectories(path.join(matrixDir, 'cases')).length > 0) {
    return parseCaseMatrix();
  }
  console.error(`error: no exact-case matrix artifacts found in ${matrixDirArg}`);
  process.exit(1);
}

function compareHeaders(baselineHeaders, candidateHeaders) {
  const allNames = uniqueSorted([
    ...baselineHeaders.keys(),
    ...candidateHeaders.keys()
  ]);

  const added = [];
  const removed = [];
  const changed = [];

  for (const name of allNames) {
    const inBaseline = baselineHeaders.has(name);
    const inCandidate = candidateHeaders.has(name);
    if (!inBaseline && inCandidate) {
      added.push(name);
      continue;
    }
    if (inBaseline && !inCandidate) {
      removed.push(name);
      continue;
    }
    if (baselineHeaders.get(name) !== candidateHeaders.get(name)) {
      changed.push(name);
    }
  }

  const deltaHeaders = uniqueSorted([...added, ...removed, ...changed]);
  return {
    added,
    removed,
    changed,
    deltaHeaders,
    deltaHeaderCount: deltaHeaders.length
  };
}

function choosePrimaryCandidate(candidates) {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((left, right) => {
    if (left.deltaHeaderCount !== right.deltaHeaderCount) {
      return left.deltaHeaderCount - right.deltaHeaderCount;
    }
    if (left.successfulLanes.length !== right.successfulLanes.length) {
      return right.successfulLanes.length - left.successfulLanes.length;
    }
    return left.case.localeCompare(right.case);
  })[0];
}

const rootSummaryPath = path.join(matrixDir, 'summary.txt');
const rootSummary = fs.existsSync(rootSummaryPath) ? readKeyValueFile(rootSummaryPath) : {};
const resolvedCasesDir = path.resolve(casesDirArgRaw || rootSummary.cases_dir || '');

if (!resolvedCasesDir || !fs.existsSync(resolvedCasesDir) || !fs.statSync(resolvedCasesDir).isDirectory()) {
  console.error('error: missing exact-case TSV directory (pass it as arg 2 or set cases_dir in matrix summary.txt)');
  process.exit(1);
}

const { mode, runs } = parseMatrixRuns();

if (runs.length === 0) {
  console.error(`error: no runnable matrix entries found in ${matrixDirArg}`);
  process.exit(1);
}

const runCaseNames = uniqueSorted(runs.map((run) => run.case));
const caseFiles = listCaseFiles(resolvedCasesDir);
const caseHeadersByName = new Map();

for (const fileName of caseFiles) {
  const caseName = fileName.replace(/\.tsv$/, '');
  caseHeadersByName.set(caseName, readHeadersTsv(path.join(resolvedCasesDir, fileName)));
}

for (const caseName of runCaseNames) {
  if (!caseHeadersByName.has(caseName)) {
    console.error(`error: missing case TSV for ${caseName} in ${resolvedCasesDir}`);
    process.exit(1);
  }
}

const baselineCase = selectBaselineCase(runCaseNames);
if (!baselineCase) {
  console.error('error: could not determine baseline case');
  process.exit(1);
}

const baselineHeaders = caseHeadersByName.get(baselineCase);
const laneNames = uniqueSorted(runs.map((run) => run.lane));
const baselineOutcomeByLane = {};

for (const laneName of laneNames) {
  const baselineRun = runs.find((run) => run.lane === laneName && run.case === baselineCase);
  if (!baselineRun) {
    console.error(`error: baseline case ${baselineCase} missing for lane ${laneName}`);
    process.exit(1);
  }
  baselineOutcomeByLane[laneName] = baselineRun.outcome;
}

const perCase = {};
for (const caseName of runCaseNames) {
  const comparison = compareHeaders(baselineHeaders, caseHeadersByName.get(caseName));
  const caseRuns = runs.filter((run) => run.case === caseName);
  const successfulLanes = uniqueSorted(caseRuns.filter((run) => run.outcome === 'request_succeeded').map((run) => run.lane));
  const failingLanes = laneNames.filter((laneName) => !successfulLanes.includes(laneName));
  const flippedLanes = uniqueSorted(
    caseRuns
      .filter((run) => run.outcome !== baselineOutcomeByLane[run.lane])
      .map((run) => run.lane)
  );

  perCase[caseName] = {
    case: caseName,
    ...comparison,
    successfulLanes,
    failingLanes,
    flippedLanes,
    runs: caseRuns
  };
}

const successCandidates = Object.values(perCase)
  .filter((entry) => entry.case !== baselineCase)
  .filter((entry) => entry.successfulLanes.length > 0);
const primaryMinimalSuccess = choosePrimaryCandidate(successCandidates);
const minimalSuccessCandidates = primaryMinimalSuccess === null
  ? []
  : successCandidates.filter((entry) => entry.deltaHeaderCount === primaryMinimalSuccess.deltaHeaderCount);

const outcomeFlipCandidates = Object.values(perCase)
  .filter((entry) => entry.case !== baselineCase)
  .filter((entry) => entry.flippedLanes.length > 0);
const primaryMinimalOutcomeFlip = choosePrimaryCandidate(outcomeFlipCandidates);
const minimalOutcomeFlipCandidates = primaryMinimalOutcomeFlip === null
  ? []
  : outcomeFlipCandidates.filter((entry) => entry.deltaHeaderCount === primaryMinimalOutcomeFlip.deltaHeaderCount);

const perLane = {};
for (const laneName of laneNames) {
  const laneSuccessCandidates = Object.values(perCase)
    .filter((entry) => entry.case !== baselineCase)
    .filter((entry) => entry.runs.some((run) => run.lane === laneName && run.outcome === 'request_succeeded'));
  const minimalSuccess = choosePrimaryCandidate(laneSuccessCandidates);
  perLane[laneName] = {
    baselineOutcome: baselineOutcomeByLane[laneName],
    minimalSuccess: minimalSuccess
      ? {
          case: minimalSuccess.case,
          deltaHeaderCount: minimalSuccess.deltaHeaderCount,
          deltaHeaders: minimalSuccess.deltaHeaders
        }
      : null
  };
}

const output = {
  mode,
  matrixDir,
  casesDir: resolvedCasesDir,
  baselineCase,
  baselineOutcomeByLane,
  bodyBytes: rootSummary.body_bytes || '',
  bodySha256: rootSummary.body_sha256 || '',
  laneNames,
  caseNames: runCaseNames,
  minimalSuccess: primaryMinimalSuccess
    ? {
        case: primaryMinimalSuccess.case,
        deltaHeaderCount: primaryMinimalSuccess.deltaHeaderCount,
        deltaHeaders: primaryMinimalSuccess.deltaHeaders,
        successfulLanes: primaryMinimalSuccess.successfulLanes
      }
    : null,
  minimalSuccessCases: minimalSuccessCandidates.map((entry) => entry.case),
  minimalOutcomeFlip: primaryMinimalOutcomeFlip
    ? {
        case: primaryMinimalOutcomeFlip.case,
        deltaHeaderCount: primaryMinimalOutcomeFlip.deltaHeaderCount,
        deltaHeaders: primaryMinimalOutcomeFlip.deltaHeaders,
        flippedLanes: primaryMinimalOutcomeFlip.flippedLanes
      }
    : null,
  minimalOutcomeFlipCases: minimalOutcomeFlipCandidates.map((entry) => entry.case),
  perCase,
  perLane
};

fs.mkdirSync(outDir, { recursive: true });

const summaryLines = [
  `mode=${mode}`,
  `matrix_dir=${matrixDir}`,
  `cases_dir=${resolvedCasesDir}`,
  `baseline_case=${baselineCase}`,
  `baseline_outcome=${baselineOutcomeByLane[laneNames[0]] ?? ''}`,
  `case_count=${runCaseNames.length}`,
  `lane_count=${laneNames.length}`
];

if (output.bodyBytes) summaryLines.push(`body_bytes=${output.bodyBytes}`);
if (output.bodySha256) summaryLines.push(`body_sha256=${output.bodySha256}`);

summaryLines.push(
  `minimal_success_delta_header_count=${primaryMinimalSuccess ? primaryMinimalSuccess.deltaHeaderCount : 0}`
);
summaryLines.push(`minimal_success_cases=${joinNames(output.minimalSuccessCases)}`);
summaryLines.push(
  `minimal_success_lanes=${primaryMinimalSuccess ? joinNames(primaryMinimalSuccess.successfulLanes) : '-'}`
);
summaryLines.push(
  `minimal_success_delta_headers=${primaryMinimalSuccess ? joinNames(primaryMinimalSuccess.deltaHeaders) : '-'}`
);
summaryLines.push(
  `minimal_outcome_flip_cases=${joinNames(output.minimalOutcomeFlipCases)}`
);

for (const caseName of runCaseNames) {
  const entry = perCase[caseName];
  summaryLines.push(
    `case=${caseName} delta_header_count=${entry.deltaHeaderCount} delta_headers=${joinNames(entry.deltaHeaders)} successful_lanes=${joinNames(entry.successfulLanes)} failing_lanes=${joinNames(entry.failingLanes)}`
  );
}

for (const laneName of laneNames) {
  const lane = perLane[laneName];
  const minimal = lane.minimalSuccess;
  summaryLines.push(
    `lane=${laneName} minimal_success_case=${minimal ? minimal.case : '-'} minimal_success_delta_header_count=${minimal ? minimal.deltaHeaderCount : 0} minimal_success_delta_headers=${minimal ? joinNames(minimal.deltaHeaders) : '-'}`
  );
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
