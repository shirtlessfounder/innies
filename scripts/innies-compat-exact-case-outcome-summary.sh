#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

INPUT_PATH="${1:-${INNIES_EXACT_CASE_OUTCOME_SUMMARY_INPUT:-}}"
require_nonempty 'summary input path' "$INPUT_PATH"

SUMMARY_PATH="$INPUT_PATH"
if [[ -d "$INPUT_PATH" ]]; then
  SUMMARY_PATH="${INPUT_PATH%/}/summary.txt"
fi

if [[ ! -f "$SUMMARY_PATH" ]]; then
  echo "error: summary file not found: $SUMMARY_PATH" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "$SUMMARY_PATH")" && pwd)"
OUT_DIR="${INNIES_EXACT_CASE_OUTCOME_SUMMARY_OUT_DIR:-$SOURCE_DIR}"
mkdir -p "$OUT_DIR"

OUTCOME_SUMMARY_FILE="$OUT_DIR/outcome-summary.txt"
CASE_SUMMARY_FILE="$OUT_DIR/case-summary.tsv"
LANE_SUMMARY_FILE="$OUT_DIR/lane-summary.tsv"

node - "$SUMMARY_PATH" "$OUT_DIR" "$OUTCOME_SUMMARY_FILE" "$CASE_SUMMARY_FILE" "$LANE_SUMMARY_FILE" <<'NODE'
const fs = require('fs');

const [
  summaryPath,
  outDir,
  outcomeSummaryPath,
  caseSummaryPath,
  laneSummaryPath
] = process.argv.slice(2);

function parseKeyValueLine(line) {
  const index = line.indexOf('=');
  if (index === -1) {
    return null;
  }
  return {
    key: line.slice(0, index),
    value: line.slice(index + 1)
  };
}

function parseRunLine(line) {
  const entry = {};
  for (const token of line.split(/\s+/)) {
    const parsed = parseKeyValueLine(token);
    if (!parsed) {
      continue;
    }
    entry[parsed.key] = parsed.value;
  }
  if (!entry.case || !entry.status || !entry.outcome) {
    throw new Error(`malformed case outcome row: ${line}`);
  }
  if (!entry.lane) {
    entry.lane = 'single_lane';
  }
  return {
    lane: entry.lane,
    caseName: entry.case,
    status: entry.status,
    outcome: entry.outcome,
    providerRequestId: entry.provider_request_id ?? '',
    requestId: entry.request_id ?? '',
    tokenSource: entry.token_source ?? ''
  };
}

function sortStatuses(values) {
  return Array.from(new Set(values)).sort((left, right) => Number(left) - Number(right));
}

function uniqueInRunOrder(runs, pick) {
  const seen = new Set();
  const ordered = [];
  for (const run of runs) {
    const value = pick(run);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function joinNames(values) {
  if (values.length === 0) {
    return 'none';
  }
  return values.join(',');
}

function isSuccess(run) {
  return run.status.startsWith('2') || run.outcome === 'request_succeeded';
}

const text = fs.readFileSync(summaryPath, 'utf8');
const headers = {};
const runs = [];
let sawExplicitLane = false;

for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) {
    continue;
  }
  if (line.startsWith('lane=') || line.startsWith('case=')) {
    const run = parseRunLine(line);
    if (line.startsWith('lane=')) {
      sawExplicitLane = true;
    }
    runs.push(run);
    continue;
  }
  const parsed = parseKeyValueLine(line);
  if (!parsed) {
    continue;
  }
  headers[parsed.key] = parsed.value;
}

