import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REQUEST_PAYLOAD_LABEL = '[/v1/messages] request-payload-json-chunk';
const UPSTREAM_REQUEST_LABEL = '[compat-upstream-request-json-chunk]';
const UPSTREAM_RESPONSE_LABEL = '[compat-upstream-response-json-chunk]';
const INVALID_REQUEST_PAYLOAD_LABEL = '[compat-invalid-request-payload-json-chunk]';

function stripLogPrefix(line) {
  return line.replace(/^.*?\]:\s*/, '');
}

function parseJsLiteral(literal) {
  return Function('"use strict"; return (' + literal + ');')();
}

function parseSerializedValue(text) {
  try {
    return JSON.parse(text);
  } catch {}
  return parseJsLiteral(text);
}

function parseScalarLine(line, key) {
  const body = stripLogPrefix(line);
  const match = body.match(new RegExp('^' + key + ':\\s*(.+?),?$'));
  if (!match) return undefined;
  const raw = match[1].trim();
  if (raw === 'undefined' || raw === 'null') return undefined;
  return parseJsLiteral(raw);
}

function normalizeLoggedRequestBody(value) {
  const nestedBody = value?.body;
  if (nestedBody && typeof nestedBody === 'object' && !Array.isArray(nestedBody)) {
    return nestedBody;
  }
  return value ?? null;
}

function parseChunkSeries(lines, startIndex, label) {
  const parts = [];
  let expectedChunkCount = null;
  let index = startIndex;
  while (index < lines.length) {
    const header = stripLogPrefix(lines[index]);
    if (header !== `${label} {`) break;
    const chunkIndexLine = stripLogPrefix(lines[index + 1] ?? '');
    const chunkCountLine = stripLogPrefix(lines[index + 2] ?? '');
    const jsonLine = stripLogPrefix(lines[index + 3] ?? '');
    const closeLine = stripLogPrefix(lines[index + 4] ?? '');
    const chunkIndexMatch = chunkIndexLine.match(/^chunk_index:\s*(\d+),?$/);
    const chunkCountMatch = chunkCountLine.match(/^chunk_count:\s*(\d+),?$/);
    const jsonMatch = jsonLine.match(/^json:\s*(.+)$/);
    if (!chunkIndexMatch || !chunkCountMatch || !jsonMatch || closeLine !== '}') {
      throw new Error(`Malformed ${label} chunk near line ${index + 1}`);
    }
    const chunkIndex = Number(chunkIndexMatch[1]);
    const chunkCount = Number(chunkCountMatch[1]);
    if (expectedChunkCount === null) {
      expectedChunkCount = chunkCount;
    } else if (expectedChunkCount !== chunkCount) {
      throw new Error(`Mismatched ${label} chunk_count near line ${index + 1}`);
    }
    if (chunkIndex !== parts.length) {
      throw new Error(`Out-of-order ${label} chunk_index near line ${index + 1}`);
    }
    parts.push(parseJsLiteral(jsonMatch[1]));
    index += 5;
    if (parts.length === expectedChunkCount) {
      const text = parts.join('');
      return { text, value: parseSerializedValue(text), nextIndex: index - 1 };
    }
  }
  throw new Error(`Incomplete ${label} chunk series near line ${startIndex + 1}`);
}

function readRequestId(value) {
  const raw = value?.request_id ?? value?.requestId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readAttemptNo(value) {
  const raw = value?.attempt_no ?? value?.attemptNo;
  if (raw === undefined || raw === null || raw === '') return 1;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 1;
}

function parseLog(logText) {
  const lines = logText.split(/\r?\n/);
  const requestBodies = [];
  const upstreamRequests = [];
  const upstreamResponses = [];
  const invalidRequestPayloads = [];
  let pendingIngress = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const body = stripLogPrefix(line);
    const anthropicBeta = parseScalarLine(line, 'anthropicBeta');
    if (anthropicBeta !== undefined) {
      pendingIngress.anthropicBeta = anthropicBeta;
      continue;
    }
    const anthropicVersion = parseScalarLine(line, 'anthropicVersion');
    if (anthropicVersion !== undefined) {
      pendingIngress.anthropicVersion = anthropicVersion;
      continue;
    }
    const requestIdHeader = parseScalarLine(line, 'requestIdHeader');
    if (requestIdHeader !== undefined) {
      pendingIngress.requestIdHeader = requestIdHeader;
      continue;
    }
    if (body === `${REQUEST_PAYLOAD_LABEL} {`) {
      const { value, nextIndex } = parseChunkSeries(lines, index, REQUEST_PAYLOAD_LABEL);
      requestBodies.push({
        line: index,
        ingress: { ...pendingIngress },
        value: normalizeLoggedRequestBody(value)
      });
      pendingIngress = {};
      index = nextIndex;
      continue;
    }
    if (body === `${UPSTREAM_REQUEST_LABEL} {`) {
      const { value, nextIndex } = parseChunkSeries(lines, index, UPSTREAM_REQUEST_LABEL);
      upstreamRequests.push({ line: index, value });
      index = nextIndex;
      continue;
    }
    if (body === `${UPSTREAM_RESPONSE_LABEL} {`) {
      const { value, nextIndex } = parseChunkSeries(lines, index, UPSTREAM_RESPONSE_LABEL);
      upstreamResponses.push({ line: index, value });
      index = nextIndex;
      continue;
    }
    if (body === `${INVALID_REQUEST_PAYLOAD_LABEL} {`) {
      const { value, nextIndex } = parseChunkSeries(lines, index, INVALID_REQUEST_PAYLOAD_LABEL);
      invalidRequestPayloads.push({ line: index, value });
      index = nextIndex;
    }
  }

  return { requestBodies, upstreamRequests, upstreamResponses, invalidRequestPayloads };
}

