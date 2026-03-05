# Compat Provider Translation Scope

## Product Contract

**Innies presents an Anthropic-compatible interface to all clients, regardless of upstream provider.**

The buyer experience:
1. Buyer gets one API key
2. Admin sets their provider preference (anthropic or openai/codex)
3. Buyer configures their client (e.g. OpenClaw) once with `api: "anthropic-messages"` pointing at Innies
4. Innies routes to the preferred provider, translating request/response formats as needed
5. If the preferred provider's token pool is exhausted, Innies falls back to the other provider automatically and invisibly
6. Buyer never changes their client config. Buyer never thinks about provider switching.

**Codex execution under compat mode is not native Codex client behavior — it is translated execution.** This is an intentional product boundary. Innies is the compatibility and routing layer. The client is a stable Anthropic-shaped sender.

## Problem

OpenClaw (and any Anthropic-compatible client) sends requests to Innies via `POST /v1/messages` (compat mode).
Today, compat mode hardcodes `provider: 'anthropic'` and sets `compat_provider_pinned`, so buyer provider preference is ignored.

The goal: honor buyer preference by translating between Anthropic Messages and OpenAI Responses formats at the Innies layer, with automatic fallback when a provider's pool is exhausted.

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

**Why this path is rejected (UX and control-plane reasons, not technical necessity):**

OpenClaw CAN do native provider failover — it supports model fallback chains and auth profile rotation. The client-side path is technically viable.

It is rejected because it leaks provider control to the client:
- Buyer must configure both providers in their OpenClaw `models.json` and set up fallback chains correctly
- Fallback order is baked into client config, not controlled by Innies admin
- Admin cannot change a buyer's provider routing without touching the buyer's client config
- Token pool exhaustion in Innies is invisible to OpenClaw — OpenClaw sees errors and triggers its own fallback, which may not align with Innies' pool state or admin intent

The translation layer makes Innies server-authoritative for cross-provider routing. The admin sets preference, Innies handles pool-aware fallback, and the buyer's client config is a static one-time setup.

**Direct `openai-responses` integration via OpenClaw is an intentional non-goal for this scope.** This scope is specifically about preserving the `POST /v1/messages` compat integration as the single client-facing contract while enabling server-side provider switching behind it.

### Recommendation:
**Build the translation layer in Innies.** The buyer configures OpenClaw once with `api: "anthropic-messages"` pointing at Innies. Innies handles provider selection, translation, and fallback server-side. The buyer never thinks about it again.

### Intentional contract — transcript shaping boundary:
OpenClaw shapes conversation history differently per provider before sending (tool ID sanitization, reasoning block handling, function-call downgrades — see OpenClaw `transcript-policy.ts:34`, `attempt.ts:1215`, `attempt.ts:1240`). With server-side translation, Codex receives an Anthropic-shaped transcript that OpenClaw would NOT have sent natively to Codex.

**This is not a gap — it is the product boundary.** Innies does not promise native Codex client behavior. It promises Codex execution behind an Anthropic-compatible facade. The parity bar is:
- OpenClaw must continue to function correctly through Anthropic-shaped request/response semantics
- Buyer preference must determine upstream provider
- Fallback must be automatic and invisible to the buyer

The parity bar is NOT: "behave identically to OpenClaw natively configured with `openai-codex` provider." That is a different product (client-side switching) which is explicitly rejected for UX reasons.

### Risks scoped to the parity bar:

The parity bar (restated): OpenClaw functions correctly through Anthropic-shaped semantics, regardless of which upstream provider Innies selects. These risks are scoped to that bar — not to native Codex behavior parity.

**Verified risks (repo-backed):**
1. **Streaming fidelity:** OpenClaw's Anthropic streaming uses pi-ai as the transport layer, which constructs `${baseUrl}/v1/messages` requests and parses the returned SSE stream (see `model-compat.ts:27-44`). Translated SSE events must be valid for OpenClaw/pi-ai's Anthropic stream parser. This is the hardest technical constraint.
2. **Content block ordering:** OpenClaw relies on Anthropic's block ordering (thinking → text → tool_use). Translated responses must preserve this ordering.
3. **Beta headers:** OpenClaw sends `anthropic-beta: fine-grained-tool-streaming-2025-05-14, interleaved-thinking-2025-05-14`. The compat endpoint already handles these, but translated responses must be consistent with what these betas enable.

**Validation needed (may be risks, evidence inconclusive):**
4. **Tool call IDs:** OpenClaw's strict tool-ID sanitization (`sanitizeToolCallIdsForCloudCodeAssist`) applies to `openai-completions` path, not `openai-responses` or `openai-codex-responses` (see `transcript-policy.ts:88-133`). The more relevant risk for this scope is whether translated-back Anthropic responses with OpenAI-originated tool IDs (`call_xxx` format) pass OpenClaw's Anthropic turn validation/pairing. Need to verify.
5. **Thinking blocks:** OpenClaw has thinking block filtering (`transcript-policy.ts:99`) and tag scanning (`pi-embedded-subscribe.ts:24`), generic output filters. Need to verify translated reasoning content format requirements.
6. **Cache control:** OpenClaw's `cache_control` block injection is scoped to the OpenRouter-Anthropic path (`extra-params.ts:468-509`), not general Anthropic behavior. Direct Anthropic uses `cacheRetention` semantics, not prompt-block rewriting (see `prompt-caching.md:89-105`). Innies should still strip any `cache_control` blocks during translation (no OpenAI equivalent), but this is an edge case, not a primary concern.

