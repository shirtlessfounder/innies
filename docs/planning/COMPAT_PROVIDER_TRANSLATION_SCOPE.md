# Compat Provider Translation Scope

## Problem

OpenClaw sends Anthropic-shaped requests to Innies via `POST /v1/messages` (compat mode).
Today, compat mode hardcodes `provider: 'anthropic'` and sets `compat_provider_pinned`, so buyer provider preference is ignored.

The goal: when a buyer's preference is set to `openai`/`codex`, compat-mode requests should be translated to OpenAI Responses format, routed to Codex, and the response translated back to Anthropic format before returning to OpenClaw.

This makes OpenClaw provider-agnostic through Innies, without any OpenClaw changes.

## OpenClaw Audit Findings (Critical Context)

**OpenClaw natively supports both Anthropic and OpenAI/Codex providers.** This means there is an alternative path that avoids the translation layer entirely.

### What OpenClaw supports today:
- **API types:** `anthropic-messages`, `openai-responses`, `openai-codex-responses`, `openai-completions`
- **Providers:** `anthropic`, `openai`, `openai-codex`, `openrouter`, `google-gemini-cli`, `opencode`, and more
- **Custom providers:** `models.json` supports `baseUrl`, `apiKey`, `api` fields per provider
- **Provider-specific wrappers:** `createCodexDefaultTransportWrapper()`, `createOpenAIDefaultTransportWrapper()` applied automatically based on provider type
- **Streaming:** WebSocket transport for OpenAI (with warmup), SSE for Anthropic
- **Internal event model:** OpenClaw uses an internal event model (`message_start`, `message_update`, `message_end`, `tool_execution_start/update/end`) that abstracts over both Anthropic SSE and OpenAI Responses streaming — the translation already exists inside OpenClaw

### What this means for Innies:
OpenClaw already knows how to speak both Anthropic and OpenAI formats natively. It translates between its internal event model and each provider's wire format.

**Alternative path (no translation layer, client-side switching):**
A buyer could configure two provider entries in their OpenClaw `models.json` using OpenClaw's native provider IDs:

```json
{
  "providers": {
    "openai-codex": {
      "baseUrl": "https://api.innies.computer",
      "apiKey": "in_live_...",
      "api": "openai-codex-responses",
      "models": [{ "id": "gpt-5.4", "api": "openai-codex-responses" }]
    },
    "anthropic": {
      "baseUrl": "https://api.innies.computer",
      "apiKey": "in_live_...",
      "api": "anthropic-messages",
      "models": [{ "id": "claude-opus-4-6", "api": "anthropic-messages" }]
    }
  }
}
```

**Note:** Provider IDs must be `openai-codex` or `openai` (not custom aliases like `innies-codex`) to preserve OpenClaw's native transport defaults, WebSocket warmup, and transcript shaping per provider. (See OpenClaw `extra-params.ts:317`, `attempt.ts:1157`.)

This path gives higher fidelity (OpenClaw shapes transcripts correctly per provider) but breaks the target UX:

**Why this path is rejected:**
The target UX is: buyer gets one API key, admin sets their preference, and it just works. The buyer's OpenClaw config is set once and never touched again. If we require client-side provider switching, every buyer has to reconfigure their OpenClaw to change providers, and there's no automatic fallback when one provider's token pool is exhausted.

### Recommendation:
**Build the translation layer in Innies.** The buyer configures OpenClaw once with `api: "anthropic-messages"` pointing at Innies. Innies handles provider selection, translation, and fallback server-side. The buyer never thinks about it again.

### Accepted tradeoff — transcript shaping gap:
OpenClaw shapes conversation history differently per provider before sending (tool ID sanitization, reasoning block handling, function-call downgrades — see OpenClaw `transcript-policy.ts:34`, `attempt.ts:1215`, `attempt.ts:1240`). With server-side translation, Codex receives an Anthropic-shaped transcript that OpenClaw would NOT have sent natively to Codex.

This is an accepted tradeoff. The models are capable enough to handle Anthropic-formatted message history. The result is "Codex execution with Anthropic-shaped prompts" — functional but not identical to native Codex behavior. For the target UX (transparent provider switching + automatic fallback), this is the right compromise.

### OpenClaw-specific risks for the translation layer:

**Verified risks (repo-backed):**
1. **Streaming fidelity:** OpenClaw's Anthropic SSE parser uses the official `@anthropic-ai/sdk` (bundled). Translated SSE events must be valid for this SDK to parse without errors.
2. **Content block ordering:** OpenClaw relies on Anthropic's block ordering (thinking → text → tool_use). Translated responses must preserve this ordering.
3. **Beta headers:** OpenClaw sends `anthropic-beta: fine-grained-tool-streaming-2025-05-14, interleaved-thinking-2025-05-14`. The compat endpoint already handles these, but translated responses must match what these betas enable.

**Validation needed (may be risks, evidence inconclusive):**
4. **Tool call IDs:** OpenClaw has tool ID sanitization logic (`tool-call-id.ts:15`, `tool-call-id.ts:216`), but this is primarily a Copilot-Claude workaround, not general Anthropic behavior. Need to verify if translated OpenAI tool IDs (`call_xxx`) cause issues in the Anthropic SDK path.
5. **Thinking blocks:** OpenClaw has thinking block filtering (`transcript-policy.ts:99`) and tag scanning (`pi-embedded-subscribe.ts:24`), but these are generic output filters, not Anthropic-specific constraints. Need to verify translated reasoning content format requirements.
6. **Cache control:** OpenClaw's `cache_control` usage appears limited to an OpenRouter-Anthropic wrapper (`extra-params.ts:468`), not broad Anthropic behavior. Innies should still strip `cache_control` blocks during translation (no OpenAI equivalent), but this is lower risk than initially stated.
7. **Transcript shaping delta:** The biggest semantic risk. OpenClaw applies different transcript policies per provider (`transcript-policy.ts:34`, `transcript-policy.ts:78`). Compat-mode requests arrive with Anthropic transcript shaping applied. Codex models must handle this gracefully. See "Accepted tradeoff" above.

## Architecture

```
OpenClaw → POST /v1/messages (Anthropic format)
  → Innies compat endpoint
    → check buyer preference
    → if anthropic: route as-is (current behavior)
    → if openai/codex:
        → translate request: Anthropic Messages → OpenAI Responses
        → route to Codex upstream
        → translate response: OpenAI Responses → Anthropic Messages
        → return to OpenClaw
```

## Changes Required

### 1. Remove compat provider pin (small)

**File:** `api/src/routes/anthropicCompat.ts`

Current behavior: always sets `provider: 'anthropic'` in request body.
New behavior: set `provider` based on buyer preference (fall back to `anthropic` if no preference).

**File:** `api/src/routes/proxy.ts`

Current behavior: `compatMode` → `pinSelectionReason = 'compat_provider_pinned'`
New behavior: `compatMode` alone no longer pins. Only pin if the resolved provider matches the request format (i.e., anthropic request → anthropic provider = no translation needed = can still pin).

### 2. Request translation: Anthropic → OpenAI (medium)

New module: `api/src/utils/anthropicToOpenai.ts`

Translates an Anthropic Messages request into an OpenAI Responses request.

#### Message format

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `messages[{role, content}]` | `input` (string or array of input items) |
| `system` (string or array) | `instructions` (string) |
| `max_tokens` / `max_output_tokens` | `max_output_tokens` |
| `model` | `model` (needs mapping table) |
| `stream: true` | `stream: true` |
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `stop_sequences` | `stop` (array) |
| `metadata.user_id` | `user` |

#### Message content translation

Anthropic messages → OpenAI input items. The key difference: Anthropic uses a flat `messages[]` array with `role` per message. OpenAI Responses uses an `input` array of typed items where conversation history is represented differently.

**User messages:**

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `{role: "user", content: "text"}` | `{type: "message", role: "user", content: "text"}` |
| `{role: "user", content: [{type: "text", text}]}` | `{type: "message", role: "user", content: "text"}` |
| `{role: "user", content: [{type: "image", source: {type: "base64", media_type, data}}]}` | `{type: "message", role: "user", content: [{type: "input_image", image_url: "data:{media_type};base64,{data}"}]}` |

**Assistant messages (conversation history):**

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `{role: "assistant", content: [{type: "text", text}]}` | `{type: "message", role: "assistant", content: "text"}` |
| `{role: "assistant", content: [{type: "tool_use", id, name, input}]}` | `{type: "function_call", id, name, arguments: JSON.stringify(input)}` |

**Tool results:**

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `{role: "user", content: [{type: "tool_result", tool_use_id, content}]}` | `{type: "function_call_output", call_id: tool_use_id, output: stringify(content)}` |

