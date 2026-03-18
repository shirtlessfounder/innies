#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [failingArg, knownGoodArg, outDirArg] = process.argv.slice(2);

if (!failingArg) {
  console.error('error: missing failing bundle path');
  process.exit(1);
}

if (!knownGoodArg) {
  console.error('error: missing known-good bundle path');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing diff output dir');
  process.exit(1);
}

const REQUEST_FILE_CANDIDATES = [
  'upstream-request.json',
  'direct-request.json',
  'request.json'
];
const RESPONSE_FILE_CANDIDATES = [
  'upstream-response.json',
  'direct-response.json',
  'response.json'
];
const PAYLOAD_FILE_NAME = 'payload.json';
const SUMMARY_FILE_NAME = 'summary.txt';
const IGNORED_HEADERS = new Set(['authorization', 'content-length', 'x-request-id']);
const BODY_DIFF_LIMIT = 25;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveBundleDir(inputPathArg) {
  const resolved = path.resolve(inputPathArg);
  if (!fs.existsSync(resolved)) {
    fail(`error: bundle path not found: ${inputPathArg}`);
  }
  const stats = fs.statSync(resolved);
  if (stats.isDirectory()) {
    return resolved;
  }
  if (stats.isFile()) {
    return path.dirname(resolved);
  }
  fail(`error: unsupported bundle path: ${inputPathArg}`);
}

