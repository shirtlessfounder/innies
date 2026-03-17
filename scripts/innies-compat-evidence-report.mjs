#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('error: usage: innies-compat-evidence-report.mjs <out-dir> <input-path> [<input-path> ...]');
  process.exit(1);
}

const [outDirArg, ...inputPathArgs] = args;
const outDir = path.resolve(outDirArg);
const inputPaths = inputPathArgs.map((value) => path.resolve(value));

const ARTIFACT_TYPES = [
  'direct_payload_summary',
  'direct_token_lane_summary',
  'exact_case_summary',
  'first_pass_bundle_diff'
];

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

function parseBoolean(value) {
  return value === 'true';
}

function normalizeList(value) {
  if (!value || value === '-') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function joinList(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function walkSummaryFiles(rootPath) {
  const pending = [rootPath];
  const files = [];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    const stat = fs.statSync(currentPath);

    if (stat.isFile()) {
      files.push(currentPath);
      continue;
    }

    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(childPath);
      } else if (entry.isFile() && entry.name === 'summary.txt') {
        files.push(childPath);
      }
    }
  }

  return files.sort();
}

function inferArtifactType(summary) {
  if (summary.left_label && summary.right_label) {
    return 'first_pass_bundle_diff';
  }

  switch (summary.mode) {
    case 'case_matrix':
    case 'case_lane_matrix':
      return 'exact_case_summary';
    case 'payload_matrix':
      return 'direct_payload_summary';
    case 'direct_token_lane_matrix':
      return 'direct_token_lane_summary';
    default:
      return null;
  }
}

function ensureSingleArtifact(artifacts, type, filePath, summary) {
  if (artifacts[type]) {
    console.error(`error: multiple ${type} artifacts found: ${artifacts[type].path} and ${filePath}`);
    process.exit(1);
  }

  artifacts[type] = { type, path: filePath, summary };
}

function buildArtifactIndex(paths) {
  const candidateFiles = [];

  for (const inputPath of paths) {
    if (!fs.existsSync(inputPath)) {
      console.error(`error: evidence report input path not found: ${inputPath}`);
      process.exit(1);
    }

    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      candidateFiles.push(...walkSummaryFiles(inputPath));
    } else {
      candidateFiles.push(inputPath);
    }
  }

  const uniqueCandidates = [...new Set(candidateFiles)];
  const artifacts = {};

  for (const filePath of uniqueCandidates) {
    const summary = readKeyValueFile(filePath);
    const type = inferArtifactType(summary);
    if (!type) continue;
    ensureSingleArtifact(artifacts, type, filePath, summary);
  }

  return artifacts;
}

function buildBundleDiffArtifact(artifact) {
  if (!artifact) return null;
  return {
    ...artifact,
    payloadCanonicalEqual: parseBoolean(artifact.summary.payload_canonical_equal),
    headerValueMismatches: normalizeList(artifact.summary.header_value_mismatches),
    headerOnlyInLeft: normalizeList(artifact.summary.header_only_in_left),
    headerOnlyInRight: normalizeList(artifact.summary.header_only_in_right),
    leftLabel: artifact.summary.left_label || '',
    rightLabel: artifact.summary.right_label || '',
    bodySha256Left: artifact.summary.body_sha256_left || '',
    bodySha256Right: artifact.summary.body_sha256_right || ''
  };
}

function buildExactCaseArtifact(artifact) {
  if (!artifact) return null;
  return {
    ...artifact,
    mode: artifact.summary.mode || '',
    classification: artifact.summary.classification || 'unknown',
    headerSensitive: parseBoolean(artifact.summary.header_sensitive),
    tokenLaneSensitive: parseBoolean(artifact.summary.token_lane_sensitive),
    uniformFailure: parseBoolean(artifact.summary.uniform_failure),
    allInvalidRequest: parseBoolean(artifact.summary.all_invalid_request),
    successfulCases: normalizeList(artifact.summary.successful_cases),
    failingCases: normalizeList(artifact.summary.failing_cases),
    successfulLanes: normalizeList(artifact.summary.successful_lanes),
    failingLanes: normalizeList(artifact.summary.failing_lanes),
    allSuccess: parseBoolean(artifact.summary.all_success)
  };
}

