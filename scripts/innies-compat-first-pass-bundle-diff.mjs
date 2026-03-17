import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

function usage() {
  throw new Error(
    'usage: node innies-compat-first-pass-bundle-diff.mjs <left-spec> <right-spec> <out-dir>'
  );
}

function parseSpec(spec) {
  const suffixes = ['#ingress', '#upstream'];
  for (const suffix of suffixes) {
    if (spec.endsWith(suffix)) {
      return {
        raw: spec,
        path: spec.slice(0, -suffix.length),
        selector: suffix.slice(1)
      };
    }
  }
  return { raw: spec, path: spec, selector: null };
}

function parseSummary(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    result[key] = value;
  }
  return result;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function compareValues(left, right, path = '', diffs = [], limit = 25) {
  if (diffs.length >= limit) return diffs;

  if (stableStringify(left) === stableStringify(right)) {
    return diffs;
  }

  const leftIsObject = left !== null && typeof left === 'object';
  const rightIsObject = right !== null && typeof right === 'object';

  if (!leftIsObject || !rightIsObject || Array.isArray(left) !== Array.isArray(right)) {
    diffs.push(path || '/');
    return diffs;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; index += 1) {
      compareValues(left[index], right[index], `${path}/${index}`, diffs, limit);
      if (diffs.length >= limit) break;
    }
    return diffs;
  }

  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    compareValues(left[key], right[key], `${path}/${key}`, diffs, limit);
    if (diffs.length >= limit) break;
  }
  return diffs;
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    normalized[String(key).toLowerCase()] = String(value);
  }
  return normalized;
}

async function loadDirectoryBundle(directoryPath, selector) {
  const summary = parseSummary((await readOptionalText(join(directoryPath, 'summary.txt'))) ?? '');
  const payload = await readOptionalJson(join(directoryPath, 'payload.json'));
  const labelBase = basename(directoryPath);

  if (selector === 'ingress') {
    const ingress = await readJson(join(directoryPath, 'ingress.json'));
    return {
      label: `${labelBase}#ingress`,
      sourcePath: directoryPath,
      kind: 'ingress',
      requestId: ingress.requestId ?? summary.request_id ?? '',
      method: '',
      targetUrl: summary.target_url ?? '',
      headers: normalizeHeaders({
        'anthropic-beta': ingress.anthropicBeta ?? '',
        'anthropic-version': ingress.anthropicVersion ?? '',
        'x-request-id': ingress.requestIdHeader ?? ''
      }),
      bodyBytes: summary.body_bytes ?? '',
      bodySha256:
        summary.body_sha256 ??
        (payload === null ? '' : sha256(stableStringify(payload))),
      payload
    };
  }

  const upstreamRequest = await readJson(join(directoryPath, 'upstream-request.json'));
  return {
    label: `${labelBase}#upstream`,
    sourcePath: directoryPath,
    kind: 'upstream',
    requestId: upstreamRequest.request_id ?? summary.request_id ?? '',
    method: upstreamRequest.method ?? '',
    targetUrl: upstreamRequest.target_url ?? summary.target_url ?? '',
    headers: normalizeHeaders(upstreamRequest.headers ?? {}),
    bodyBytes: String(upstreamRequest.body_bytes ?? summary.body_bytes ?? ''),
    bodySha256:
      upstreamRequest.body_sha256 ??
      summary.body_sha256 ??
      (payload === null ? '' : sha256(stableStringify(payload))),
    payload
  };
}

async function loadFileBundle(filePath, selector) {
  const value = await readJson(filePath);
  const fileName = basename(filePath);
  const parentDirectory = dirname(filePath);
  const payload = await readOptionalJson(join(parentDirectory, 'payload.json'));

  const inferredSelector =
    selector ??
    (fileName === 'ingress.json' ? 'ingress' : 'upstream');

  if (inferredSelector === 'ingress') {
    return {
      label: `${basename(parentDirectory)}#ingress`,
      sourcePath: filePath,
      kind: 'ingress',
      requestId: value.requestId ?? '',
      method: '',
      targetUrl: '',
      headers: normalizeHeaders({
        'anthropic-beta': value.anthropicBeta ?? '',
        'anthropic-version': value.anthropicVersion ?? '',
        'x-request-id': value.requestIdHeader ?? ''
      }),
      bodyBytes: '',
      bodySha256: payload === null ? '' : sha256(stableStringify(payload)),
      payload
    };
  }

  return {
    label: `${basename(parentDirectory)}#upstream`,
    sourcePath: filePath,
    kind: 'upstream',
    requestId: value.request_id ?? '',
    method: value.method ?? '',
    targetUrl: value.target_url ?? '',
    headers: normalizeHeaders(value.headers ?? {}),
    bodyBytes: String(value.body_bytes ?? ''),
    bodySha256:
      value.body_sha256 ??
      (payload === null ? '' : sha256(stableStringify(payload))),
    payload
  };
}