function findFirstExisting(bundleDir, candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(bundleDir, candidate);
    if (fs.existsSync(fullPath)) {
      return { path: fullPath, name: candidate };
    }
  }
  return null;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`error: failed to parse ${label}: ${filePath}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

function readKeyValueFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) {
    return result;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((accumulator, key) => {
      accumulator[key] = stableValue(value[key]);
      return accumulator;
    }, {});
  }
  return value;
}

function stableJsonString(value) {
  return JSON.stringify(stableValue(value));
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const normalized = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).trim().toLowerCase();
    if (!name) {
      continue;
    }
    let value = rawValue;
    if (Array.isArray(value)) {
      value = value.join(', ');
    } else if (value === null || value === undefined) {
      value = '';
    } else if (typeof value === 'object') {
      value = JSON.stringify(value);
    } else {
      value = String(value);
    }
    normalized[name] = value.trim();
  }
  return normalized;
}

function summarizeValue(value) {
  if (value === undefined) {
    return '(missing)';
  }
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value);
  }
  if (text.length <= 120) {
    return text;
  }
  return `${text.slice(0, 117)}...`;
}

function joinNames(values) {
  return values.length > 0 ? values.join(',') : '-';
}

function collectHeaderDifferences(failingHeaders, knownGoodHeaders) {
  const names = [...new Set([...Object.keys(failingHeaders), ...Object.keys(knownGoodHeaders)])].sort();
  const differences = [];
  for (const name of names) {
    const failingValue = failingHeaders[name];
    const knownGoodValue = knownGoodHeaders[name];
    if (failingValue === knownGoodValue) {
      continue;
    }
    let kind = 'value_mismatch';
    if (failingValue === undefined) {
      kind = 'only_in_known_good';
    } else if (knownGoodValue === undefined) {
      kind = 'only_in_failing';
    }
    differences.push({
      header: name,
      kind,
      failingValue,
      knownGoodValue,
      ignored: IGNORED_HEADERS.has(name)
    });
  }
  return differences;
}

function diffJsonValues(failingValue, knownGoodValue, currentPath, differences) {
  if (differences.length >= BODY_DIFF_LIMIT) {
    return;
  }

  const pathLabel = currentPath || '$';

  if (Object.is(failingValue, knownGoodValue)) {
    return;
  }

  if (failingValue === undefined) {
    differences.push({
      path: pathLabel,
      kind: 'only_in_known_good',
      failingValue,
      knownGoodValue
    });
    return;
  }

  if (knownGoodValue === undefined) {
    differences.push({
      path: pathLabel,
      kind: 'only_in_failing',
      failingValue,
      knownGoodValue
    });
    return;
  }

  if (Array.isArray(failingValue) && Array.isArray(knownGoodValue)) {
    const limit = Math.max(failingValue.length, knownGoodValue.length);
    for (let index = 0; index < limit; index += 1) {
      diffJsonValues(
        failingValue[index],
        knownGoodValue[index],
        `${pathLabel}[${index}]`,
        differences
      );
      if (differences.length >= BODY_DIFF_LIMIT) {
        return;
      }
    }
    return;
  }

  if (
    failingValue &&
    knownGoodValue &&
    typeof failingValue === 'object' &&
    typeof knownGoodValue === 'object' &&
    !Array.isArray(failingValue) &&
    !Array.isArray(knownGoodValue)
  ) {
    const keys = [...new Set([...Object.keys(failingValue), ...Object.keys(knownGoodValue)])].sort();
    for (const key of keys) {
      const nextPath = pathLabel === '$' ? key : `${pathLabel}.${key}`;
      diffJsonValues(failingValue[key], knownGoodValue[key], nextPath, differences);
      if (differences.length >= BODY_DIFF_LIMIT) {
        return;
      }
    }
    return;
  }

  differences.push({
    path: pathLabel,
    kind: 'value_mismatch',
    failingValue,
    knownGoodValue
  });
}

function resolveBundle(inputPathArg, label) {
  const bundleDir = resolveBundleDir(inputPathArg);
  const payloadPath = path.join(bundleDir, PAYLOAD_FILE_NAME);
  if (!fs.existsSync(payloadPath)) {
    fail(`error: missing payload.json in bundle dir: ${bundleDir}`);
  }

  const requestFile = findFirstExisting(bundleDir, REQUEST_FILE_CANDIDATES);
  if (!requestFile) {
    fail(`error: missing request json in bundle dir: ${bundleDir}`);
  }

  const responseFile = findFirstExisting(bundleDir, RESPONSE_FILE_CANDIDATES);
  if (!responseFile) {
    fail(`error: missing response json in bundle dir: ${bundleDir}`);
  }

  const summaryPath = path.join(bundleDir, SUMMARY_FILE_NAME);
  const summary = readKeyValueFile(summaryPath);
  const request = readJson(requestFile.path, `${label} request json`);
  const response = readJson(responseFile.path, `${label} response json`);
  const payloadText = fs.readFileSync(payloadPath, 'utf8');
  const parsedPayload = tryParseJson(payloadText);
  const normalizedHeaders = normalizeHeaders(
    request.headers ?? request.request_headers ?? request.request?.headers ?? {}
  );

  const requestMethod = String(
    request.method ??
      request.request?.method ??
      summary.method ??
      'POST'
  ).toUpperCase();
  const targetUrl = String(
    request.target_url ??
      request.targetUrl ??
      request.url ??
      request.request?.target_url ??
      request.request?.targetUrl ??
      request.request?.url ??
      summary.target_url ??
      ''
  );
  const requestId = String(
    request.request_id ??
      request.requestId ??
      request.request?.request_id ??
      response.request_id ??
      summary.request_id ??
      ''
  );
  const providerRequestId = String(
    response.provider_request_id ??
      response.providerRequestId ??
      response.request_id ??
      response.requestId ??
      summary.provider_request_id ??
      ''
  );

  const statusValue =
    response.status ??
    response.http_status ??
    response.status_code ??
    summary.status;
  const status = Number(statusValue);
  const safeStatus = Number.isFinite(status) ? status : null;

  return {
    label,
    dir: bundleDir,
    payloadPath,
    requestPath: requestFile.path,
    requestFileName: requestFile.name,
    responsePath: responseFile.path,
    responseFileName: responseFile.name,
    summaryPath: fs.existsSync(summaryPath) ? summaryPath : null,
    summary,
    request,
    response,
    headers: normalizedHeaders,
    requestMethod,
    targetUrl,
    requestId,
    providerRequestId,
    status: safeStatus,
    payloadText,
    payloadJson: parsedPayload.ok ? parsedPayload.value : null,
    payloadJsonValid: parsedPayload.ok,
    payloadBytes: Buffer.byteLength(payloadText),
    bodySha256: sha256Hex(payloadText)
  };
}

const failingBundle = resolveBundle(failingArg, 'failing');
const knownGoodBundle = resolveBundle(knownGoodArg, 'known-good');
const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const rawBodyEqual = failingBundle.payloadText === knownGoodBundle.payloadText;
let canonicalJsonBodyEqual = false;
const bodyDifferences = [];
if (failingBundle.payloadJsonValid && knownGoodBundle.payloadJsonValid) {
  canonicalJsonBodyEqual =
    stableJsonString(failingBundle.payloadJson) === stableJsonString(knownGoodBundle.payloadJson);
  if (!canonicalJsonBodyEqual) {
    diffJsonValues(failingBundle.payloadJson, knownGoodBundle.payloadJson, '', bodyDifferences);
  }
} else {
  canonicalJsonBodyEqual = rawBodyEqual;
  if (!rawBodyEqual) {
    bodyDifferences.push({
      path: '$',
      kind: 'value_mismatch',
      failingValue: failingBundle.payloadText,
      knownGoodValue: knownGoodBundle.payloadText
    });
  }
}

const requestMethodEqual = failingBundle.requestMethod === knownGoodBundle.requestMethod;
const targetUrlEqual = failingBundle.targetUrl === knownGoodBundle.targetUrl;

const headerDifferences = collectHeaderDifferences(failingBundle.headers, knownGoodBundle.headers);
const meaningfulHeaderDifferences = headerDifferences.filter((entry) => !entry.ignored);
const ignoredHeaderDifferences = headerDifferences.filter((entry) => entry.ignored);

const meaningfulBodyDelta = failingBundle.payloadJsonValid && knownGoodBundle.payloadJsonValid
  ? !canonicalJsonBodyEqual
  : !rawBodyEqual;
const meaningfulWireDelta =
  meaningfulHeaderDifferences.length > 0 || !requestMethodEqual || !targetUrlEqual;

const providerSideCandidate =
  !meaningfulWireDelta &&
  !meaningfulBodyDelta &&
  failingBundle.status === 400 &&
  knownGoodBundle.status === 200;

let classification = 'no_meaningful_request_delta';
if (meaningfulWireDelta && meaningfulBodyDelta) {
  classification = 'mixed_request_delta';
} else if (meaningfulBodyDelta) {
  classification = 'body_delta_detected';
} else if (meaningfulWireDelta) {
  classification = 'wire_delta_detected';
} else if (providerSideCandidate) {
  classification = 'no_meaningful_request_delta_provider_side_candidate';
}

const summary = {
  mode: 'request_bundle_diff',
  outputDir: outDir,
  classification,
  providerSideCandidate,
  requestMethodEqual,
  targetUrlEqual,
  rawBodyEqual,
  canonicalJsonBodyEqual,
  meaningfulWireDelta,
  meaningfulBodyDelta,
  meaningfulHeaderDifferences,
  ignoredHeaderDifferences,
  bodyDifferences,
  failingBundle: {
    dir: failingBundle.dir,
    payloadPath: failingBundle.payloadPath,
    requestPath: failingBundle.requestPath,
    requestSource: failingBundle.requestFileName,
    responsePath: failingBundle.responsePath,
    responseSource: failingBundle.responseFileName,
    summaryPath: failingBundle.summaryPath,
    requestMethod: failingBundle.requestMethod,
    targetUrl: failingBundle.targetUrl,
    requestId: failingBundle.requestId,
    providerRequestId: failingBundle.providerRequestId,
    status: failingBundle.status,
    payloadBytes: failingBundle.payloadBytes,
    bodySha256: failingBundle.bodySha256,
    headers: failingBundle.headers
  },
  knownGoodBundle: {
    dir: knownGoodBundle.dir,
    payloadPath: knownGoodBundle.payloadPath,
    requestPath: knownGoodBundle.requestPath,
    requestSource: knownGoodBundle.requestFileName,
    responsePath: knownGoodBundle.responsePath,
    responseSource: knownGoodBundle.responseFileName,
    summaryPath: knownGoodBundle.summaryPath,
    requestMethod: knownGoodBundle.requestMethod,
    targetUrl: knownGoodBundle.targetUrl,
    requestId: knownGoodBundle.requestId,
    providerRequestId: knownGoodBundle.providerRequestId,
    status: knownGoodBundle.status,
    payloadBytes: knownGoodBundle.payloadBytes,
    bodySha256: knownGoodBundle.bodySha256,
    headers: knownGoodBundle.headers
  }
};

const summaryLines = [
  'mode=request_bundle_diff',
  `failing_bundle_dir=${failingBundle.dir}`,
  `known_good_bundle_dir=${knownGoodBundle.dir}`,
  `failing_request_source=${failingBundle.requestFileName}`,
  `known_good_request_source=${knownGoodBundle.requestFileName}`,
  `classification=${classification}`,
  `provider_side_candidate=${String(providerSideCandidate)}`,
  `request_method_equal=${String(requestMethodEqual)}`,
  `target_url_equal=${String(targetUrlEqual)}`,
  `raw_body_equal=${String(rawBodyEqual)}`,
  `canonical_json_body_equal=${String(canonicalJsonBodyEqual)}`,
  `failing_status=${failingBundle.status ?? ''}`,
  `known_good_status=${knownGoodBundle.status ?? ''}`,
  `failing_provider_request_id=${failingBundle.providerRequestId}`,
  `known_good_provider_request_id=${knownGoodBundle.providerRequestId}`,
  `failing_body_sha256=${failingBundle.bodySha256}`,
  `known_good_body_sha256=${knownGoodBundle.bodySha256}`,
  `meaningful_header_difference_count=${meaningfulHeaderDifferences.length}`,
  `ignored_header_difference_count=${ignoredHeaderDifferences.length}`,
  `meaningful_header_names=${joinNames(meaningfulHeaderDifferences.map((entry) => entry.header))}`,
  `ignored_header_names=${joinNames(ignoredHeaderDifferences.map((entry) => entry.header))}`,
  `body_difference_path_count=${bodyDifferences.length}`,
  `body_difference_paths=${joinNames(bodyDifferences.map((entry) => entry.path))}`
];

for (const difference of meaningfulHeaderDifferences) {
  summaryLines.push(
    `meaningful_header_diff=${difference.header} kind=${difference.kind} failing=${summarizeValue(difference.failingValue)} known_good=${summarizeValue(difference.knownGoodValue)}`
  );
}

for (const difference of ignoredHeaderDifferences) {
  summaryLines.push(
    `ignored_header_diff=${difference.header} kind=${difference.kind} failing=${summarizeValue(difference.failingValue)} known_good=${summarizeValue(difference.knownGoodValue)}`
  );
}

for (const difference of bodyDifferences) {
  summaryLines.push(
    `body_diff=${difference.path} kind=${difference.kind} failing=${summarizeValue(difference.failingValue)} known_good=${summarizeValue(difference.knownGoodValue)}`
  );
}

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
