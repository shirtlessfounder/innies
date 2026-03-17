#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [artifactPathArg, outDirArg, providerFilterArg, statusFilterArg] = process.argv.slice(2);

if (!artifactPathArg) {
  console.error('error: missing compat artifact path');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing output dir');
  process.exit(1);
}

const CHUNK_LABELS = new Set([
  '[compat-invalid-request-debug-json-chunk]',
  '[compat-invalid-request-payload-json-chunk]',
  '[compat-upstream-request-json-chunk]',
  '[compat-upstream-response-json-chunk]'
]);

function stripLogPrefix(line) {
  const marker = ']: ';
  const markerIndex = line.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  return line.slice(markerIndex + marker.length);
}

function decodeEscapeSequence(source, state) {
  const next = source[state.index++];
  switch (next) {
    case undefined:
      throw new Error('unterminated escape sequence');
    case '\\':
    case '\'':
    case '"':
    case '`':
      return next;
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'v':
      return '\v';
    case '0':
      return '\0';
    case '\n':
      return '';
    case '\r':
      if (source[state.index] === '\n') {
        state.index += 1;
      }
      return '';
    case 'x': {
      const hex = source.slice(state.index, state.index + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error('invalid hex escape');
      }
      state.index += 2;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    case 'u': {
      if (source[state.index] === '{') {
        const end = source.indexOf('}', state.index + 1);
        if (end === -1) {
          throw new Error('invalid unicode escape');
        }
        const hex = source.slice(state.index + 1, end);
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
          throw new Error('invalid unicode escape');
        }
        state.index = end + 1;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }

      const hex = source.slice(state.index, state.index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new Error('invalid unicode escape');
      }
      state.index += 4;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    default:
      return next;
  }
}

function decodeJsStringLiteral(source) {
  const trimmed = source.trim();
  const quote = trimmed[0];
  if (!quote || ![`'`, '"', '`'].includes(quote)) {
    throw new Error('unsupported json literal');
  }

  const state = { index: 1 };
  let output = '';

  while (state.index < trimmed.length) {
    const char = trimmed[state.index++];
    if (char === quote) {
      const trailing = trimmed.slice(state.index).trim();
      if (trailing.length > 0) {
        throw new Error('unexpected trailing data after json literal');
      }
      return output;
    }

    if (char === '\\') {
      output += decodeEscapeSequence(trimmed, state);
      continue;
    }

    output += char;
  }

  throw new Error('unterminated json literal');
}

function parseChunkBlock(lines) {
  const block = {
    chunkIndex: null,
    chunkCount: null,
    jsonChunk: null
  };

  for (const line of lines) {
    const stripped = stripLogPrefix(line);
    if (!stripped) {
      continue;
    }

    const chunkIndexMatch = stripped.match(/^\s*chunk_index:\s*(\d+),?\s*$/);
    if (chunkIndexMatch) {
      block.chunkIndex = Number.parseInt(chunkIndexMatch[1], 10);
      continue;
    }

    const chunkCountMatch = stripped.match(/^\s*chunk_count:\s*(\d+),?\s*$/);
    if (chunkCountMatch) {
      block.chunkCount = Number.parseInt(chunkCountMatch[1], 10);
      continue;
    }

    const jsonMatch = stripped.match(/^\s*json:\s*(.+)\s*$/);
    if (jsonMatch) {
      block.jsonChunk = decodeJsStringLiteral(jsonMatch[1]);
    }
  }

  if (
    !Number.isInteger(block.chunkIndex) ||
    !Number.isInteger(block.chunkCount) ||
    typeof block.jsonChunk !== 'string'
  ) {
    throw new Error('incomplete chunk block');
  }

  return block;
}

function collectChunkBlocks(contents) {
  const lines = contents.split(/\r?\n/);
  const chunkBlocks = new Map();
  let activeLabel = null;
  let activeLines = [];

  const flushActive = () => {
    if (!activeLabel) {
      return;
    }
    const parsed = parseChunkBlock(activeLines);
    const blocks = chunkBlocks.get(activeLabel) ?? [];
    blocks.push(parsed);
    chunkBlocks.set(activeLabel, blocks);
    activeLabel = null;
    activeLines = [];
  };

  for (const line of lines) {
    const stripped = stripLogPrefix(line);
    if (!stripped) {
      continue;
    }

    if (stripped.endsWith(' {')) {
      const candidateLabel = stripped.slice(0, -2);
      if (CHUNK_LABELS.has(candidateLabel)) {
        flushActive();
        activeLabel = candidateLabel;
        activeLines = [line];
        continue;
      }
    }

    if (!activeLabel) {
      continue;
    }

    activeLines.push(line);
    if (stripped === '}') {
      flushActive();
    }
  }

  flushActive();
  return chunkBlocks;
}

function reconstructEntries(blocks) {
  const completed = [];
  let current = null;

  for (const block of blocks) {
    const shouldStartNew =
      !current ||
      block.chunkIndex === 0 ||
      block.chunkCount !== current.chunkCount ||
      block.chunkIndex <= current.lastChunkIndex ||
      current.parts[block.chunkIndex] !== undefined;

    if (shouldStartNew) {
      current = {
        chunkCount: block.chunkCount,
        lastChunkIndex: -1,
        parts: new Array(block.chunkCount)
      };
    }

    current.parts[block.chunkIndex] = block.jsonChunk;
    current.lastChunkIndex = block.chunkIndex;

    const isComplete = Array.from({ length: current.chunkCount }, (_, index) => {
      return typeof current.parts[index] === 'string';
    }).every(Boolean);

    if (isComplete) {
      completed.push(current.parts.join(''));
      current = null;
    }
  }

  return completed;
}

function parseEntriesByLabel(chunkBlocks) {
  const parsed = new Map();

  for (const [label, blocks] of chunkBlocks.entries()) {
    const entries = reconstructEntries(blocks)
      .map((jsonText) => JSON.parse(jsonText))
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.request_id === 'string');
    parsed.set(label, entries);
  }

  return parsed;
}

