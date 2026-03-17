#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function stripLogPrefix(line) {
  return line.replace(/^.*?\]:\s*/, '');
}

function decodeJsStringLiteral(literal) {
  if (literal.length < 2) {
    throw new Error('empty string literal');
  }

  const quote = literal[0];
  if ((quote !== '\'' && quote !== '"') || literal.at(-1) !== quote) {
    throw new Error(`unsupported string literal: ${literal.slice(0, 32)}`);
  }

  let result = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const char = literal[index];
    if (char !== '\\') {
      result += char;
      continue;
    }

    index += 1;
    if (index >= literal.length - 1) {
      throw new Error('unterminated escape sequence');
    }

    const escape = literal[index];
    switch (escape) {
      case '\'':
      case '"':
      case '\\':
      case '/':
        result += escape;
        break;
      case 'b':
        result += '\b';
        break;
      case 'f':
        result += '\f';
        break;
      case 'n':
        result += '\n';
        break;
      case 'r':
        result += '\r';
        break;
      case 't':
        result += '\t';
        break;
      case 'v':
        result += '\v';
        break;
      case '0':
        result += '\0';
        break;
      case 'x': {
        const hex = literal.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new Error(`invalid hex escape: \\x${hex}`);
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case 'u': {
        if (literal[index + 1] === '{') {
          const endIndex = literal.indexOf('}', index + 2);
          if (endIndex === -1) {
            throw new Error('unterminated unicode escape');
          }
          const hex = literal.slice(index + 2, endIndex);
          if (!/^[0-9a-fA-F]+$/.test(hex)) {
            throw new Error(`invalid unicode escape: \\u{${hex}}`);
          }
          result += String.fromCodePoint(Number.parseInt(hex, 16));
          index = endIndex;
          break;
        }

        const hex = literal.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error(`invalid unicode escape: \\u${hex}`);
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        throw new Error(`unsupported escape sequence: \\${escape}`);
    }
  }

  return result;
}

function decodeChunkValue(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // fall through to the single-quoted log format
  }

  return decodeJsStringLiteral(rawValue);
}

function parseChunkSeries(lines, startIndex, label) {
  const parts = [];
  let expectedChunkCount = null;
  let index = startIndex;

  while (index < lines.length) {
    const header = stripLogPrefix(lines[index]);
    if (header !== `${label} {`) {
      break;
    }

    const chunkIndexLine = stripLogPrefix(lines[index + 1] ?? '');
    const chunkCountLine = stripLogPrefix(lines[index + 2] ?? '');
    const jsonLine = stripLogPrefix(lines[index + 3] ?? '');
    const closeLine = stripLogPrefix(lines[index + 4] ?? '');
    const chunkIndexMatch = chunkIndexLine.match(/^chunk_index:\s*(\d+),?$/);
    const chunkCountMatch = chunkCountLine.match(/^chunk_count:\s*(\d+),?$/);
    const jsonMatch = jsonLine.match(/^json:\s*(.+)$/);

    if (!chunkIndexMatch || !chunkCountMatch || !jsonMatch || closeLine !== '}') {
      throw new Error(`malformed ${label} chunk near line ${index + 1}`);
    }

    const chunkIndex = Number(chunkIndexMatch[1]);
    const chunkCount = Number(chunkCountMatch[1]);
    if (expectedChunkCount === null) {
      expectedChunkCount = chunkCount;
    } else if (expectedChunkCount !== chunkCount) {
      throw new Error(`mismatched ${label} chunk_count near line ${index + 1}`);
    }

    if (chunkIndex !== parts.length) {
      throw new Error(`out-of-order ${label} chunk_index near line ${index + 1}`);
    }

    parts.push(decodeChunkValue(jsonMatch[1]));
    index += 5;

    if (parts.length === expectedChunkCount) {
      return { text: parts.join(''), nextIndex: index - 1 };
    }
  }

  throw new Error(`incomplete ${label} chunk series near line ${startIndex + 1}`);
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [String(name), String(value)])
  );
}