async function loadBundle(specText) {
  const spec = parseSpec(specText);
  const resolvedPath = resolve(spec.path);
  const fileStat = await stat(resolvedPath);
  if (fileStat.isDirectory()) {
    return loadDirectoryBundle(resolvedPath, spec.selector ?? 'upstream');
  }
  return loadFileBundle(resolvedPath, spec.selector);
}

function joinList(values) {
  return values.length === 0 ? '' : values.join(',');
}

function buildHeaderDiff(leftHeaders, rightHeaders) {
  const leftKeys = Object.keys(leftHeaders).sort();
  const rightKeys = Object.keys(rightHeaders).sort();
  const onlyLeft = leftKeys.filter((key) => !(key in rightHeaders));
  const onlyRight = rightKeys.filter((key) => !(key in leftHeaders));
  const mismatches = leftKeys
    .filter((key) => key in rightHeaders)
    .filter((key) => leftHeaders[key] !== rightHeaders[key]);
  return { onlyLeft, onlyRight, mismatches };
}

function buildHeaderDiffText(left, right, diff) {
  const lines = [];
  for (const key of diff.onlyLeft) {
    lines.push(`only_in_left ${key}: ${left.headers[key]}`);
  }
  for (const key of diff.onlyRight) {
    lines.push(`only_in_right ${key}: ${right.headers[key]}`);
  }
  for (const key of diff.mismatches) {
    lines.push(`mismatch ${key}`);
    lines.push(`  left: ${left.headers[key]}`);
    lines.push(`  right: ${right.headers[key]}`);
  }
  if (lines.length === 0) {
    lines.push('headers match');
  }
  return `${lines.join('\n')}\n`;
}

function buildBodyDiff(left, right) {
  if (left.payload === null || right.payload === null) {
    return {
      payloadCompareStatus: 'unavailable',
      payloadCanonicalEqual: '',
      text: 'payload comparison unavailable\n'
    };
  }

  const leftCanonical = stableStringify(left.payload);
  const rightCanonical = stableStringify(right.payload);
  if (leftCanonical === rightCanonical) {
    return {
      payloadCompareStatus: 'available',
      payloadCanonicalEqual: 'true',
      text: 'payload canonical json matches\n'
    };
  }

  const paths = compareValues(left.payload, right.payload);
  const lines = ['payload canonical json differs', ...paths.map((path) => `  ${path}`)];
  return {
    payloadCompareStatus: 'available',
    payloadCanonicalEqual: 'false',
    text: `${lines.join('\n')}\n`
  };
}

async function main() {
  const [, , leftSpec, rightSpec, outDirArg] = process.argv;
  if (!leftSpec || !rightSpec || !outDirArg) {
    usage();
  }

  const outDir = resolve(outDirArg);
  const [left, right] = await Promise.all([loadBundle(leftSpec), loadBundle(rightSpec)]);
  const headerDiff = buildHeaderDiff(left.headers, right.headers);
  const bodyDiff = buildBodyDiff(left, right);

  await mkdir(outDir, { recursive: true });

  const summaryLines = [
    `left_label=${left.label}`,
    `right_label=${right.label}`,
    `left_source=${left.sourcePath}`,
    `right_source=${right.sourcePath}`,
    `left_request_id=${left.requestId}`,
    `right_request_id=${right.requestId}`,
    `left_method=${left.method}`,
    `right_method=${right.method}`,
    `body_bytes_left=${left.bodyBytes}`,
    `body_bytes_right=${right.bodyBytes}`,
    `body_sha256_left=${left.bodySha256}`,
    `body_sha256_right=${right.bodySha256}`,
    `header_only_in_left=${joinList(headerDiff.onlyLeft)}`,
    `header_only_in_right=${joinList(headerDiff.onlyRight)}`,
    `header_value_mismatches=${joinList(headerDiff.mismatches)}`,
    `payload_compare_status=${bodyDiff.payloadCompareStatus}`,
    `payload_canonical_equal=${bodyDiff.payloadCanonicalEqual}`
  ];

  await Promise.all([
    writeFile(join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`),
    writeFile(join(outDir, 'header-diff.txt'), buildHeaderDiffText(left, right, headerDiff)),
    writeFile(join(outDir, 'body-diff.txt'), bodyDiff.text),
    writeFile(join(outDir, 'normalized-left.json'), `${JSON.stringify(left, null, 2)}\n`),
    writeFile(join(outDir, 'normalized-right.json'), `${JSON.stringify(right, null, 2)}\n`)
  ]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