function getProviderRequestId(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  if (entry.parsed_body && typeof entry.parsed_body.request_id === 'string') {
    return entry.parsed_body.request_id;
  }

  if (entry.response_headers && typeof entry.response_headers['request-id'] === 'string') {
    return entry.response_headers['request-id'];
  }

  return '';
}

function parseStatusFilter(input) {
  if (!input) {
    return null;
  }

  if (!/^\d+$/.test(input)) {
    console.error(`error: invalid upstream status filter: ${input}`);
    process.exit(1);
  }

  return Number.parseInt(input, 10);
}

function buildEntry(requestId, bucket) {
  const upstreamRequest = bucket.upstreamRequest ?? null;
  const upstreamResponse = bucket.upstreamResponse ?? null;
  const invalidDebug = bucket.invalidDebug ?? null;
  const invalidPayload = bucket.invalidPayload ?? null;
  const headers = upstreamRequest?.headers ?? {};

  const provider =
    upstreamRequest?.provider ??
    upstreamResponse?.provider ??
    invalidDebug?.provider ??
    invalidPayload?.provider ??
    'unknown';

  const upstreamStatus =
    typeof upstreamResponse?.upstream_status === 'number'
      ? upstreamResponse.upstream_status
      : null;

  let candidateType = 'other';
  if (provider === 'anthropic' && upstreamStatus === 200 && upstreamRequest && upstreamResponse) {
    candidateType = 'known_good_candidate';
  } else if (provider === 'anthropic' && upstreamStatus === 400 && upstreamRequest && upstreamResponse) {
    candidateType = 'invalid_request_candidate';
  }

  return {
    requestId,
    provider,
    proxiedPath: upstreamRequest?.proxied_path ?? invalidDebug?.proxied_path ?? '',
    targetUrl: upstreamRequest?.target_url ?? invalidDebug?.target_url ?? '',
    attemptNo: upstreamRequest?.attempt_no ?? invalidDebug?.attempt_no ?? null,
    model: upstreamRequest?.model ?? invalidDebug?.model ?? '',
    bodyBytes: upstreamRequest?.body_bytes ?? invalidDebug?.body_bytes ?? null,
    bodySha256: upstreamRequest?.body_sha256 ?? invalidDebug?.body_sha256 ?? '',
    upstreamStatus,
    providerRequestId: getProviderRequestId(upstreamResponse),
    upstreamAnthropicBeta: headers['anthropic-beta'] ?? '',
    upstreamUserAgent: headers['user-agent'] ?? '',
    xApp: headers['x-app'] ?? '',
    xRequestId: headers['x-request-id'] ?? '',
    hasUpstreamRequest: Boolean(upstreamRequest),
    hasUpstreamResponse: Boolean(upstreamResponse),
    hasInvalidDebug: Boolean(invalidDebug),
    hasInvalidPayload: Boolean(invalidPayload),
    candidateType
  };
}