function buildPayloadArtifact(artifact) {
  if (!artifact) return null;
  return {
    ...artifact,
    mode: artifact.summary.mode || '',
    classification: artifact.summary.classification || 'unknown',
    payloadSensitive: parseBoolean(artifact.summary.payload_sensitive),
    uniformFailure: parseBoolean(artifact.summary.uniform_failure),
    allInvalidRequest: parseBoolean(artifact.summary.all_invalid_request),
    allSuccess: parseBoolean(artifact.summary.all_success),
    successfulPayloads: normalizeList(artifact.summary.successful_payloads),
    failingPayloads: normalizeList(artifact.summary.failing_payloads)
  };
}

function buildTokenLaneArtifact(artifact) {
  if (!artifact) return null;
  return {
    ...artifact,
    mode: artifact.summary.mode || '',
    classification: artifact.summary.classification || 'unknown',
    tokenLaneSensitive: parseBoolean(artifact.summary.token_lane_sensitive),
    uniformFailure: parseBoolean(artifact.summary.uniform_failure),
    allInvalidRequest: parseBoolean(artifact.summary.all_invalid_request),
    allSuccess: parseBoolean(artifact.summary.all_success),
    successfulLanes: normalizeList(artifact.summary.successful_lanes),
    failingLanes: normalizeList(artifact.summary.failing_lanes)
  };
}

function buildSummaryLine(artifact) {
  switch (artifact.type) {
    case 'first_pass_bundle_diff':
      return `artifact=${artifact.type} path=${artifact.path} payload_canonical_equal=${String(artifact.payloadCanonicalEqual)} header_value_mismatches=${joinList(artifact.headerValueMismatches)} header_only_in_right=${joinList(artifact.headerOnlyInRight)}`;
    case 'exact_case_summary':
      return `artifact=${artifact.type} path=${artifact.path} classification=${artifact.classification} header_sensitive=${String(artifact.headerSensitive)} token_lane_sensitive=${String(artifact.tokenLaneSensitive)} uniform_failure=${String(artifact.uniformFailure)}`;
    case 'direct_payload_summary':
      return `artifact=${artifact.type} path=${artifact.path} classification=${artifact.classification} payload_sensitive=${String(artifact.payloadSensitive)} uniform_failure=${String(artifact.uniformFailure)} successful_payloads=${joinList(artifact.successfulPayloads)} failing_payloads=${joinList(artifact.failingPayloads)}`;
    case 'direct_token_lane_summary':
      return `artifact=${artifact.type} path=${artifact.path} classification=${artifact.classification} token_lane_sensitive=${String(artifact.tokenLaneSensitive)} uniform_failure=${String(artifact.uniformFailure)} successful_lanes=${joinList(artifact.successfulLanes)} failing_lanes=${joinList(artifact.failingLanes)}`;
    default:
      return `artifact=${artifact.type} path=${artifact.path}`;
  }
}

const discoveredArtifacts = buildArtifactIndex(inputPaths);

if (Object.keys(discoveredArtifacts).length === 0) {
  console.error('error: no recognized issue-80 summary artifacts found');
  process.exit(1);
}

const bundleDiff = buildBundleDiffArtifact(discoveredArtifacts.first_pass_bundle_diff);
const exactCase = buildExactCaseArtifact(discoveredArtifacts.exact_case_summary);
const payloadSummary = buildPayloadArtifact(discoveredArtifacts.direct_payload_summary);
const tokenLaneSummary = buildTokenLaneArtifact(discoveredArtifacts.direct_token_lane_summary);

const availableArtifactTypes = ARTIFACT_TYPES.filter((type) => discoveredArtifacts[type]);
const missingArtifactTypes = ARTIFACT_TYPES.filter((type) => !discoveredArtifacts[type]);
const incompleteEvidence = missingArtifactTypes.length > 0;

