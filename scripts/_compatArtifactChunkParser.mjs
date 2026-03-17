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

  if (block.chunkIndex < 0 || block.chunkIndex >= block.chunkCount) {
    throw new Error("invalid chunk index");
  }

  return block;
}

export function collectChunkBlocks(contents, labelNames) {
  const allowedLabels = new Set(labelNames);
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
    if (blockStart && allowedLabels.has(blockStart[1])) {
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

function createSequence(block) {
  const parts = new Array(block.chunkCount);
  parts[block.chunkIndex] = block.jsonChunk;

  return {
    chunkCount: block.chunkCount,
    nextChunkIndex: block.chunkIndex + 1,
    parts,
  };
}

function appendBlock(sequence, block) {
  sequence.parts[block.chunkIndex] = block.jsonChunk;
  sequence.nextChunkIndex = block.chunkIndex + 1;
}

function isCompatibleSequence(sequence, block) {
  return (
    sequence.chunkCount === block.chunkCount &&
    block.chunkIndex === sequence.nextChunkIndex &&
    sequence.parts[block.chunkIndex] === undefined
  );
}

function isCompleteSequence(sequence) {
  return Array.from({ length: sequence.chunkCount }, (_, index) => {
    return typeof sequence.parts[index] === "string";
  }).every(Boolean);
}

export function reconstructEntries(blocks) {
  const completed = [];
  const active = [];

  for (const block of blocks) {
    const candidateIndex =
      block.chunkIndex === 0
        ? -1
        : active.findIndex((sequence) => isCompatibleSequence(sequence, block));

    if (candidateIndex === -1) {
      const sequence = createSequence(block);
      if (isCompleteSequence(sequence)) {
        completed.push(sequence.parts.join(""));
      } else {
        active.push(sequence);
      }
      continue;
    }

    const sequence = active[candidateIndex];
    appendBlock(sequence, block);

    if (isCompleteSequence(sequence)) {
      completed.push(sequence.parts.join(""));
      active.splice(candidateIndex, 1);
    }
  }

  return completed;
}

export function parseEntriesByLabel(chunkBlocks) {
  const parsed = new Map();

  for (const [label, blocks] of chunkBlocks.entries()) {
    const entries = reconstructEntries(blocks).map((jsonText) => JSON.parse(jsonText));
    parsed.set(label, entries);
  }

  return parsed;
}