const artifactPath = path.resolve(artifactPathArg);
if (!fs.existsSync(artifactPath)) {
  console.error(`error: artifact not found: ${artifactPathArg}`);
  process.exit(1);
}

const outDir = path.resolve(outDirArg);
const providerFilter = providerFilterArg || '';
const statusFilter = parseStatusFilter(statusFilterArg || '');

const artifactContents = fs.readFileSync(artifactPath, 'utf8');
const chunkBlocks = collectChunkBlocks(artifactContents);
const entriesByLabel = parseEntriesByLabel(chunkBlocks);

const buckets = new Map();

function upsertEntry(labelKey, entry) {
  const requestId = entry.request_id;
  const bucket = buckets.get(requestId) ?? {};
  bucket[labelKey] = entry;
  buckets.set(requestId, bucket);
}

for (const entry of entriesByLabel.get('[compat-upstream-request-json-chunk]') ?? []) {
  upsertEntry('upstreamRequest', entry);
}

for (const entry of entriesByLabel.get('[compat-upstream-response-json-chunk]') ?? []) {
  upsertEntry('upstreamResponse', entry);
}

for (const entry of entriesByLabel.get('[compat-invalid-request-debug-json-chunk]') ?? []) {
  upsertEntry('invalidDebug', entry);
}

for (const entry of entriesByLabel.get('[compat-invalid-request-payload-json-chunk]') ?? []) {
  upsertEntry('invalidPayload', entry);
}

const entries = Array.from(buckets.entries())
  .map(([requestId, bucket]) => buildEntry(requestId, bucket))
  .sort((left, right) => left.requestId.localeCompare(right.requestId));

const matchingEntries = entries.filter((entry) => {
  if (providerFilter && entry.provider !== providerFilter) {
    return false;
  }
  if (statusFilter !== null && entry.upstreamStatus !== statusFilter) {
    return false;
  }
  return true;
});

if (matchingEntries.length === 0) {
  console.error(
    `error: no matching compat artifact entries found in ${artifactPath} for provider=${providerFilter || '*'} status=${
      statusFilter === null ? '*' : statusFilter
    }`
  );
  process.exit(1);
}

const summary = {
  mode: 'compat_artifact_index',
  artifactPath,
  outputDir: outDir,
  providerFilter: providerFilter || null,
  statusFilter,
  entryCount: entries.length,
  matchingEntryCount: matchingEntries.length,
  knownGoodCandidateCount: matchingEntries.filter((entry) => entry.candidateType === 'known_good_candidate').length,
  invalidRequestCandidateCount: matchingEntries.filter((entry) => entry.candidateType === 'invalid_request_candidate').length,
  entries: matchingEntries
};

const summaryLines = [];
summaryLines.push('mode=compat_artifact_index');
summaryLines.push(`artifact_path=${artifactPath}`);
summaryLines.push(`entry_count=${entries.length}`);
summaryLines.push(`matching_entry_count=${matchingEntries.length}`);
if (providerFilter) {
  summaryLines.push(`provider_filter=${providerFilter}`);
}
if (statusFilter !== null) {
  summaryLines.push(`status_filter=${statusFilter}`);
}
summaryLines.push(`known_good_candidate_count=${summary.knownGoodCandidateCount}`);
summaryLines.push(`invalid_request_candidate_count=${summary.invalidRequestCandidateCount}`);

for (const entry of matchingEntries) {
  summaryLines.push(
    `request_id=${entry.requestId} provider=${entry.provider} upstream_status=${
      entry.upstreamStatus === null ? '' : entry.upstreamStatus
    } candidate_type=${entry.candidateType} provider_request_id=${entry.providerRequestId} body_sha256=${entry.bodySha256} has_upstream_request=${String(
      entry.hasUpstreamRequest
    )} has_upstream_response=${String(entry.hasUpstreamResponse)} has_invalid_debug=${String(
      entry.hasInvalidDebug
    )} has_invalid_payload=${String(entry.hasInvalidPayload)}`
  );
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
