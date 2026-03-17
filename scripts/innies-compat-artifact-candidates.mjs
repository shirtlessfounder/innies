#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function toNullableString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : null;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toNullableBoolean(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return null;
}

function get(raw, ...keys) {
  for (const key of keys) {
    if (raw[key] !== undefined) {
      return raw[key];
    }
  }
  return undefined;
}

function normalizeEntry(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`failed to parse JSON from ${filePath}: ${error.message}`);
  }

  const requestShape = parsed.request_shape ?? parsed.requestShape ?? {};
  const requestId = toNullableString(get(parsed, 'request_id', 'requestId'));
  const providerRequestId = toNullableString(get(parsed, 'provider_request_id', 'providerRequestId'));
  const upstreamStatus = toNullableNumber(get(parsed, 'upstream_status', 'upstreamStatus', 'status'));
  const bodySha256 = toNullableString(get(parsed, 'body_sha256', 'bodySha256'));
  const bodyBytes = toNullableNumber(get(parsed, 'body_bytes', 'bodyBytes'));
  const provider = toNullableString(get(parsed, 'provider', 'original_provider', 'originalProvider'));
  const model = toNullableString(get(parsed, 'model', 'original_model', 'originalModel'));
  const classification = toNullableString(get(parsed, 'classification', 'candidate_classification', 'candidateClassification'));
  const stream =
    toNullableBoolean(get(parsed, 'stream', 'is_streaming', 'isStreaming', 'streaming', 'request_stream', 'requestStream')) ??
    toNullableBoolean(requestShape.stream);
  const messageCount = toNullableNumber(get(parsed, 'message_count', 'messageCount'));
  const toolCount = toNullableNumber(get(parsed, 'tool_count', 'toolCount'));
  const toolResultBlockCount = toNullableNumber(get(parsed, 'tool_result_block_count', 'toolResultBlockCount'));
  const thinkingPresent = toNullableBoolean(get(parsed, 'thinking_present', 'thinkingPresent'));
  const artifactPath = toNullableString(get(parsed, 'artifact_path', 'artifactPath'));

  return {
    artifactPath,
    bodyBytes: bodyBytes ?? toNullableNumber(requestShape.body_bytes ?? requestShape.bodyBytes),
    bodySha256,
    classification,
    filePath: path.resolve(filePath),
    messageCount: messageCount ?? toNullableNumber(requestShape.message_count ?? requestShape.messageCount),
    model,
    provider,
    providerRequestId,
    requestId: requestId ?? path.basename(path.dirname(filePath)),
    stream: stream ?? toNullableBoolean(requestShape.stream),
    thinkingPresent: thinkingPresent ?? toNullableBoolean(requestShape.thinking_present ?? requestShape.thinkingPresent),
    toolCount: toolCount ?? toNullableNumber(requestShape.tool_count ?? requestShape.toolCount),
    toolResultBlockCount:
      toolResultBlockCount ?? toNullableNumber(requestShape.tool_result_block_count ?? requestShape.toolResultBlockCount),
    upstreamStatus
  };
}

function isSuccess(entry) {
  if (entry.upstreamStatus !== null && entry.upstreamStatus >= 200 && entry.upstreamStatus < 300) {
    return true;
  }
  return entry.classification === 'known_good_candidate';
}

function isFailure(entry) {
  if (entry.upstreamStatus !== null && entry.upstreamStatus >= 400) {
    return true;
  }
  return entry.classification === 'invalid_request_candidate';
}

function entryScore(entry, desiredKind) {
  let score = 0;
  if (desiredKind === 'success') {
    if (entry.upstreamStatus === 200) {
      score += 10;
    } else if (entry.upstreamStatus !== null && entry.upstreamStatus >= 200 && entry.upstreamStatus < 300) {
      score += 5;
    }
    if (entry.classification === 'known_good_candidate') {
      score += 6;
    }
  } else {
    if (entry.upstreamStatus === 400) {
      score += 10;
    } else if (entry.upstreamStatus !== null && entry.upstreamStatus >= 400) {
      score += 5;
    }
    if (entry.classification === 'invalid_request_candidate') {
      score += 6;
    }
  }
  if (entry.provider === 'anthropic') {
    score += 2;
  }
  if (entry.bodySha256) {
    score += 1;
  }
  return score;
}

function sortEntries(entries, desiredKind) {
  return [...entries].sort((left, right) => {
    const scoreDiff = entryScore(right, desiredKind) - entryScore(left, desiredKind);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.requestId.localeCompare(right.requestId);
  });
}

function serializeEntry(entry) {
  return {
    artifactPath: entry.artifactPath,
    bodyBytes: entry.bodyBytes,
    bodySha256: entry.bodySha256,
    classification: entry.classification,
    filePath: entry.filePath,
    model: entry.model,
    provider: entry.provider,
    providerRequestId: entry.providerRequestId,
    requestId: entry.requestId,
    stream: entry.stream,
    thinkingPresent: entry.thinkingPresent,
    toolCount: entry.toolCount,
    toolResultBlockCount: entry.toolResultBlockCount,
    upstreamStatus: entry.upstreamStatus
  };
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) {
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
      continue;
    }
    groups.set(key, [item]);
  }
  return groups;
}

