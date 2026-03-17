#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [
  exactCaseArg,
  minimalDeltaArg,
  payloadArg,
  tokenLaneArg,
  outDirArg
] = process.argv.slice(2);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!outDirArg) {
  fail('missing report output dir');
}

const outDir = path.resolve(outDirArg);
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

function resolveSummaryPath(inputArg, fallbacks) {
  if (!inputArg || inputArg === '-') return null;
  const resolved = path.resolve(inputArg);
  if (!fs.existsSync(resolved)) {
    fail(`evidence input path not found: ${inputArg}`);
  }
  if (fs.statSync(resolved).isFile()) {
    return resolved;
  }
  for (const fileName of fallbacks) {
    const candidate = path.join(resolved, fileName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  fail(`summary file not found in ${resolved}`);
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function parseSummary(axis, inputArg, fallbacks) {
  const summaryPath = resolveSummaryPath(inputArg, fallbacks);
  if (!summaryPath) return null;
  const data = readKeyValueFile(summaryPath);
  return {
    axis,
    summaryPath,
    inputPath: path.resolve(inputArg),
    data
  };
}

const exactCase = parseSummary('exact_case', exactCaseArg, ['summary.txt']);
const minimalDelta = parseSummary('minimal_delta', minimalDeltaArg, ['summary.txt', 'minimal-delta.txt']);
const payload = parseSummary('payload', payloadArg, ['summary.txt']);
const tokenLane = parseSummary('token_lane', tokenLaneArg, ['summary.txt']);

const presentAxes = [exactCase, minimalDelta, payload, tokenLane]
  .filter(Boolean)
  .map((entry) => entry.axis);

if (presentAxes.length === 0) {
  fail('at least one evidence input path is required');
}

const exactCaseClassification = exactCase?.data.classification ?? '';
const minimalDeltaConclusion = minimalDelta?.data.conclusion ?? '';
const payloadClassification = payload?.data.classification ?? '';
const tokenLaneClassification = tokenLane?.data.classification ?? '';
const minimalSuccessCase = minimalDelta?.data.minimal_success_case ?? '';
const minimalSuccessDelta = minimalDelta?.data.minimal_success_delta ?? '';
const bodySha256 =
  exactCase?.data.body_sha256 ??
  minimalDelta?.data.body_sha256 ??
  payload?.data.body_sha256 ??
  tokenLane?.data.body_sha256 ??
  '';

let overallClassification = 'insufficient_evidence';
let nextHypothesis = 'collect_more_evidence';

const explicitHeaderCandidate = [
  'shared_headers_only_candidate',
  'beta_headers_only_candidate',
  'identity_headers_only_candidate',
  'beta_and_identity_candidate',
  'additional_direct_delta_candidate',
  'direct_exact_only_candidate'
].includes(minimalDeltaConclusion);

if (explicitHeaderCandidate) {
  overallClassification = 'header_delta_specific';
  nextHypothesis = minimalDeltaConclusion;
} else if (exactCaseClassification === 'header_case_specific') {
  overallClassification = 'header_delta_specific';
  nextHypothesis = 'header_delta_followup_required';
} else if (
  exactCaseClassification === 'mixed_case_and_lane_specific' ||
  minimalDeltaConclusion === 'lane_specific_followup_required'
) {
  overallClassification = 'mixed_header_and_lane_specific';
  nextHypothesis = 'lane_specific_followup_required';
} else if (
  exactCaseClassification === 'credential_lane_specific' ||
  tokenLaneClassification === 'credential_lane_specific'
 ) {
  overallClassification = 'credential_lane_specific';
  nextHypothesis = 'credential_lane_specific';
} else if (payloadClassification === 'transcript_shape_specific') {
  overallClassification = 'transcript_shape_specific';
  nextHypothesis = 'transcript_shape_specific';
} else {
  const providerSideSignals = [
    exactCaseClassification === 'uniform_failure_provider_side_candidate',
    payloadClassification === 'uniform_failure_provider_side_candidate',
    tokenLaneClassification === 'uniform_failure_provider_side_candidate',
    minimalDeltaConclusion === 'no_controlled_case_success'
  ].filter(Boolean).length;

  const conflictingSignals = [
    exactCaseClassification,
    payloadClassification,
    tokenLaneClassification,
    minimalDeltaConclusion
  ].filter((value) => value && ![
    'uniform_failure_provider_side_candidate',
    'no_controlled_case_success',
    'single_payload_only',
    'single_lane_only',
    'all_success'
  ].includes(value));

  if (providerSideSignals > 0 && conflictingSignals.length === 0) {
    overallClassification = 'provider_side_candidate';
    nextHypothesis = 'provider_side_candidate';
  }
}

const providerSideCandidate = overallClassification === 'provider_side_candidate';

const output = {
  mode: 'issue80_evidence_report',
  evidenceAxes: presentAxes,
  overallClassification,
  nextHypothesis,
  providerSideCandidate,
  bodySha256: bodySha256 || null,
  axes: {
    exactCase: exactCase ? {
      summaryPath: exactCase.summaryPath,
      classification: exactCaseClassification || null,
      headerSensitive: exactCase.data.header_sensitive ?? null,
      tokenLaneSensitive: exactCase.data.token_lane_sensitive ?? null,
      successfulCases: exactCase.data.successful_cases ?? null,
      failingCases: exactCase.data.failing_cases ?? null
    } : null,
    minimalDelta: minimalDelta ? {
      summaryPath: minimalDelta.summaryPath,
      conclusion: minimalDeltaConclusion || null,
      baselineCase: minimalDelta.data.baseline_case ?? null,
      minimalSuccessCase: minimalSuccessCase || null,
      minimalSuccessDelta: minimalSuccessDelta || null,
      blockedLanes: minimalDelta.data.blocked_lanes ?? null
    } : null,
    payload: payload ? {
      summaryPath: payload.summaryPath,
      classification: payloadClassification || null,
      payloadSensitive: payload.data.payload_sensitive ?? null,
      uniformFailure: payload.data.uniform_failure ?? null
    } : null,
    tokenLane: tokenLane ? {
      summaryPath: tokenLane.summaryPath,
      classification: tokenLaneClassification || null,
      tokenLaneSensitive: tokenLane.data.token_lane_sensitive ?? null,
      uniformFailure: tokenLane.data.uniform_failure ?? null
    } : null
  }
};

const summaryLines = [
  'mode=issue80_evidence_report',
  `evidence_axes=${joinNames(presentAxes)}`,
  `overall_classification=${overallClassification}`,
  `next_hypothesis=${nextHypothesis}`,
  `provider_side_candidate=${String(providerSideCandidate)}`
];

if (bodySha256) {
  summaryLines.push(`body_sha256=${bodySha256}`);
}
if (exactCaseClassification) {
  summaryLines.push(`exact_case_classification=${exactCaseClassification}`);
}
if (minimalDeltaConclusion) {
  summaryLines.push(`minimal_delta_conclusion=${minimalDeltaConclusion}`);
}
if (minimalSuccessCase) {
  summaryLines.push(`minimal_success_case=${minimalSuccessCase}`);
}
if (minimalSuccessDelta) {
  summaryLines.push(`minimal_success_delta=${minimalSuccessDelta}`);
}
if (payloadClassification) {
  summaryLines.push(`payload_classification=${payloadClassification}`);
}
if (tokenLaneClassification) {
  summaryLines.push(`token_lane_classification=${tokenLaneClassification}`);
}
if (exactCase?.summaryPath) {
  summaryLines.push(`exact_case_summary=${exactCase.summaryPath}`);
}
if (minimalDelta?.summaryPath) {
  summaryLines.push(`minimal_delta_summary=${minimalDelta.summaryPath}`);
}
if (payload?.summaryPath) {
  summaryLines.push(`payload_summary=${payload.summaryPath}`);
}
if (tokenLane?.summaryPath) {
  summaryLines.push(`token_lane_summary=${tokenLane.summaryPath}`);
}

const issueCommentLines = [
  '# Issue 80 Evidence Report',
  '',
  `- Overall classification: \`${overallClassification}\``,
  `- Recommended next hypothesis: \`${nextHypothesis}\``,
  `- Evidence axes included: \`${joinNames(presentAxes)}\``
];

if (bodySha256) {
  issueCommentLines.push(`- Body sha256: \`${bodySha256}\``);
}

issueCommentLines.push('', '## Findings', '');

if (overallClassification === 'header_delta_specific') {
  issueCommentLines.push('- Exact-case evidence points at a remaining header delta.');
  if (minimalSuccessCase) {
    issueCommentLines.push(`- Smallest successful controlled case: \`${minimalSuccessCase}\` (\`${minimalSuccessDelta || 'unknown_delta'}\`).`);
  }
} else if (overallClassification === 'provider_side_candidate') {
  issueCommentLines.push('- All available controlled axes stayed uniform, so the remaining candidate is provider-side behavior or an unmodeled delta.');
} else if (overallClassification === 'credential_lane_specific') {
  issueCommentLines.push('- Credential-lane evidence still flips outcome while the held-constant body/header lane stays fixed.');
} else if (overallClassification === 'transcript_shape_specific') {
  issueCommentLines.push('- Payload-shape evidence still flips outcome while the direct header/token lane stays fixed.');
} else if (overallClassification === 'mixed_header_and_lane_specific') {
  issueCommentLines.push('- Current evidence mixes header-case and credential-lane sensitivity, so the next follow-up should isolate lane-specific header deltas.');
} else {
  issueCommentLines.push('- Current artifact set does not yet isolate one dominant explanation.');
}

if (exactCaseClassification) {
  issueCommentLines.push(`- Exact-case summary: \`${exactCaseClassification}\`.`);
}
if (minimalDeltaConclusion) {
  issueCommentLines.push(`- Minimal-delta conclusion: \`${minimalDeltaConclusion}\`.`);
}
if (payloadClassification) {
  issueCommentLines.push(`- Direct payload summary: \`${payloadClassification}\`.`);
}
if (tokenLaneClassification) {
  issueCommentLines.push(`- Direct token-lane summary: \`${tokenLaneClassification}\`.`);
}

issueCommentLines.push('', '## Next Step', '');
issueCommentLines.push(`Recommended next hypothesis: \`${nextHypothesis}\``);

const summaryPath = path.join(outDir, 'summary.txt');
const jsonPath = path.join(outDir, 'summary.json');
const commentPath = path.join(outDir, 'issue-comment.md');

fs.writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`);
fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(commentPath, `${issueCommentLines.join('\n')}\n`);
