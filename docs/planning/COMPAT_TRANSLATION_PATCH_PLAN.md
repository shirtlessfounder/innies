# Compat Translation — Patch Plan

Based on audit findings from `COMPAT_TRANSLATION_AUDIT_FINDINGS.md` + bicep review.

## Must Fix (blocks deploy)

### 1. Complete translated compat error mapping
- Apply `mapOpenAiErrorToAnthropic` for ALL error statuses on translated paths, not just 400/403
- Specifically: 401, 429, 5xx must return Anthropic-shaped error envelopes
- Apply consistently in both non-streaming and streaming paths
- Add regression tests for fallback-exhausted translated error cases
- **Files:** `proxy.ts` (non-streaming ~L1360-1628, streaming ~L1864-2008)
- **Owner:** Agent 2 / Agent 3

### 2. Handle `response.failed` in stream transformer
- Add explicit handler for `response.failed` event
- Emit proper Anthropic terminal event (either error-shaped `message_delta` + `message_stop`, or structured error event)
- Decide on `response.content_part.done` and `response.output_text.done` — document as intentional no-ops if not needed
- Add stream tests for failure/terminal edge cases
- **Files:** `openaiToAnthropicStream.ts` (~L138-158)
- **Owner:** Agent 2

### 3. Enforce `call_id` strictness in tool paths
- Remove all fallbacks to `item.id` or synthetic ID generation in translated paths
- Missing `call_id` = translation error, not silent fallback
- Three locations to fix:
  - Request translation: `anthropicToOpenai.ts` ~L151-154
  - Non-streaming response: `openaiToAnthropic.ts` ~L54-57
  - Streaming response: `openaiToAnthropicStream.ts` ~L193-196
- Add regression tests for missing/invalid `call_id`
- **Owner:** Agent 1 / Agent 2

## Should Fix (quick wins, pre-deploy)

### 5. Mixed tool result serialization
- `serializeToolResultContent()` drops non-text content from mixed arrays
- Fix: if array contains non-text blocks, JSON.stringify the full array instead of extracting only text
- Add regression test for text + structured tool_result arrays
- **File:** `anthropicToOpenai.ts` ~L67-74
- **Owner:** Agent 1

### 6. Preserve prompt text fidelity
- `joinTextParts()` trims every segment and rejoins with `\n\n` — mutates code blocks and whitespace
- Fix: concatenate with single `\n` or preserve original separators
- Add regression test for whitespace-sensitive prompt text
- **File:** `anthropicToOpenai.ts` ~L41-48
- **Owner:** Agent 1

## Housekeeping (post-deploy)

### 8. End-to-end canary
- Add multi-turn tool-use canary (not just single-turn smoke)
- Add translated-path fallback validation case
- **Owner:** Agent 3

### 9. Stale API_CONTRACT.md
- Remove/update `compat_provider_pinned` references
- Update compat mode description to reflect translated preference path
- **Owner:** Agent 3

### 10. Expanded test coverage
- `tool_choice` variants
- Mixed response ordering
- `response.failed` stream event
- Parser-fidelity validation
- **Owner:** Agent 2 / Agent 3

## Cut (not doing)

### ~~4. Multi-part content collapse~~
Doesn't happen in real Codex responses for Phase A use cases.

### ~~7. Silent drop logging for unsupported content~~
Silent drop is actually correct behavior. Models evolve, new content types appear — logging warnings adds noise without value.