function buildExactBodyCandidates(entries) {
  const exactGroups = groupBy(entries.filter((entry) => entry.bodySha256), (entry) => entry.bodySha256);
  const usedIds = new Set();
  const candidates = [];

  for (const [bodySha256, groupEntries] of exactGroups.entries()) {
    const failures = sortEntries(groupEntries.filter(isFailure), 'failure');
    const successes = sortEntries(groupEntries.filter(isSuccess), 'success');
    if (failures.length === 0 || successes.length === 0) {
      continue;
    }

    for (const entry of groupEntries) {
      usedIds.add(entry.filePath);
    }

    candidates.push({
      bodyBytes: failures[0]?.bodyBytes ?? successes[0]?.bodyBytes ?? null,
      bodySha256,
      failureCount: failures.length,
      failures: failures.map(serializeEntry),
      recommendedPair: {
        failure: serializeEntry(failures[0]),
        success: serializeEntry(successes[0])
      },
      successCount: successes.length,
      successes: successes.map(serializeEntry)
    });
  }

  candidates.sort((left, right) => {
    const pairCountDiff = right.failureCount + right.successCount - (left.failureCount + left.successCount);
    if (pairCountDiff !== 0) {
      return pairCountDiff;
    }
    return String(right.bodyBytes ?? 0).localeCompare(String(left.bodyBytes ?? 0), undefined, { numeric: true });
  });

  return { candidates, usedIds };
}

function shapeKey(entry) {
  if (
    !entry.model ||
    entry.stream === null ||
    entry.messageCount === null ||
    entry.toolCount === null ||
    entry.toolResultBlockCount === null ||
    entry.thinkingPresent === null
  ) {
    return null;
  }

  return [
    `model=${entry.model}`,
    `stream=${entry.stream}`,
    `message_count=${entry.messageCount}`,
    `tool_count=${entry.toolCount}`,
    `tool_result_block_count=${entry.toolResultBlockCount}`,
    `thinking_present=${entry.thinkingPresent}`
  ].join('|');
}

function buildShapeCandidates(entries, excludedIds) {
  const eligibleEntries = entries.filter((entry) => !excludedIds.has(entry.filePath));
  const shapeGroups = groupBy(eligibleEntries, shapeKey);
  const candidates = [];

  for (const [key, groupEntries] of shapeGroups.entries()) {
    const failures = sortEntries(groupEntries.filter(isFailure), 'failure');
    const successes = sortEntries(groupEntries.filter(isSuccess), 'success');
    if (failures.length === 0 || successes.length === 0) {
      continue;
    }

    candidates.push({
      failureCount: failures.length,
      failures: failures.map(serializeEntry),
      recommendedPair: {
        failure: serializeEntry(failures[0]),
        success: serializeEntry(successes[0])
      },
      shapeKey: key,
      successCount: successes.length,
      successes: successes.map(serializeEntry)
    });
  }

  candidates.sort((left, right) => {
    const pairCountDiff = right.failureCount + right.successCount - (left.failureCount + left.successCount);
    if (pairCountDiff !== 0) {
      return pairCountDiff;
    }
    return left.shapeKey.localeCompare(right.shapeKey);
  });

  return candidates;
}

function buildSummaryText(summary) {
  const lines = [
    `artifact_count=${summary.artifactCount}`,
    `source_files=${summary.sourceFiles.length}`,
    `exact_body_match_candidates=${summary.exactBodyCandidates.length}`,
    `shape_match_candidates=${summary.shapeCandidates.length}`,
    `recommended_exact_pair=${
      summary.exactBodyCandidates[0]
        ? `${summary.exactBodyCandidates[0].recommendedPair.failure.requestId} -> ${summary.exactBodyCandidates[0].recommendedPair.success.requestId}`
        : 'none'
    }`,
    `recommended_shape_pair=${
      summary.shapeCandidates[0]
        ? `${summary.shapeCandidates[0].recommendedPair.failure.requestId} -> ${summary.shapeCandidates[0].recommendedPair.success.requestId}`
        : 'none'
    }`,
    `recommended_next_action=${summary.recommendedNextAction}`
  ];

  for (const [index, candidate] of summary.exactBodyCandidates.entries()) {
    lines.push(
      `exact_body_candidate_${index + 1}=body_sha256:${candidate.bodySha256} failure:${candidate.recommendedPair.failure.requestId} success:${candidate.recommendedPair.success.requestId}`
    );
  }

  for (const [index, candidate] of summary.shapeCandidates.entries()) {
    lines.push(
      `shape_candidate_${index + 1}=shape_key:${candidate.shapeKey} failure:${candidate.recommendedPair.failure.requestId} success:${candidate.recommendedPair.success.requestId}`
    );
  }

  return `${lines.join('\n')}\n`;
}

const [, , outDirArg, ...summaryPaths] = process.argv;
if (!outDirArg || summaryPaths.length === 0) {
  fail('usage: innies-compat-artifact-candidates.mjs <out-dir> <summary.json> [more summary.json files...]');
}

const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const resolvedPaths = [...new Set(summaryPaths.map((inputPath) => path.resolve(inputPath)))];
const entries = resolvedPaths.map(normalizeEntry);
if (entries.length === 0) {
  fail('no summary entries were loaded');
}

const { candidates: exactBodyCandidates, usedIds } = buildExactBodyCandidates(entries);
const shapeCandidates = buildShapeCandidates(entries, usedIds);

let recommendedNextAction = 'collect additional saved artifacts or direct captures before diffing';
if (exactBodyCandidates.length > 0) {
  recommendedNextAction = 'run exact bundle diff on the recommended exact-body pair first';
} else if (shapeCandidates.length > 0) {
  recommendedNextAction = 'use the recommended shape pair to choose the next direct replay or capture target';
}

const summary = {
  artifactCount: entries.length,
  exactBodyCandidateCount: exactBodyCandidates.length,
  exactBodyCandidates,
  recommendedNextAction,
  shapeCandidateCount: shapeCandidates.length,
  shapeCandidates,
  sourceFiles: resolvedPaths
};

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), buildSummaryText(summary));
