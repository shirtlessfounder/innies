#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [compatFile, directFile, outDir] = process.argv.slice(2);

const IGNORED_HEADERS = new Set(['authorization', 'content-length', 'host']);
const REQUEST_SCOPED_HEADERS = new Set(['x-request-id']);
const IDENTITY_HEADERS = new Set([
  'anthropic-dangerous-direct-browser-access',
  'user-agent',
  'x-app'
]);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readRecord(filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`could not parse JSON file ${filePath}: ${error.message}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`expected request JSON object in ${filePath}`);
  }

  const headers = value.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    fail(`missing headers object in ${filePath}`);
  }

  return value;
}

function normalizeHeaders(headers) {
  const normalized = new Map();

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName ?? '').trim().toLowerCase();
    if (!name || IGNORED_HEADERS.has(name)) continue;

    let value = rawValue;
    if (value === null || value === undefined) {
      value = '';
    } else if (typeof value !== 'string') {
      value = String(value);
    }

    normalized.set(name, value);
  }

  return normalized;
}

function writeTsv(filePath, headersMap) {
  const lines = Array.from(headersMap.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\t${value}`);

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function csv(values) {
  return values.length === 0 ? '' : values.slice().sort().join(',');
}

function matchFlag(left, right) {
  if (left === undefined || left === null || left === '' || right === undefined || right === null || right === '') {
    return 'unknown';
  }

  return String(left) === String(right) ? 'true' : 'false';
}

function addHeaders(baseMap, sourceMap, headerNames) {
  const merged = new Map(baseMap);
  for (const name of headerNames) {
    if (sourceMap.has(name)) {
      merged.set(name, sourceMap.get(name));
    }
  }
  return merged;
}

function uniq(values) {
  return Array.from(new Set(values));
}

const compatRecord = readRecord(compatFile);
const directRecord = readRecord(directFile);

const compatHeaders = normalizeHeaders(compatRecord.headers);
const directHeaders = normalizeHeaders(directRecord.headers);

const bodyShaMatch = matchFlag(compatRecord.body_sha256, directRecord.body_sha256);
const bodyBytesMatch = matchFlag(compatRecord.body_bytes, directRecord.body_bytes);

if (
  process.env.INNIES_ALLOW_BODY_MISMATCH !== 'true' &&
  (bodyShaMatch === 'false' || bodyBytesMatch === 'false')
) {
  fail(
    [
      'body-held-constant mismatch',
      `compat_body_sha256=${compatRecord.body_sha256 ?? ''}`,
      `direct_body_sha256=${directRecord.body_sha256 ?? ''}`,
      `compat_body_bytes=${compatRecord.body_bytes ?? ''}`,
      `direct_body_bytes=${directRecord.body_bytes ?? ''}`
    ].join(' ')
  );
}

const sharedHeaders = new Map();
const functionalValueMismatches = [];
const compatOnlyHeaders = [];
const directOnlyHeaders = [];
const identityDirectOnlyHeaders = [];
const requestScopedValueMismatches = [];
const requestScopedCompatOnlyHeaders = [];
const requestScopedDirectOnlyHeaders = [];

const allHeaderNames = uniq([
  ...compatHeaders.keys(),
  ...directHeaders.keys()
]).sort();

for (const name of allHeaderNames) {
  const compatValue = compatHeaders.get(name);
  const directValue = directHeaders.get(name);
  const hasCompat = compatHeaders.has(name);
  const hasDirect = directHeaders.has(name);
  const isRequestScoped = REQUEST_SCOPED_HEADERS.has(name);

  if (hasCompat && hasDirect) {
    if (compatValue === directValue) {
      sharedHeaders.set(name, compatValue);
      continue;
    }

    if (isRequestScoped) {
      requestScopedValueMismatches.push(name);
    } else {
      functionalValueMismatches.push(name);
    }
    continue;
  }

  if (hasCompat) {
    if (isRequestScoped) {
      requestScopedCompatOnlyHeaders.push(name);
    } else {
      compatOnlyHeaders.push(name);
    }
    continue;
  }

  if (isRequestScoped) {
    requestScopedDirectOnlyHeaders.push(name);
  } else if (IDENTITY_HEADERS.has(name)) {
    identityDirectOnlyHeaders.push(name);
  } else {
    directOnlyHeaders.push(name);
  }
}

const betaHeaders = [];
if (
  directHeaders.has('anthropic-beta') &&
  compatHeaders.get('anthropic-beta') !== directHeaders.get('anthropic-beta')
) {
  betaHeaders.push('anthropic-beta');
}

const identityDeltaHeaders = uniq(
  Array.from(IDENTITY_HEADERS).filter(
    (name) => directHeaders.has(name) && compatHeaders.get(name) !== directHeaders.get(name)
  )
);

const replayableDirectDeltaHeaders = uniq([
  ...functionalValueMismatches.filter((name) => !REQUEST_SCOPED_HEADERS.has(name)),
  ...directOnlyHeaders,
  ...identityDirectOnlyHeaders
]).sort();

const casesDir = path.join(outDir, 'cases');
fs.mkdirSync(casesDir, { recursive: true });

const caseFiles = [
  ['compat-exact.tsv', compatHeaders],
  ['direct-exact.tsv', directHeaders],
  ['shared.tsv', sharedHeaders],
  ['compat-with-direct-beta.tsv', addHeaders(compatHeaders, directHeaders, betaHeaders)],
  ['compat-with-direct-identity.tsv', addHeaders(compatHeaders, directHeaders, identityDeltaHeaders)],
  [
    'compat-with-direct-beta-and-identity.tsv',
    addHeaders(compatHeaders, directHeaders, uniq([...betaHeaders, ...identityDeltaHeaders]))
  ],
  ['compat-with-all-direct-deltas.tsv', addHeaders(compatHeaders, directHeaders, replayableDirectDeltaHeaders)]
];

for (const [fileName, headersMap] of caseFiles) {
  writeTsv(path.join(casesDir, fileName), headersMap);
}

const summaryLines = [
  `compat_source_file=${compatFile}`,
  `direct_source_file=${directFile}`,
  `compat_request_id=${compatRecord.request_id ?? ''}`,
  `direct_request_id=${directRecord.request_id ?? ''}`,
  `compat_body_bytes=${compatRecord.body_bytes ?? ''}`,
  `direct_body_bytes=${directRecord.body_bytes ?? ''}`,
  `compat_body_sha256=${compatRecord.body_sha256 ?? ''}`,
  `direct_body_sha256=${directRecord.body_sha256 ?? ''}`,
  `body_bytes_match=${bodyBytesMatch}`,
  `body_sha256_match=${bodyShaMatch}`,
  `compat_header_count=${compatHeaders.size}`,
  `direct_header_count=${directHeaders.size}`,
  `shared_header_count=${sharedHeaders.size}`,
  `functional_value_mismatches=${csv(functionalValueMismatches)}`,
  `compat_only_headers=${csv(compatOnlyHeaders)}`,
  `direct_only_headers=${csv(directOnlyHeaders)}`,
  `identity_direct_only_headers=${csv(identityDirectOnlyHeaders)}`,
  `request_scoped_value_mismatches=${csv(requestScopedValueMismatches)}`,
  `request_scoped_compat_only_headers=${csv(requestScopedCompatOnlyHeaders)}`,
  `request_scoped_direct_only_headers=${csv(requestScopedDirectOnlyHeaders)}`,
  `all_replayable_direct_delta_headers=${csv(replayableDirectDeltaHeaders)}`,
  `cases_dir=${casesDir}`,
  `case_files=${caseFiles.map(([fileName]) => fileName).join(',')}`
];

fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