**Important:** Anthropic packs tool_result inside a user message. OpenAI has it as a top-level input item. The translator must unwrap these.

#### Tool schema translation

| Anthropic | OpenAI |
|-----------|--------|
| `tools[{name, description, input_schema}]` | `tools[{type: "function", name, description, parameters: input_schema}]` |
| `tool_choice: {type: "auto"}` | `tool_choice: "auto"` |
| `tool_choice: {type: "any"}` | `tool_choice: "required"` |
| `tool_choice: {type: "tool", name}` | `tool_choice: {type: "function", name}` |
| `tool_choice: {type: "none"}` | `tool_choice: "none"` |

#### Thinking / extended thinking

| Anthropic | OpenAI |
|-----------|--------|
| `thinking: {type: "enabled", budget_tokens}` | `reasoning: {effort: "high"}` (or map budget ranges to low/medium/high) |
| thinking content blocks in response | `reasoning` content in response |

Budget mapping suggestion:
- `budget_tokens < 4096` → `effort: "low"`
- `budget_tokens < 16384` → `effort: "medium"`  
- `budget_tokens >= 16384` → `effort: "high"`

#### Model mapping

Needs a config-driven mapping table. Starting point:

| Anthropic model (from OpenClaw) | OpenAI/Codex model |
|-------------------------------|-------------------|
| `claude-opus-4-6` | config default (e.g. `gpt-5.4`) |
| `claude-sonnet-4-6` | config default |
| `*` (any) | config default |

Phase 1: single default Codex model for all requests. Model mapping refinement is Phase 2.

### 3. Response translation: OpenAI → Anthropic (medium)

#### Non-streaming

OpenAI Responses response → Anthropic Messages response:

| OpenAI field | Anthropic field |
|-------------|----------------|
| `id` | `id` |
| `output[]` | `content[]` (translate each item) |
| `usage.input_tokens` | `usage.input_tokens` |
| `usage.output_tokens` | `usage.output_tokens` |
| `status: "completed"` | `stop_reason: "end_turn"` |
| `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"` | `stop_reason: "max_tokens"` |

Output item translation:

| OpenAI output item | Anthropic content block |
|-------------------|----------------------|
| `{type: "output_text", text}` (inside message output) | `{type: "text", text}` |
| `{type: "function_call", id, name, arguments}` | `{type: "tool_use", id, name, input: JSON.parse(arguments)}` |
| `{type: "reasoning", content: [{type: "text", text}]}` | `{type: "thinking", thinking: text}` |

**Note:** OpenAI nests text inside `output[].content[]` as `output_text` items. Anthropic has flat `content[]` blocks. The translator needs to flatten the nesting.

#### Streaming

This is the hardest part. OpenAI Responses streaming events → Anthropic SSE events.

OpenAI streams `response.created`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.function_call_arguments.delta`, `response.output_item.done`, `response.completed`.

These need to map to Anthropic's `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

**Approach:** Build a stateful stream transformer that:
1. Receives OpenAI SSE events
2. Tracks current block index and type
3. Emits corresponding Anthropic SSE events
4. Handles the event ordering differences

Key mapping:

| OpenAI event | Anthropic event(s) |
|-------------|-------------------|
| `response.created` | `message_start` |
| `response.output_item.added` (text) | `content_block_start` (text) |
| `response.output_text.delta` | `content_block_delta` (text_delta) |
| `response.output_item.done` (text) | `content_block_stop` |
| `response.output_item.added` (function_call) | `content_block_start` (tool_use) |
| `response.function_call_arguments.delta` | `content_block_delta` (input_json_delta) |
| `response.output_item.done` (function_call) | `content_block_stop` |
| `response.completed` | `message_delta` + `message_stop` |

**Note:** The existing `buildSyntheticAnthropicSse()` in `proxy.ts` already demonstrates this pattern for non-streaming→streaming conversion. The streaming translator is the same idea but event-by-event instead of batch.

### 4. Error mapping (small)

OpenAI error responses need to map to Anthropic-shaped errors for OpenClaw:

| OpenAI | Anthropic |
|--------|-----------|
| `400` | `400` (invalid_request_error) |
| `401` | `401` (authentication_error) |
| `403` | `403` (permission_error) |
| `429` | `429` (rate_limit_error) — also triggers fallback |
| `500+` | `500` (api_error) — also triggers fallback |

### 5. Integration into proxy flow (medium)