if (runs.length === 0) {
  console.error('error: no case outcome rows found');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const matrixType = sawExplicitLane ? 'exact_case_token_lane' : 'exact_case';
const allRunsSorted = [...runs].sort((left, right) => {
  const statusDiff = Number(left.status) - Number(right.status);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  const outcomeDiff = left.outcome.localeCompare(right.outcome);
  if (outcomeDiff !== 0) {
    return outcomeDiff;
  }
  const laneDiff = left.lane.localeCompare(right.lane);
  if (laneDiff !== 0) {
    return laneDiff;
  }
  return left.caseName.localeCompare(right.caseName);
});

const caseNames = Array.from(new Set(runs.map((run) => run.caseName))).sort();
const laneNames = Array.from(new Set(runs.map((run) => run.lane))).sort();
const statuses = sortStatuses(runs.map((run) => run.status));
const outcomes = uniqueInRunOrder(allRunsSorted, (run) => run.outcome);

const runsByLane = new Map();
for (const laneName of laneNames) {
  runsByLane.set(
    laneName,
    allRunsSorted.filter((run) => run.lane === laneName)
  );
}

const runsByCase = new Map();
for (const caseName of caseNames) {
  runsByCase.set(
    caseName,
    allRunsSorted.filter((run) => run.caseName === caseName)
  );
}

const caseAxisFlips = laneNames.some((laneName) => {
  const laneRuns = runsByLane.get(laneName) ?? [];
  return new Set(laneRuns.map((run) => run.outcome)).size > 1;
});

const laneAxisFlips = caseNames.some((caseName) => {
  const caseRuns = runsByCase.get(caseName) ?? [];
  return new Set(caseRuns.map((run) => run.outcome)).size > 1;
});

let axisClassification = 'no_controlled_axis_flip';
let inference = 'remaining_delta_outside_controlled_case_or_lane_matrix';
if (caseAxisFlips && laneAxisFlips) {
  axisClassification = 'case_and_lane';
  inference = 'controlled_case_and_token_lane_changes_flip_outcome';
} else if (caseAxisFlips) {
  axisClassification = 'case_only';
  inference = 'controlled_case_changes_flip_outcome';
} else if (laneAxisFlips) {
  axisClassification = 'lane_only';
  inference = 'controlled_token_lane_changes_flip_outcome';
}

const successfulCases = caseNames.filter((caseName) => {
  const caseRuns = runsByCase.get(caseName) ?? [];
  return caseRuns.some(isSuccess);
});
const successfulLanes = laneNames.filter((laneName) => {
  const laneRuns = runsByLane.get(laneName) ?? [];
  return laneRuns.some(isSuccess);
});
const failingCases = caseNames.filter((caseName) => !successfulCases.includes(caseName));
const failingLanes = laneNames.filter((laneName) => !successfulLanes.includes(laneName));

const caseSummaryLines = [
  'case\trun_count\tlane_count\tstatuses\toutcomes\tsuccess_lanes\tfailing_lanes'
];
for (const caseName of caseNames) {
  const caseRuns = runsByCase.get(caseName) ?? [];
  const caseStatuses = sortStatuses(caseRuns.map((run) => run.status));
  const caseOutcomes = uniqueInRunOrder(caseRuns, (run) => run.outcome);
  const caseSuccessLanes = Array.from(
    new Set(caseRuns.filter(isSuccess).map((run) => run.lane))
  ).sort();
  const caseFailingLanes = laneNames.filter((laneName) => !caseSuccessLanes.includes(laneName));
  caseSummaryLines.push([
    caseName,
    String(caseRuns.length),
    String(new Set(caseRuns.map((run) => run.lane)).size),
    caseStatuses.join(','),
    caseOutcomes.join(','),
    joinNames(caseSuccessLanes),
    joinNames(caseFailingLanes)
  ].join('\t'));
}

const laneSummaryLines = [
  'lane\trun_count\tcase_count\tstatuses\toutcomes\tsuccess_cases\tfailing_cases'
];
for (const laneName of laneNames) {
  const laneRuns = runsByLane.get(laneName) ?? [];
  const laneStatuses = sortStatuses(laneRuns.map((run) => run.status));
  const laneOutcomes = uniqueInRunOrder(laneRuns, (run) => run.outcome);
  const laneSuccessCases = Array.from(
    new Set(laneRuns.filter(isSuccess).map((run) => run.caseName))
  ).sort();
  const laneFailingCases = caseNames.filter((caseName) => !laneSuccessCases.includes(caseName));
  laneSummaryLines.push([
    laneName,
    String(laneRuns.length),
    String(new Set(laneRuns.map((run) => run.caseName)).size),
    laneStatuses.join(','),
    laneOutcomes.join(','),
    joinNames(laneSuccessCases),
    joinNames(laneFailingCases)
  ].join('\t'));
}

const outcomeSummaryLines = [
  `source_summary=${summaryPath}`,
  `target_url=${headers.target_url ?? ''}`,
  `body_bytes=${headers.body_bytes ?? ''}`,
  `body_sha256=${headers.body_sha256 ?? ''}`,
  `matrix_type=${matrixType}`,
  `run_count=${runs.length}`,
  `case_count=${caseNames.length}`,
  `lane_count=${laneNames.length}`,
  `unique_statuses=${statuses.join(',')}`,
  `unique_outcomes=${outcomes.join(',')}`,
  `case_axis_flips=${caseAxisFlips}`,
  `lane_axis_flips=${laneAxisFlips}`,
  `all_runs_same_outcome=${new Set(runs.map((run) => run.outcome)).size === 1}`,
  `axis_classification=${axisClassification}`,
  `inference=${inference}`,
  `successful_cases=${joinNames(successfulCases)}`,
  `failing_cases=${joinNames(failingCases)}`,
  `successful_lanes=${joinNames(successfulLanes)}`,
  `failing_lanes=${joinNames(failingLanes)}`
];

fs.writeFileSync(caseSummaryPath, `${caseSummaryLines.join('\n')}\n`);
fs.writeFileSync(laneSummaryPath, `${laneSummaryLines.join('\n')}\n`);
fs.writeFileSync(outcomeSummaryPath, `${outcomeSummaryLines.join('\n')}\n`);
NODE

cat "$OUTCOME_SUMMARY_FILE"
printf 'summary_file=%s\n' "$OUTCOME_SUMMARY_FILE"
printf 'case_summary_file=%s\n' "$CASE_SUMMARY_FILE"
printf 'lane_summary_file=%s\n' "$LANE_SUMMARY_FILE"
