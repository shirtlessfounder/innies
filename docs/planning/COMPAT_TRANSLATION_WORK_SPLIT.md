# Compat Translation — Phase A Work Split

Reference: `docs/planning/COMPAT_PROVIDER_TRANSLATION_SCOPE.md`

Phase A goal: OpenClaw completes multi-turn tool-use conversations through Innies with buyer pref=openai, with automatic fallback to anthropic when the openai pool is exhausted.

## Agent 1 — Request Translation + Compat Pin Removal

**Scope:** Everything between "OpenClaw sends Anthropic request" and "Innies sends request to upstream provider."

### Tasks:
1. **Remove compat provider pin** (`api/src/routes/anthropicCompat.ts`)
   - Keep compat ingress marked as `provider: 'anthropic'` because the wire format is still Anthropic-shaped
   - Apply buyer preference later in proxy routing, not in the compat entrypoint, so the provider plan can still be `openai -> anthropic` for fallback
   
2. **Remove pin in proxy** (`api/src/routes/proxy.ts`)
   - `compatMode` alone no longer sets `pinSelectionReason = 'compat_provider_pinned'`
   - Buyer preference decides whether compat traffic stays native Anthropic or flows into the OpenAI translation path
   - When resolved provider is `openai`, do NOT pin — flow into translation path

3. **Build request translator** (`api/src/utils/anthropicToOpenai.ts`)
   - Top-level fields: `messages` → `input`, `system` → `instructions`, `max_tokens` → `max_output_tokens`, `temperature`, `top_p`, `stop_sequences` → `stop`
   - User messages: `{role: "user", content}` → `{type: "message", role: "user", content}`
   - Assistant messages: text → `{type: "message", role: "assistant", content}`, tool_use → `{type: "function_call", call_id: id, name, arguments}`
   - Tool results: unwrap from user message → `{type: "function_call_output", call_id, output}`
   - Tool schemas: `{name, description, input_schema}` → `{type: "function", function: {name, description, parameters}}`
   - Tool choice: `{type: "auto"}` → `"auto"`, `{type: "any"}` → `"required"`, `{type: "tool", name}` → `{type: "function", function: {name}}`, `{type: "none"}` → `"none"`
   - Model mapping: config-driven, single default Codex model for Phase A
   - Strip `cache_control` blocks silently
   - Thinking: `{type: "enabled", budget_tokens}` → `{reasoning: {effort: "high"}}` (fixed default for Phase A)

4. **Change `proxiedPath`** when translating
   - Compat + openai provider → set `proxiedPath` to `/v1/responses`

### Key rule:
Tool ID mapping: Anthropic `tool_use.id` ↔ OpenAI `function_call.call_id`. Always. OpenAI item-level `id` is never used.

### Tests:
- Unit tests for every content type translation (text, tool_use, tool_result, mixed)
- Unit test for tool schema translation
- Unit test for tool_choice mapping
- Unit test for cache_control stripping
- Integration test: send Anthropic request with buyer pref=openai, verify Codex receives correct OpenAI Responses format

### Deliverable:
- `api/src/utils/anthropicToOpenai.ts` with full test coverage
- Modified `anthropicCompat.ts` and `proxy.ts`

---

## Agent 2 — Response Translation (Non-Streaming + Streaming)

**Scope:** Everything between "upstream provider returns response" and "Innies returns Anthropic-shaped response to OpenClaw."

### Tasks:
1. **Build non-streaming response translator** (`api/src/utils/openaiToAnthropic.ts`)
   - `id` → `id`
   - `output[]` → `content[]`:
     - `output_text` → `{type: "text", text}`
     - `function_call` → `{type: "tool_use", id: call_id, name, input: JSON.parse(arguments)}`
     - `reasoning` → `{type: "thinking", thinking: content}` (content is a string, not array)
   - `usage.input_tokens` → `usage.input_tokens`, `usage.output_tokens` → `usage.output_tokens`
   - `status: "completed"` → `stop_reason: "end_turn"`
   - `status: "incomplete"` + `max_output_tokens` → `stop_reason: "max_tokens"`
   - Flatten OpenAI nesting: `output[].content[]` as `output_text` → flat Anthropic `content[]`
   - Preserve content block ordering: thinking → text → tool_use