function findNearestPreceding(groups, line) {
  return [...groups].reverse().find((group) => group.line < line) ?? null;
}

function findNearestInvalidPayload(groups, line, nextLine) {
  return groups.find((group) => group.line > line && group.line < nextLine) ?? null;
}

function readProviderRequestId(responseValue) {
  const responseHeaders = responseValue?.response_headers;
  if (responseHeaders && typeof responseHeaders === 'object') {
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (key.toLowerCase() === 'request-id' && typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  }
  const parsedBodyRequestId = responseValue?.parsed_body?.request_id;
  if (typeof parsedBodyRequestId === 'string' && parsedBodyRequestId.length > 0) {
    return parsedBodyRequestId;
  }
  return '';
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const artifactPath = process.env.ARTIFACT_PATH;
  const requestId = process.env.REQUEST_ID;
  const outDir = resolve(process.env.OUT_DIR ?? '');

  if (!artifactPath) {
    throw new Error('missing ARTIFACT_PATH');
  }
  if (!requestId) {
    throw new Error('missing REQUEST_ID');
  }
  if (!outDir) {
    throw new Error('missing OUT_DIR');
  }

  const logText = await readFile(artifactPath, 'utf8');
  const parsed = parseLog(logText);
  const upstreamRequest = parsed.upstreamRequests.find((group) => {
    return readRequestId(group.value) === requestId && readAttemptNo(group.value) === 1;
  });

  if (!upstreamRequest) {
    throw new Error(`could not find first-pass compat upstream request for ${requestId}`);
  }

  const upstreamResponse = parsed.upstreamResponses.find((group) => {
    return readRequestId(group.value) === requestId && readAttemptNo(group.value) === 1;
  });

  if (!upstreamResponse) {
    throw new Error(`could not find first-pass compat upstream response for ${requestId}`);
  }

  const requestBody = findNearestPreceding(parsed.requestBodies, upstreamRequest.line);
  const nextUpstreamLine =
    parsed.upstreamRequests.find((group) => group.line > upstreamRequest.line)?.line ??
    Number.POSITIVE_INFINITY;
  const invalidRequestPayload = findNearestInvalidPayload(
    parsed.invalidRequestPayloads,
    upstreamRequest.line,
    nextUpstreamLine
  );
  const payloadAvailable = Boolean(requestBody?.value);
  const providerRequestId = readProviderRequestId(upstreamResponse.value);

  await mkdir(outDir, { recursive: true });

  const ingressFile = join(outDir, 'ingress.json');
  const payloadFile = join(outDir, 'payload.json');
  const upstreamRequestFile = join(outDir, 'upstream-request.json');
  const upstreamResponseFile = join(outDir, 'upstream-response.json');
  const invalidRequestPayloadFile = join(outDir, 'invalid-request-payload.json');
  const summaryFile = join(outDir, 'summary.txt');

  await writeJson(ingressFile, {
    requestId,
    anthropicBeta: requestBody?.ingress?.anthropicBeta ?? null,
    anthropicVersion: requestBody?.ingress?.anthropicVersion ?? null,
    requestIdHeader: requestBody?.ingress?.requestIdHeader ?? null,
    payloadAvailable
  });

  if (payloadAvailable) {
    await writeJson(payloadFile, requestBody.value);
  }
  await writeJson(upstreamRequestFile, upstreamRequest.value);
  await writeJson(upstreamResponseFile, upstreamResponse.value);
  if (invalidRequestPayload) {
    await writeJson(invalidRequestPayloadFile, invalidRequestPayload.value);
  }

  const summaryLines = [
    `request_id=${requestId}`,
    'attempt_no=1',
    `provider=${upstreamRequest.value?.provider ?? ''}`,
    `proxied_path=${upstreamRequest.value?.proxied_path ?? ''}`,
    `target_url=${upstreamRequest.value?.target_url ?? ''}`,
    `body_bytes=${upstreamRequest.value?.body_bytes ?? ''}`,
    `body_sha256=${upstreamRequest.value?.body_sha256 ?? ''}`,
    `upstream_status=${upstreamResponse.value?.upstream_status ?? ''}`,
    `provider_request_id=${providerRequestId}`,
    `payload_available=${String(payloadAvailable)}`,
    `ingress_anthropic_beta=${requestBody?.ingress?.anthropicBeta ?? ''}`,
    `ingress_anthropic_version=${requestBody?.ingress?.anthropicVersion ?? ''}`,
    `upstream_anthropic_beta=${upstreamRequest.value?.headers?.['anthropic-beta'] ?? ''}`,
    `upstream_user_agent=${upstreamRequest.value?.headers?.['user-agent'] ?? ''}`
  ];
  await writeFile(summaryFile, `${summaryLines.join('\n')}\n`);

  const outputLines = [
    `request_id=${requestId}`,
    'attempt_no=1',
    `provider_request_id=${providerRequestId}`,
    `payload_available=${String(payloadAvailable)}`,
    `payload_file=${payloadAvailable ? payloadFile : ''}`,
    `ingress_file=${ingressFile}`,
    `upstream_request_file=${upstreamRequestFile}`,
    `upstream_response_file=${upstreamResponseFile}`,
    `invalid_request_payload_file=${invalidRequestPayload ? invalidRequestPayloadFile : ''}`,
    `summary_file=${summaryFile}`,
    `out_dir=${outDir}`
  ];
  process.stdout.write(`${outputLines.join('\n')}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