function parseCapturedRequest(htmlPath, requestId) {
  const lines = readFileSync(htmlPath, 'utf8').split(/\r?\n/);
  const label = '[compat-upstream-request-json-chunk]';

  for (let index = 0; index < lines.length; index += 1) {
    if (stripLogPrefix(lines[index]) !== `${label} {`) {
      continue;
    }

    const { text, nextIndex } = parseChunkSeries(lines, index, label);
    index = nextIndex;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`failed to parse ${label} json: ${error.message}`);
    }

    if (String(parsed?.request_id ?? '') !== requestId) {
      continue;
    }

    return {
      ...parsed,
      headers: normalizeHeaders(parsed.headers)
    };
  }

  throw new Error(`no captured compat upstream request found for ${requestId}`);
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function parseRawResponse(headersPath, bodyPath, statusText, providerRequestId) {
  const headersText = readFileSync(headersPath, 'utf8');
  const bodyText = readFileSync(bodyPath, 'utf8');
  const headers = {};

  for (const line of headersText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    headers[name] = value;
  }

  let parsedBody = null;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    parsedBody = null;
  }

  return {
    status: Number(statusText),
    provider_request_id: providerRequestId || '',
    content_type: headers['content-type'] ?? '',
    body_sha256: sha256Hex(bodyText),
    body_bytes: Buffer.byteLength(bodyText, 'utf8'),
    request_id: String(parsedBody?.request_id ?? ''),
    error_type: String(parsedBody?.error?.type ?? ''),
    error_message: String(parsedBody?.error?.message ?? '')
  };
}

function buildDirectRequestBundle(capturedRequest, payloadText, targetUrl, directRequestId) {
  const headers = { ...capturedRequest.headers };
  headers.authorization = 'Bearer <redacted>';
  headers['x-request-id'] = directRequestId;

  return {
    method: 'POST',
    target_url: targetUrl,
    request_id: directRequestId,
    body_sha256: sha256Hex(payloadText),
    body_bytes: Buffer.byteLength(payloadText, 'utf8'),
    headers
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function extractCapturedCommand(htmlPath, requestId, outDirInput) {
  const outDir = resolve(outDirInput);
  mkdirSync(outDir, { recursive: true });

  const capturedRequest = parseCapturedRequest(htmlPath, requestId);
  writeJson(join(outDir, 'captured-upstream-request.json'), capturedRequest);
  writeFileSync(
    join(outDir, 'captured-headers.tsv'),
    `${Object.entries(capturedRequest.headers).map(([name, value]) => `${name}\t${value}`).join('\n')}\n`
  );
  writeFileSync(
    join(outDir, 'captured-meta.txt'),
    [
      `captured_request_id=${capturedRequest.request_id ?? ''}`,
      `captured_provider=${capturedRequest.provider ?? ''}`,
      `captured_target_url=${capturedRequest.target_url ?? ''}`,
      `captured_proxied_path=${capturedRequest.proxied_path ?? ''}`,
      `captured_attempt_no=${capturedRequest.attempt_no ?? ''}`,
      `captured_stream=${String(Boolean(capturedRequest.stream))}`,
      `captured_body_bytes=${capturedRequest.body_bytes ?? ''}`,
      `captured_body_sha256=${capturedRequest.body_sha256 ?? ''}`
    ].join('\n') + '\n'
  );
}

function writeDirectBundleCommand(
  capturedRequestPath,
  payloadPath,
  targetUrl,
  directRequestId,
  directHeadersPath,
  directBodyPath,
  directStatus,
  providerRequestId,
  outDirInput
) {
  const outDir = resolve(outDirInput);
  mkdirSync(outDir, { recursive: true });

  const capturedRequest = JSON.parse(readFileSync(capturedRequestPath, 'utf8'));
  const payloadText = readFileSync(payloadPath, 'utf8');
  const directRequest = buildDirectRequestBundle(capturedRequest, payloadText, targetUrl, directRequestId);
  const directResponse = parseRawResponse(directHeadersPath, directBodyPath, directStatus, providerRequestId);

  writeJson(join(outDir, 'direct-request.json'), directRequest);
  writeJson(join(outDir, 'direct-response.json'), directResponse);
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'extract-captured':
      if (args.length !== 3) {
        fail('usage: extract-captured <captured-html> <request-id> <out-dir>');
      }
      extractCapturedCommand(args[0], args[1], args[2]);
      break;
    case 'write-direct-bundle':
      if (args.length !== 9) {
        fail(
          'usage: write-direct-bundle <captured-request-json> <payload-path> <target-url> <direct-request-id> <direct-headers-path> <direct-body-path> <direct-status> <provider-request-id> <out-dir>'
        );
      }
      writeDirectBundleCommand(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
        args[7],
        args[8]
      );
      break;
    default:
      fail('expected command: extract-captured | write-direct-bundle');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