2. **Build streaming response translator** (`api/src/utils/openaiToAnthropicStream.ts`)
   - Stateful stream transformer that receives OpenAI SSE events and emits Anthropic SSE events
   - Track current block index and type
   - Event mapping:
     - `response.created` → `message_start`
     - `response.output_item.added` (text) → `content_block_start` (text)
     - `response.output_text.delta` → `content_block_delta` (text_delta)
     - `response.output_item.done` (text) → `content_block_stop`
     - `response.output_item.added` (function_call) → `content_block_start` (tool_use, with `call_id` as `id`)
     - `response.function_call_arguments.delta` → `content_block_delta` (input_json_delta)
     - `response.output_item.done` (function_call) → `content_block_stop`
     - `response.completed` → `message_delta` (stop_reason + usage) + `message_stop`
   - Reference: `buildSyntheticAnthropicSse()` in `proxy.ts` for the Anthropic SSE event structure
   - Output must be valid for OpenClaw's pi-ai Anthropic stream parser

3. **Error mapping**
   - `400` → `400` (invalid_request_error)
   - `401` → `401` (authentication_error) — also triggers fallback
   - `403` → `403` (permission_error)
   - `429` → `429` (rate_limit_error) — also triggers fallback
   - `500+` → `500` (api_error) — also triggers fallback

### Key constraint:
`strictUpstreamPassthrough` must be `false` when compat + openai translation is active. The response needs transformation, not passthrough.

### Tests:
- Unit tests for non-streaming response translation (text, tool_use, mixed, reasoning)
- Unit tests for streaming event mapping (every event type)
- Unit test for content block ordering preservation
- Unit test for error mapping
- Streaming fidelity test: pipe translated stream through Anthropic SDK parser, verify no parse errors

### Deliverable:
- `api/src/utils/openaiToAnthropic.ts` (non-streaming)
- `api/src/utils/openaiToAnthropicStream.ts` (streaming transformer)
- Error mapping utility

---

## Agent 3 — Proxy Integration + Fallback + End-to-End Validation

**Scope:** Wire agents 1 and 2 together in the proxy flow. Ensure fallback works. Validate end-to-end.

### Tasks:
1. **Integrate translation into proxy flow** (`api/src/routes/proxy.ts`)
   - In `executeTokenModeStreaming` / `executeTokenModeNonStreaming`:
     - If `compatMode === true` AND resolved provider is `openai`:
       - Call Agent 1's request translator on payload
       - Set `proxiedPath` to `/v1/responses`
       - Set `strictUpstreamPassthrough = false`
       - For non-streaming: call Agent 2's response translator on result
       - For streaming: pipe through Agent 2's stream transformer
     - If `compatMode === true` AND provider is `anthropic`:
       - Current behavior, no changes

2. **Verify automatic fallback**
   - When openai pool is exhausted (all credentials maxed/revoked):
     - Provider plan falls back to anthropic
     - Request goes through WITHOUT translation (native anthropic path)
     - Fallback is invisible to the buyer
   - When openai pool recovers:
     - Requests return to openai with translation
   - Verify `providerFallbackReasonForError()` triggers correctly for translated path errors

3. **Model mapping config**
   - Add config for default Codex model when translating compat requests
   - Environment variable or config field: `COMPAT_CODEX_DEFAULT_MODEL` (default: `gpt-5.4`)
   - Used by Agent 1's request translator when mapping Anthropic model → OpenAI model

4. **End-to-end validation**
   - Single-turn text: Anthropic request → translated → Codex → translated back → valid Anthropic response
   - Multi-turn tool use: request with tool_use history → translated → Codex tool call → translated back → OpenClaw sends tool_result → next turn works
   - Streaming: full streaming conversation through translated path, verify OpenClaw receives valid SSE
   - Fallback: exhaust openai pool mid-conversation, verify seamless switch to anthropic
   - Error handling: Codex returns 429 → fallback triggers → anthropic serves the request

5. **Metering verification**
   - Token counts in `in_usage_ledger` reflect actual upstream usage (from Codex), not translated response
   - Routing events in `in_routing_events` include translation metadata (translated=true, original_provider, effective_provider)

### Tests:
- Integration tests for proxy flow with translation enabled
- Fallback scenario tests (pool exhaustion, recovery)
- End-to-end canary script that runs a multi-turn tool-use conversation
- Metering correctness checks

### Deliverable:
- Modified `proxy.ts` with translation integration
- Config for default model mapping
- End-to-end test suite
- Canary validation script

---

## Execution Order

1. **Agent 1 and Agent 2 work in parallel** — no dependencies between request and response translation
2. **Agent 3 starts integration** once Agent 1 has the request translator and Agent 2 has at least non-streaming response translation
3. **Agent 3 runs end-to-end validation** once all three are integrated
4. **Streaming can be integrated last** — get non-streaming working first for fast validation

## Exit Criteria (Phase A)

- [ ] OpenClaw completes a multi-turn tool-use conversation through Innies with buyer pref=openai
- [ ] Automatic fallback to anthropic works when openai pool is exhausted
- [ ] No OpenClaw-side errors from translated Anthropic SSE stream
- [ ] Metering captures correct token counts from actual upstream
- [ ] All unit + integration tests pass