const headerSensitive = exactCase?.headerSensitive === true;
const payloadSensitive = payloadSummary?.payloadSensitive === true;
const credentialLaneSensitive = (tokenLaneSummary?.tokenLaneSensitive === true) || (exactCase?.tokenLaneSensitive === true);
const specificSignalCount = [headerSensitive, payloadSensitive, credentialLaneSensitive].filter(Boolean).length;
const uniformInputs = [exactCase, payloadSummary, tokenLaneSummary].filter(Boolean);
const allUniformFailure = uniformInputs.length === 3 && uniformInputs.every((artifact) => artifact.uniformFailure === true);
const allSuccess = uniformInputs.length > 0 && uniformInputs.every((artifact) => artifact.allSuccess === true);
const bundleSupportsProviderSide = !bundleDiff || bundleDiff.payloadCanonicalEqual === true;

let overallClassification = 'inconclusive_partial_evidence';
let recommendedNextStep = 'fill_missing_axes';

if (headerSensitive && credentialLaneSensitive && !payloadSensitive) {
  overallClassification = 'mixed_header_and_lane_specific';
  recommendedNextStep = 'split_header_vs_lane_minimal_delta';
} else if (specificSignalCount >= 2) {
  overallClassification = 'mixed_axis_specific';
  recommendedNextStep = 'split_axes_before_runtime_change';
} else if (headerSensitive) {
  overallClassification = 'header_case_specific';
  recommendedNextStep = 'focus_on_header_case_delta';
} else if (payloadSensitive) {
  overallClassification = 'transcript_shape_specific';
  recommendedNextStep = 'focus_on_payload_shape_delta';
} else if (credentialLaneSensitive) {
  overallClassification = 'credential_lane_specific';
  recommendedNextStep = 'focus_on_credential_lane_delta';
} else if (allUniformFailure && bundleSupportsProviderSide) {
  overallClassification = 'uniform_failure_provider_side_candidate';
  recommendedNextStep = 'prepare_provider_escalation_bundle';
} else if (allSuccess) {
  overallClassification = 'all_success';
  recommendedNextStep = 'capture_fresh_failing_bundle_before_comparing';
}

const providerSideCandidate = overallClassification === 'uniform_failure_provider_side_candidate';

const output = {
  inputPaths,
  outputDir: outDir,
  overallClassification,
  recommendedNextStep,
  providerSideCandidate,
  incompleteEvidence,
  availableArtifactTypes,
  missingArtifactTypes,
  flags: {
    headerSensitive,
    payloadSensitive,
    credentialLaneSensitive
  },
  artifacts: {
    firstPassBundleDiff: bundleDiff,
    exactCaseSummary: exactCase,
    directPayloadSummary: payloadSummary,
    directTokenLaneSummary: tokenLaneSummary
  }
};

fs.mkdirSync(outDir, { recursive: true });

const summaryLines = [];
summaryLines.push(`overall_classification=${overallClassification}`);
summaryLines.push(`recommended_next_step=${recommendedNextStep}`);
summaryLines.push(`provider_side_candidate=${String(providerSideCandidate)}`);
summaryLines.push(`incomplete_evidence=${String(incompleteEvidence)}`);
summaryLines.push(`available_artifact_types=${joinList(availableArtifactTypes)}`);
summaryLines.push(`missing_artifact_types=${joinList(missingArtifactTypes)}`);
summaryLines.push(`header_sensitive=${String(headerSensitive)}`);
summaryLines.push(`payload_sensitive=${String(payloadSensitive)}`);
summaryLines.push(`credential_lane_sensitive=${String(credentialLaneSensitive)}`);

if (bundleDiff) {
  summaryLines.push(`bundle_diff_payload_canonical_equal=${String(bundleDiff.payloadCanonicalEqual)}`);
  summaryLines.push(`bundle_diff_header_value_mismatches=${joinList(bundleDiff.headerValueMismatches)}`);
  summaryLines.push(`bundle_diff_header_only_in_left=${joinList(bundleDiff.headerOnlyInLeft)}`);
  summaryLines.push(`bundle_diff_header_only_in_right=${joinList(bundleDiff.headerOnlyInRight)}`);
}

for (const type of ARTIFACT_TYPES) {
  if (!discoveredArtifacts[type]) continue;
  const artifact =
    type === 'first_pass_bundle_diff' ? bundleDiff
      : type === 'exact_case_summary' ? exactCase
        : type === 'direct_payload_summary' ? payloadSummary
          : tokenLaneSummary;
  summaryLines.push(buildSummaryLine(artifact));
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
