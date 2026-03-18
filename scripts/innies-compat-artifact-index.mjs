#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  collectChunkBlocks,
  parseEntriesByLabel,
} from './_compatArtifactChunks.mjs';

const [artifactPathArg, outDirArg, providerFilterArg, statusFilterArg] = process.argv.slice(2);

if (!artifactPathArg) {
  console.error('error: missing compat artifact path');
  process.exit(1);
}

if (!outDirArg) {
  console.error('error: missing output dir');
  process.exit(1);
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
  } else if (
    provider === 'anthropic' &&
    upstreamStatus === 400 &&
    upstreamRequest &&
    upstreamResponse
  ) {
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
    candidateType,
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
  if (!entry || typeof entry.request_id !== 'string') {
    return;
  }

  const requestId = entry.request_id;
  const bucket = buckets.get(requestId) ?? {};
  bucket[labelKey] = entry;
  buckets.set(requestId, bucket);
}

for (const entry of entriesByLabel.get('compat-upstream-request-json-chunk') ?? []) {
  upsertEntry('upstreamRequest', entry);
}

for (const entry of entriesByLabel.get('compat-upstream-response-json-chunk') ?? []) {
  upsertEntry('upstreamResponse', entry);
}

for (const entry of entriesByLabel.get('compat-invalid-request-debug-json-chunk') ?? []) {
  upsertEntry('invalidDebug', entry);
}

for (const entry of entriesByLabel.get('compat-invalid-request-payload-json-chunk') ?? []) {
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
    `error: no matching compat artifact entries found in ${artifactPath} for provider=${
      providerFilter || '*'
    } status=${statusFilter === null ? '*' : statusFilter}`,
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
  knownGoodCandidateCount: matchingEntries.filter(
    (entry) => entry.candidateType === 'known_good_candidate',
  ).length,
  invalidRequestCandidateCount: matchingEntries.filter(
    (entry) => entry.candidateType === 'invalid_request_candidate',
  ).length,
  entries: matchingEntries,
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
    } candidate_type=${entry.candidateType} provider_request_id=${
      entry.providerRequestId
    } body_sha256=${entry.bodySha256} has_upstream_request=${String(
      entry.hasUpstreamRequest,
    )} has_upstream_response=${String(entry.hasUpstreamResponse)} has_invalid_debug=${String(
      entry.hasInvalidDebug,
    )} has_invalid_payload=${String(entry.hasInvalidPayload)}`,
  );
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