**File:** `api/src/routes/proxy.ts`

In the token-mode execution path, after provider selection resolves to `openai`:
1. If `compatMode` is true and provider is `openai`:
   - Transform request payload via `anthropicToOpenai()`
   - Change `proxiedPath` to `/v1/responses`
   - For non-streaming: execute, then transform response via `openaiToAnthropic()`, return Anthropic-shaped JSON
   - For streaming: execute, pipe through `OpenAiToAnthropicStreamTransformer`, return Anthropic-shaped SSE
   - Return to caller — OpenClaw sees standard Anthropic response
2. If `compatMode` is true and provider is `anthropic`:
   - Current behavior, no changes

**Integration point:** This hooks into `executeTokenModeStreaming` / `executeTokenModeNonStreaming`. The tricky part is that `strictUpstreamPassthrough` is currently set to `true` for compat mode (meaning the response is passed through as-is). For translated requests, this must be `false` — the response needs transformation, not passthrough.

**Existing precedent:** `normalizeTokenModeUpstreamPayload()` already modifies payloads per-provider before sending upstream. The request translation follows this same pattern. The response translation is new — there's no existing precedent for transforming responses in the return path.

## What does NOT need to change

- OpenClaw — sends Anthropic format, receives Anthropic format, no changes needed
- Buyer key preference system — already works, just unblocked by removing pin
- Token credential lifecycle — Codex tokens already supported
- `/v1/proxy/*` path — unaffected, continues to work as-is
- CLI wrappers — unaffected, they'll use `/v1/proxy/*` directly

## Scope estimate

| Component | Size | Risk |
|-----------|------|------|
| Remove compat pin | S | Low — straightforward conditional |
| Request translator | M | Medium — many content types to handle |
| Response translator (non-streaming) | M | Medium — inverse of request translator |
| Response translator (streaming) | L | High — stateful event stream transformation, edge cases |
| Error mapping | S | Low |
| Proxy integration | S | Low — wrapper around existing flow |
| Tests | L | Medium — need parity tests for all content types |

**Total:** ~2-3 weeks of focused work (with agent parallelism, potentially faster)

**Critical path:** Streaming response translation (Section 3 streaming). Everything else can proceed in parallel, but this is the hardest piece and the one most likely to surface edge cases.

## Edge cases to handle

1. **Thinking blocks** — Anthropic thinking ↔ OpenAI reasoning. Format differences in how thinking content is structured.
2. **Multi-turn tool use** — tool_use → tool_result chains need correct ID mapping across the translation boundary.
3. **Image content** — base64 encoding format differences.
4. **Streaming backpressure** — OpenAI and Anthropic stream at different rates. Transformer must handle buffering.
5. **Partial JSON in tool calls** — Anthropic sends `input_json_delta` with partial JSON. OpenAI sends `function_call_arguments.delta`. Both are incremental but chunking may differ.
6. **Stop reasons** — mapping between OpenAI's `status`/`incomplete_details` and Anthropic's `stop_reason` values.
7. **Usage tracking** — ensure metering captures correct token counts from the actual upstream (OpenAI), not the translated response.
8. **Model capabilities mismatch** — some Anthropic features may not have OpenAI equivalents (e.g., `stop_sequences`, specific `metadata` fields). These should be silently dropped with a log warning, not error.
9. **Extended thinking budget** — Anthropic allows precise `budget_tokens`. OpenAI only has `effort` levels. Lossy translation.

## Validation plan

1. Unit tests for each translation function (request, response, streaming events)
2. Integration tests: send Anthropic-shaped request with buyer pref=openai, verify Codex receives correct format
3. Round-trip parity tests: same prompt through anthropic path vs translated codex path, compare response structure
4. OpenClaw canary: point a test OpenClaw instance at innies with codex preference, run tool-use loops
5. Streaming fidelity: verify OpenClaw receives valid Anthropic SSE stream from translated Codex responses

## Phasing suggestion

**Phase A (unblock basic text):**
- Remove compat pin
- Request/response translation for text-only messages (no tools, no thinking)
- Non-streaming first, then streaming

**Phase B (tool parity):**
- Tool schema translation
- tool_use/tool_result round-trip
- Streaming tool call events

**Phase C (full parity):**
- Thinking/reasoning translation
- Image content
- Edge cases + hardening
- Full canary validation with OpenClaw

This lets you validate the architecture with Phase A before committing to the full translation surface.
