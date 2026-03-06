# Compat Translation — Patch Plan

Based on audit findings from `COMPAT_TRANSLATION_AUDIT_FINDINGS.md` + bicep review.

**Status:** Findings 1-3 and 5-6 are already patched in commit `aa9b2a8`. Remaining work is test coverage and docs.

---

## Agent 1 — Test coverage for request translation fixes

All code changes are done. Agent 1 writes tests to lock them in.

### Tasks:
1. **Test: `call_id` strictness on request translation**
   - Test that `tool_result` with missing `tool_use_id` is skipped (not translated with fallback ID)
   - Test that `tool_use` with missing `id` is skipped (not translated with synthetic ID)
   - **File:** `api/tests/anthropicToOpenai.test.ts`

2. **Test: mixed tool result serialization**
   - Test that `tool_result` with `[{type: "text", text: "foo"}, {type: "json", data: {...}}]` serializes as full JSON array, not just "foo"
   - Test that pure-text arrays still join naturally
   - **File:** `api/tests/anthropicToOpenai.test.ts`

3. **Test: text fidelity preservation**
   - Test that whitespace, code blocks, and multi-line text survive translation without trimming or `\n\n` mutation
   - Test that system instructions with leading/trailing whitespace are preserved
   - **File:** `api/tests/anthropicToOpenai.test.ts`

---

## Agent 2 — Test coverage for response translation fixes

All code changes are done. Agent 2 writes tests to lock them in.

### Tasks:
1. **Test: `call_id` strictness on non-streaming response**
   - Test that `function_call` output item with missing `call_id` is skipped (returns empty array, not synthetic ID)
   - **File:** `api/tests/openaiToAnthropic.test.ts`

2. **Test: `response.failed` streaming handler**
   - Test that `response.failed` event emits: text block with error message → `content_block_stop` → `message_delta` → `message_stop`
   - Test that stream terminates cleanly (no hanging)
   - **File:** `api/tests/openaiToAnthropicStream.test.ts`

3. **Test: `content_part.done` and `output_text.done` are no-ops**
   - Test that these events don't break the stream or emit unexpected Anthropic events
   - **File:** `api/tests/openaiToAnthropicStream.test.ts`

4. **Test: `call_id` strictness on streaming response**
   - Test that `function_call` stream item with missing `call_id` uses `call_unknown_N` fallback (not `item.id`)
   - **File:** `api/tests/openaiToAnthropicStream.test.ts`

---

## Agent 3 — Integration tests, canary, and docs

### Tasks:
1. **Test: error mapping for 401, 429, 5xx on translated paths**
   - Test non-streaming: send request with buyer pref=openai, upstream returns 401 → response is Anthropic-shaped `authentication_error`
   - Test non-streaming: upstream returns 429 → Anthropic-shaped `rate_limit_error`
   - Test non-streaming: upstream returns 502 → Anthropic-shaped `api_error` with status 500
   - Same three tests for streaming path (non-SSE error responses on translated lanes)
   - **File:** `api/tests/anthropicCompat.route.test.ts` or `api/tests/proxy.tokenMode.route.test.ts`

2. **Multi-turn tool-use canary**
   - Write a canary script that sends: user message → gets tool_use back → sends tool_result → gets final text
   - Run through translated path (buyer pref=openai)
   - Verify `call_id` continuity across the round-trip
   - **File:** `api/scripts/` (new canary script)

3. **Fallback canary**
   - Simulate openai pool exhaustion → verify request falls back to anthropic without translation
   - Verify no error surfaces to the client
   - **File:** `api/scripts/` (extend canary or new script)

4. **Update stale docs**
   - `docs/API_CONTRACT.md`: remove `compat_provider_pinned` as current behavior, update compat mode description
   - `docs/planning/PREFERENCE_ROUTING_VALIDATION.md`: update if it references old pinning behavior
   - **Files:** `docs/API_CONTRACT.md`, `docs/planning/PREFERENCE_ROUTING_VALIDATION.md`

---

## Cut (not doing)

### ~~4. Multi-part content collapse~~
Doesn't happen in real Codex responses for Phase A use cases.

### ~~7. Silent drop logging for unsupported content~~
Silent drop is actually correct behavior. Models evolve, new content types appear — logging warnings adds noise without value.