**Not a risk (intentional boundary):**
7. **Transcript shaping delta:** Codex receives Anthropic-shaped transcripts. This is the product contract, not a gap. See "Intentional contract" above.

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
| `{role: "user", content: [{type: "image", source: {type: "base64", media_type, data}}]}` | `{type: "message", role: "user", content: [{type: "input_image", source: {type: "base64", media_type, data}}]}` |

**Note:** OpenAI Responses `input_image` uses `source: {type: "url" | "base64", ...}`, NOT `image_url` string format. (Ref: `open-responses.schema.ts:30`, `open-responses.schema.ts:43`)

**Assistant messages (conversation history):**

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `{role: "assistant", content: [{type: "text", text}]}` | `{type: "message", role: "assistant", content: "text"}` |
| `{role: "assistant", content: [{type: "tool_use", id, name, input}]}` | `{type: "function_call", call_id: id, name, arguments: JSON.stringify(input)}` |

**Tool results:**

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `{role: "user", content: [{type: "tool_result", tool_use_id, content}]}` | `{type: "function_call_output", call_id: tool_use_id, output: stringify(content)}` |

**Important:**
- Anthropic packs `tool_result` inside a user message. OpenAI has it as a top-level input item. The translator must unwrap these.
- OpenAI Responses uses `call_id` (not `id`) as the continuation key for function calls. (Ref: `open-responses.schema.ts:96`, `open-responses.schema.ts:106`)

#### Tool call ID continuity (critical for multi-turn)

Tool call IDs must survive the full round-trip: request translation → Codex execution → response translation → back to OpenClaw → next turn request.

The flow:
1. OpenClaw sends Anthropic history with tool IDs like `toolu_01XYZ`
2. Innies translates to OpenAI format: `toolu_01XYZ` → `call_id: "toolu_01XYZ"`
3. Codex responds with its own tool call IDs (e.g. `call_abc123`)
4. Innies translates response back: `call_abc123` → Anthropic `tool_use.id: "call_abc123"`
5. OpenClaw receives this, executes the tool, sends back `tool_result.tool_use_id: "call_abc123"`
6. Next turn: Innies must translate `call_abc123` back to `call_id: "call_abc123"` for Codex

**Key constraint:** On Anthropic lanes, OpenClaw may sanitize tool call IDs between turns (`transcript-policy.ts:97`, `run/attempt.ts:1080`). The translation layer must handle the possibility that IDs are rewritten by the client between rounds.

**Strategy:** The translator should NOT maintain a session-scoped ID remap table. Instead, pass IDs through as-is in both directions. Anthropic-format IDs (`toolu_xxx`) and OpenAI-format IDs (`call_xxx`) are both opaque strings — Codex and OpenClaw both accept arbitrary string IDs. If OpenClaw sanitizes an ID, the sanitized version flows through the next turn, which is correct behavior.

**Risk:** If OpenClaw's Anthropic-lane sanitization produces IDs that Codex rejects, we need a remap. Validate in Phase A testing before adding complexity.

#### Tool schema translation

Note: OpenAI Responses uses a nested `function` object inside the tool definition, not flat fields.

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `tools[{name, description, input_schema}]` | `tools[{type: "function", function: {name, description, parameters: input_schema}}]` |
| `tool_choice: {type: "auto"}` | `tool_choice: "auto"` |
| `tool_choice: {type: "any"}` | `tool_choice: "required"` |
| `tool_choice: {type: "tool", name}` | `tool_choice: {type: "function", function: {name}}` |
| `tool_choice: {type: "none"}` | `tool_choice: "none"` |

(Refs: `open-responses.schema.ts:144`, `open-responses.schema.ts:164`)

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

## Phasing

### Phase A — Minimum viable translation (unblocks OpenClaw on Codex)

**In scope:**
- Remove compat provider pin
- Request translation: text messages + tool schemas + tool_use/tool_result
- Response translation (non-streaming): text + tool_use blocks
- Response translation (streaming): text deltas + tool call deltas → Anthropic SSE
- Error mapping
- Automatic fallback when preferred provider pool is exhausted

**Explicitly out of scope for Phase A:**
- Prompt caching parity (`cache_control` blocks — strip silently)
- Perfect reasoning/thinking translation (map `budget_tokens` → `effort: "high"` as fixed default)
- Exact native Codex transport behavior (WebSocket, warmup — not relevant for server-side translation)
- Model-specific optimization (single default Codex model for all requests)
- Image content translation

**Exit criteria:**
- OpenClaw completes a multi-turn tool-use conversation through Innies with buyer pref=codex
- Automatic fallback to anthropic works when codex pool is exhausted
- No OpenClaw-side errors from translated Anthropic SSE stream

### Phase B — Full content type coverage

- Image content (base64 format translation)
- Thinking/reasoning translation (budget → effort mapping with granularity)
- Streaming edge cases + hardening
- Full canary validation with OpenClaw

### Phase C — Operational maturity

- Model mapping refinement (per-model mapping instead of single default)
- Monitoring/alerting for translation failures
- Performance optimization (translation overhead budget)
- Documentation for internal operators

This lets you validate the architecture with Phase A before committing to the full translation surface.
