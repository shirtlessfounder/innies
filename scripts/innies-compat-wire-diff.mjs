#!/usr/bin/env node

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function resolveBundlePath(inputPath) {
  const resolvedPath = resolve(inputPath);

  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch {
    fail(`request bundle not found: ${resolvedPath}`);
  }

  if (stats.isFile()) {
    return resolvedPath;
  }

  if (!stats.isDirectory()) {
    fail(`request bundle path is neither a file nor directory: ${resolvedPath}`);
  }

  for (const candidateName of ['upstream-request.json', 'request.json', 'direct-request.json']) {
    const candidatePath = join(resolvedPath, candidateName);
    try {
      if (statSync(candidatePath).isFile()) {
        return candidatePath;
      }
    } catch {
      // keep searching
    }
  }

  fail(`no request bundle json found in directory: ${resolvedPath}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`failed to read json from ${filePath}: ${error.message}`);
  }
}

function toStringValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const coerced = Number(value);
  return Number.isFinite(coerced) ? coerced : null;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [String(name).toLowerCase(), toStringValue(value)])
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
  );
}

function readBundle(inputPath) {
  const bundlePath = resolveBundlePath(inputPath);
  const raw = readJson(bundlePath);

  return {
    source_path: bundlePath,
    source_name: basename(bundlePath),
    method: raw.method ? toStringValue(raw.method) : null,
    target_url: raw.target_url ? toStringValue(raw.target_url) : raw.targetUrl ? toStringValue(raw.targetUrl) : null,
    request_id: raw.request_id ? toStringValue(raw.request_id) : raw.requestId ? toStringValue(raw.requestId) : null,
    body_sha256: raw.body_sha256 ? toStringValue(raw.body_sha256) : raw.bodySha256 ? toStringValue(raw.bodySha256) : null,
    body_bytes: raw.body_bytes !== undefined ? toNullableNumber(raw.body_bytes) : toNullableNumber(raw.bodyBytes),
    headers: normalizeHeaders(raw.headers)
  };
}

function compareScalar(leftValue, rightValue) {
  return {
    left: leftValue,
    right: rightValue,
    match: leftValue === rightValue
  };
}

function compareHeaders(leftHeaders, rightHeaders) {
  const changed = [];
  const leftOnly = [];
  const rightOnly = [];

  const allHeaderNames = Array.from(
    new Set([...Object.keys(leftHeaders), ...Object.keys(rightHeaders)])
  ).sort((leftName, rightName) => leftName.localeCompare(rightName));

  for (const headerName of allHeaderNames) {
    const leftHas = Object.prototype.hasOwnProperty.call(leftHeaders, headerName);
    const rightHas = Object.prototype.hasOwnProperty.call(rightHeaders, headerName);

    if (leftHas && rightHas) {
      if (leftHeaders[headerName] !== rightHeaders[headerName]) {
        changed.push({
          name: headerName,
          left: leftHeaders[headerName],
          right: rightHeaders[headerName]
        });
      }
      continue;
    }

    if (leftHas) {
      leftOnly.push({
        name: headerName,
        value: leftHeaders[headerName]
      });
      continue;
    }

    rightOnly.push({
      name: headerName,
      value: rightHeaders[headerName]
    });
  }

  return { changed, leftOnly, rightOnly };
}

function maybeSummaryLine(key, values) {
  if (values.length === 0) {
    return null;
  }

  return `${key}=${values.join(',')}`;
}

const [, , leftInput, rightInput, outDirInput] = process.argv;

if (!leftInput || !rightInput || !outDirInput) {
  fail('expected left input, right input, and output directory arguments');
}

const outDir = resolve(outDirInput);
mkdirSync(outDir, { recursive: true });

const leftBundle = readBundle(leftInput);
const rightBundle = readBundle(rightInput);
const headerComparison = compareHeaders(leftBundle.headers, rightBundle.headers);

const comparison = {
  method: compareScalar(leftBundle.method, rightBundle.method),
  target_url: compareScalar(leftBundle.target_url, rightBundle.target_url),
  request_id: compareScalar(leftBundle.request_id, rightBundle.request_id),
  body_sha256: compareScalar(leftBundle.body_sha256, rightBundle.body_sha256),
  body_bytes: compareScalar(leftBundle.body_bytes, rightBundle.body_bytes),
  headers: headerComparison
};

const bodyMatch = comparison.body_sha256.match && comparison.body_bytes.match;

const summaryLines = [
  `left_bundle=${leftBundle.source_path}`,
  `right_bundle=${rightBundle.source_path}`,
  `left_request_id=${leftBundle.request_id ?? ''}`,
  `right_request_id=${rightBundle.request_id ?? ''}`,
  `body_match=${bodyMatch}`,
  `body_sha256_match=${comparison.body_sha256.match}`,
  `body_bytes_match=${comparison.body_bytes.match}`,
  `method_match=${comparison.method.match}`,
  `target_url_match=${comparison.target_url.match}`,
  `changed_header_count=${headerComparison.changed.length}`,
  `left_only_header_count=${headerComparison.leftOnly.length}`,
  `right_only_header_count=${headerComparison.rightOnly.length}`,
  maybeSummaryLine('changed_headers', headerComparison.changed.map(({ name }) => name)),
  maybeSummaryLine('left_only_headers', headerComparison.leftOnly.map(({ name }) => name)),
  maybeSummaryLine('right_only_headers', headerComparison.rightOnly.map(({ name }) => name))
].filter(Boolean);

const diff = {
  left: leftBundle,
  right: rightBundle,
  comparisons: comparison
};

writeFileSync(join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
writeFileSync(join(outDir, 'diff.json'), `${JSON.stringify(diff, null, 2)}\n`);
writeFileSync(join(outDir, 'left.normalized.json'), `${JSON.stringify(leftBundle, null, 2)}\n`);
writeFileSync(join(outDir, 'right.normalized.json'), `${JSON.stringify(rightBundle, null, 2)}\n`);

console.log(`wrote ${join(outDir, 'summary.txt')}`);
