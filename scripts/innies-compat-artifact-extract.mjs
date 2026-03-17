#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [, , artifactPath, requestId, outDir] = process.argv;

if (!artifactPath || !requestId || !outDir) {
  console.error(
    "usage: innies-compat-artifact-extract.mjs <artifact-path> <request-id> <out-dir>",
  );
  process.exit(1);
}

const CHUNK_LABELS = new Set([
  "compat-invalid-request-debug-json-chunk",
  "compat-invalid-request-payload-json-chunk",
  "compat-upstream-request-json-chunk",
  "compat-upstream-response-json-chunk",
]);

function stripLogPrefix(line) {
  const marker = "]: ";
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
      throw new Error("unterminated escape sequence");
    case "\\":
    case "'":
    case '"':
    case "`":
      return next;
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "v":
      return "\v";
    case "0":
      return "\0";
    case "\n":
      return "";
    case "\r":
      if (source[state.index] === "\n") {
        state.index += 1;
      }
      return "";
    case "x": {
      const hex = source.slice(state.index, state.index + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error("invalid hex escape");
      }
      state.index += 2;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    case "u": {
      if (source[state.index] === "{") {
        const end = source.indexOf("}", state.index + 1);
        if (end === -1) {
          throw new Error("invalid unicode escape");
        }
        const hex = source.slice(state.index + 1, end);
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
          throw new Error("invalid unicode escape");
        }
        state.index = end + 1;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }

      const hex = source.slice(state.index, state.index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new Error("invalid unicode escape");
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
  if (!quote || ![`'`, `"`, "`"].includes(quote)) {
    throw new Error("unsupported json literal");
  }

  const state = { index: 1 };
  let output = "";

  while (state.index < trimmed.length) {
    const char = trimmed[state.index++];
    if (char === quote) {
      const trailing = trimmed.slice(state.index).trim();
      if (trailing.length > 0) {
        throw new Error("unexpected trailing data after json literal");
      }
      return output;
    }

    if (char === "\\") {
      output += decodeEscapeSequence(trimmed, state);
      continue;
    }

    output += char;
  }

  throw new Error("unterminated json literal");
}

function parseChunkBlock(lines) {
  const block = {
    chunkIndex: null,
    chunkCount: null,
    jsonChunk: null,
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
    typeof block.jsonChunk !== "string"
  ) {
    throw new Error("incomplete chunk block");
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

    const blockStart = stripped.match(/^\[([^\]]+)\] \{$/);
    if (blockStart && CHUNK_LABELS.has(blockStart[1])) {
      flushActive();
      activeLabel = blockStart[1];
      activeLines = [line];
      continue;
    }

    if (!activeLabel) {
      continue;
    }

    activeLines.push(line);
    if (stripped === "}") {
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
        parts: new Array(block.chunkCount),
      };
    }

    current.parts[block.chunkIndex] = block.jsonChunk;
    current.lastChunkIndex = block.chunkIndex;

    const isComplete = Array.from({ length: current.chunkCount }, (_, index) => {
      return typeof current.parts[index] === "string";
    }).every(Boolean);
    if (isComplete) {
      completed.push(current.parts.join(""));
      current = null;
    }
  }

  return completed;
}

function parseEntriesByLabel(chunkBlocks) {
  const parsed = new Map();

  for (const [label, blocks] of chunkBlocks.entries()) {
    const entries = reconstructEntries(blocks).map((jsonText) => JSON.parse(jsonText));
    parsed.set(label, entries);
  }

  return parsed;
}

function findEntry(entriesByLabel, label, id) {
  const entries = entriesByLabel.get(label) ?? [];
  return entries.find((entry) => entry?.request_id === id) ?? null;
}

function writeJson(outputPath, value) {
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSummary(outputPath, bundle) {
  const summaryLines = [
    `request_id=${requestId}`,
    `provider=${bundle.upstreamRequest?.provider ?? bundle.ingress?.provider ?? "unknown"}`,
    `body_sha256=${bundle.upstreamRequest?.body_sha256 ?? ""}`,
    `body_bytes=${bundle.upstreamRequest?.body_bytes ?? ""}`,
    `upstream_status=${bundle.upstreamResponse?.upstream_status ?? ""}`,
    `upstream_request_id=${
      bundle.upstreamResponse?.parsed_body?.request_id ??
      bundle.upstreamResponse?.response_headers?.["request-id"] ??
      ""
    }`,
    `ingress_anthropic_beta=${bundle.ingress?.anthropic_beta ?? ""}`,
    `upstream_anthropic_beta=${bundle.upstreamRequest?.headers?.["anthropic-beta"] ?? ""}`,
    `upstream_user_agent=${bundle.upstreamRequest?.headers?.["user-agent"] ?? ""}`,
    `payload_available=${bundle.invalidPayload?.payload ? "true" : "false"}`,
  ];

  fs.writeFileSync(outputPath, `${summaryLines.join("\n")}\n`);
}

const artifactContents = fs.readFileSync(artifactPath, "utf8");
const chunkBlocks = collectChunkBlocks(artifactContents);
const entriesByLabel = parseEntriesByLabel(chunkBlocks);

const bundle = {
  ingress: findEntry(entriesByLabel, "compat-invalid-request-debug-json-chunk", requestId),
  invalidPayload: findEntry(
    entriesByLabel,
    "compat-invalid-request-payload-json-chunk",
    requestId,
  ),
  upstreamRequest: findEntry(entriesByLabel, "compat-upstream-request-json-chunk", requestId),
  upstreamResponse: findEntry(entriesByLabel, "compat-upstream-response-json-chunk", requestId),
};

if (!bundle.upstreamRequest && !bundle.upstreamResponse && !bundle.ingress && !bundle.invalidPayload) {
  console.error(`request_id ${requestId} not found in ${artifactPath}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

if (bundle.ingress) {
  writeJson(path.join(outDir, "ingress.json"), bundle.ingress);
}

if (bundle.invalidPayload) {
  writeJson(path.join(outDir, "invalid-request-payload.json"), bundle.invalidPayload);
  if (bundle.invalidPayload.payload) {
    writeJson(path.join(outDir, "payload.json"), bundle.invalidPayload.payload);
  }
}

if (bundle.upstreamRequest) {
  writeJson(path.join(outDir, "upstream-request.json"), bundle.upstreamRequest);
}

if (bundle.upstreamResponse) {
  writeJson(path.join(outDir, "upstream-response.json"), bundle.upstreamResponse);
}

writeSummary(path.join(outDir, "summary.txt"), bundle);
