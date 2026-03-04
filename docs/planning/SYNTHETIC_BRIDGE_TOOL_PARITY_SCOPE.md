# Synthetic Bridge Tool Parity Scope

## Goal
Make Innies synthetic SSE bridge preserve Anthropic structured content (especially `tool_use`) so OpenClaw behavior matches direct Anthropic behavior when upstream returns JSON instead of SSE.

## Problem
Current bridge path (`buildSyntheticAnthropicSse`) flattens response content to a single text delta. This drops non-text blocks (e.g., `tool_use`) and can cause tool orchestration stalls/misbehavior even when HTTP succeeds.

## Non-Goals
- No OpenClaw UX changes.
- No routing policy changes.
- No timeout tuning in this scope.
- No changes to passthrough SSE path.

## Required Invariants
1. `stream=true` success still returns Anthropic-style SSE.
2. If upstream is already SSE: passthrough unchanged.
3. If upstream is JSON: synthetic SSE must preserve all assistant `content[]` blocks and ordering.
4. `tool_use` blocks must survive bridge intact (`id`, `name`, `input`).
5. Existing metering/idempotency behavior remains unchanged.

## Implementation

### 1) Replace text-only synthetic builder
File: `api/src/routes/proxy.ts`

Refactor `buildSyntheticAnthropicSse(data, model)` to:
- Read `message.content` as full block array.
- Emit `message_start` with empty `content` (as today).
- For each block in order:
  - Emit `content_block_start`.
  - For `text` block:
    - emit one or more `content_block_delta` (`text_delta`) chunks, then `content_block_stop`.
  - For non-text block (`tool_use`, `thinking`, etc.):
    - emit full block in `content_block_start.content_block` (no text delta), then `content_block_stop`.
- Emit `message_delta` + `message_stop` as today.

Notes:
- Keep conservative behavior for unknown block types: pass through block object in `content_block_start` untouched, then stop.
- Do not synthesize/drop fields on `tool_use`.

### 2) Keep usage/metering logic as-is
No change to `resolveSyntheticUsageFromPayload` and existing `metering_source` behavior.

### 3) Add bridge-content telemetry
File: `api/src/routes/proxy.ts`

On synthetic bridge path, add lightweight debug fields in `[stream-latency]` log:
- `synthetic_content_block_count`
- `synthetic_content_block_types` (comma-separated unique types)

Purpose: verify tool blocks are present in bridged responses.

## Tests

### Unit/route tests
File: `api/tests/anthropicCompat.route.test.ts`

Add/extend cases:
1. JSON upstream with assistant content:
   - `text` + `tool_use` blocks.
   - Assert bridged SSE contains:
     - `event: content_block_start` for both blocks
     - `tool_use` block payload intact (`type`, `id`, `name`, `input`)
     - proper block ordering.
2. JSON upstream with unknown non-text block type:
   - Assert block is preserved in `content_block_start` and stream still completes.
3. Regression guard:
   - Existing text-only case still works.

### Existing suite requirements
- No regressions in:
  - `tests/proxy.tokenMode.route.test.ts`
  - `tests/anthropicCompat.route.test.ts`

## Acceptance Criteria
1. For synthetic bridge responses containing `tool_use`, OpenClaw can execute tool loop without silent structural stalls attributable to missing tool blocks.
2. No behavior change on passthrough SSE requests.
3. Test suite green.

## Rollout
1. Deploy code behind existing path (no flags needed).
2. Run canary prompts known to trigger tool calls via OpenClaw.
3. Confirm logs show `stream_mode=synthetic_bridge` with `synthetic_content_block_types` including `tool_use` where expected.
4. Compare user-observed stalls before/after on same workflow.

## Risks
- Slightly larger synthetic SSE payload for structured responses.
- If upstream JSON shape is malformed, bridge should fail soft by preserving known fields and still closing SSE cleanly.

## Out of Scope (tracked separately)
- Timeout policy (`UPSTREAM_TIMEOUT_MS`) tuning.
- Credential retry distribution beyond current maxed/quarantine lifecycle.
