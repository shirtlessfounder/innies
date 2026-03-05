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

**Alternative path (no translation layer needed):**
Instead of building Anthropic↔OpenAI translation in Innies, a buyer could configure two provider entries in their OpenClaw `models.json`:

```json
{
  "providers": {
    "innies-claude": {
      "baseUrl": "https://api.innies.computer",
      "apiKey": "in_live_...",
      "api": "anthropic-messages",
      "models": [{ "id": "claude-opus-4-6", "api": "anthropic-messages" }]
    },
    "innies-codex": {
      "baseUrl": "https://api.innies.computer",
      "apiKey": "in_live_...",
      "api": "openai-responses",
      "models": [{ "id": "gpt-5.4", "api": "openai-responses" }]
    }
  }
}
```

OpenClaw would send the correct format for each provider, and Innies would receive OpenAI-shaped requests on `/v1/proxy/*` (not `/v1/messages`).

**However, this approach has a UX problem:** the buyer must manually switch models (`/model innies-codex/gpt-5.4`) to change providers. Buyer preference in Innies becomes meaningless because the format decision is made client-side.

### Recommendation:
**Build the translation layer in Innies.** The alternative path works technically but defeats the purpose of buyer preference (transparent provider switching). The translation layer lets the buyer set preference once, and all their traffic — regardless of which client or format — honors it.

### OpenClaw-specific risks for the translation layer:
1. **Streaming fidelity:** OpenClaw's Anthropic SSE parser uses the official `@anthropic-ai/sdk` (bundled). The translated SSE events must be valid enough for the SDK to parse without errors.
2. **Tool call IDs:** OpenClaw sanitizes tool call IDs for certain providers (`sanitizeToolCallIdsForCloudCodeAssist`). Translated tool IDs from OpenAI (`call_xxx`) must survive this sanitization.
3. **Thinking blocks:** OpenClaw has explicit thinking block handling (`dropThinkingBlocks`, `THINKING_TAG_SCAN_RE`). Translated reasoning content must match Anthropic's thinking block format exactly.
4. **Beta headers:** OpenClaw sends `anthropic-beta: fine-grained-tool-streaming-2025-05-14, interleaved-thinking-2025-05-14`. The compat endpoint already handles these, but translated responses must match what these betas enable.
5. **Cache control:** OpenClaw uses Anthropic prompt caching (`cache_control` blocks in system prompts). These have no OpenAI equivalent and should be silently stripped during translation.
6. **Content block ordering:** OpenClaw relies on Anthropic's block ordering (thinking → text → tool_use). Translated responses must preserve this ordering.

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

Anthropic content blocks → OpenAI input items:

| Anthropic block | OpenAI input item |
|----------------|------------------|
| `{type: "text", text}` | `{type: "message", role, content: [{type: "output_text", text}]}` |
| `{type: "image", source: {type: "base64", media_type, data}}` | `{type: "message", role, content: [{type: "input_image", image_url: "data:{media_type};base64,{data}"}]}` |
| `{type: "tool_use", id, name, input}` | `{type: "function_call", id, name, arguments: JSON.stringify(input)}` |
| `{type: "tool_result", tool_use_id, content}` | `{type: "function_call_output", call_id: tool_use_id, output: stringify(content)}` |

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
| `{type: "message", content: [{type: "output_text", text}]}` | `{type: "text", text}` |
| `{type: "function_call", id, name, arguments}` | `{type: "tool_use", id, name, input: JSON.parse(arguments)}` |
| `{type: "reasoning", content}` | `{type: "thinking", thinking: content}` |

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

### 5. Integration into proxy flow (small)

**File:** `api/src/routes/proxy.ts`

In the token-mode execution path, after provider selection resolves to `openai`:
1. If `compatMode` is true and provider is `openai`:
   - Transform request payload via `anthropicToOpenai()`
   - Change `proxiedPath` to `/v1/responses`
   - Execute against Codex upstream
   - Transform response back via `openaiToAnthropic()`
   - Return Anthropic-shaped response to caller
2. If `compatMode` is true and provider is `anthropic`:
   - Current behavior, no changes

This should slot into the existing `executeTokenModeStreaming` / `executeTokenModeNonStreaming` calls, wrapping the payload before and response after.

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

**Total:** ~2-3 weeks of focused work

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
