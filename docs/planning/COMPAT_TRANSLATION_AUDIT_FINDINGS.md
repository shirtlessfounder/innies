# Compat Translation Audit Findings

Date: 2026-03-05
Scope: `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md`
Status: Open
Owner: tbd

## Summary

Current state:
- request translation exists
- response translation exists
- proxy integration exists
- full `api` test suite currently passes

This is not yet equivalent to Phase A scope completion. The main remaining issues are:
- translated compat error mapping is incomplete
- streaming failure handling is incomplete
- streaming multi-part content handling is incomplete
- tool-call ID continuity is not enforced strictly enough
- request translation rewrites prompt text
- unsupported content is silently dropped
- request translation can silently truncate mixed tool results
- end-to-end validation and canary coverage do not yet match the stated scope
- operator/docs contract is stale in a few important places
- adapter test coverage is still below the claimed bar

## Findings

### 1. High - Translated compat error mapping is only half integrated

Problem:
- The scope requires translated OpenAI errors to come back as Anthropic-shaped compat errors.
- Current proxy integration only remaps translated `400` and `403`.
- On translated lanes, `401`, `429`, and `5xx` still flow through generic retry/failover handling and eventually surface as Innies-native `unauthorized` / `capacity_unavailable` errors once fallback is exhausted.
- Terminal translated failures still leak generic AppErrors instead of the compat-layer Anthropic error envelope.

Impact:
- OpenClaw does not get a stable Anthropic-compatible error contract on translated Codex lanes
- fallback exhaustion can surface the wrong error shape for compat clients

Evidence:
- scope:
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:83`
  - `docs/planning/COMPAT_PROVIDER_TRANSLATION_SCOPE.md:302`
- non-streaming:
  - `api/src/routes/proxy.ts:1360`
  - `api/src/routes/proxy.ts:1465`
  - `api/src/routes/proxy.ts:1536`
  - `api/src/routes/proxy.ts:1628`
- streaming:
  - `api/src/routes/proxy.ts:1864`
  - `api/src/routes/proxy.ts:1969`
  - `api/src/routes/proxy.ts:2008`
- terminal fallback/app errors:
  - `api/src/routes/proxy.ts:1645`
  - `api/src/routes/proxy.ts:1652`

Required fix:
- define the translated compat error contract for `401`, `429`, and `5xx`
- apply the same mapping consistently in non-streaming and streaming paths
- add regression tests for fallback-exhausted translated error cases

Suggested owner:
- Agent 2 / Agent 3

### 2. High - Streaming translation drops valid upstream terminal/failure events

Problem:
- `OpenAiToAnthropicStreamTransform` only handles a subset of checked-in OpenResponses stream events.
- It ignores at least:
  - `response.failed`
  - `response.content_part.done`
  - `response.output_text.done`

Impact:
- compat-mode SSE can terminate without a valid Anthropic terminal/error event
- OpenClaw turn completion and parser behavior are still at risk on upstream failure paths

Evidence:
- `api/src/utils/openaiToAnthropicStream.ts:138`
- `api/src/utils/openaiToAnthropicStream.ts:155`
- `api/src/utils/openaiToAnthropicStream.ts:158`
- `~/oss/openclaw/src/gateway/open-responses.schema.ts:295`
- `~/oss/openclaw/src/gateway/open-responses.schema.ts:320`
- `~/oss/openclaw/src/gateway/open-responses.schema.ts:336`
- `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:95`

Required fix:
- handle `response.failed` explicitly
- decide whether `content_part.done` and `output_text.done` are no-ops or required for correctness, then encode that intentionally
- add stream tests for failure/terminal-edge cases

Suggested owner:
- Agent 2 / Agent 3

### 3. High - Tool-loop ID continuity still uses silent fallback IDs

Problem:
- The locked contract says Anthropic `tool_use.id` maps to OpenAI `function_call.call_id`, always.
- Current implementation still falls back to `id` or generates a synthetic ID in multiple places.

Impact:
- malformed or partial upstream payloads can silently produce the wrong continuation ID
- multi-turn tool-use can fail in subtle ways instead of failing fast

Evidence:
- request translation fallback:
  - `api/src/utils/anthropicToOpenai.ts:151`
  - `api/src/utils/anthropicToOpenai.ts:154`
- non-streaming response fallback:
  - `api/src/utils/openaiToAnthropic.ts:54`
  - `api/src/utils/openaiToAnthropic.ts:57`
- streaming response fallback:
  - `api/src/utils/openaiToAnthropicStream.ts:193`
  - `api/src/utils/openaiToAnthropicStream.ts:196`
- contract:
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:35`

Required fix:
- stop falling back to OpenAI item `id` for tool continuity in translated paths
- treat missing `call_id` as an adapter error unless there is a deliberate, documented exception
- add regression tests for missing/invalid `call_id`

Suggested owner:
- Agent 2

### 4. Medium - Streaming translation does not preserve multi-part content structure

Problem:
- The stream transformer keys state by `output_index` only.
- It ignores `content_index`, so multiple content parts on one output item collapse into a single Anthropic block.

Impact:
- translated SSE fidelity is only proven for simple one-text-block and one-tool-call cases
- more complex upstream message structures can lose block boundaries or ordering semantics

Evidence:
- scope:
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:95`
  - `docs/planning/COMPAT_PROVIDER_TRANSLATION_SCOPE.md:277`
- implementation:
  - `api/src/utils/openaiToAnthropicStream.ts:166`
  - `api/src/utils/openaiToAnthropicStream.ts:179`
  - `api/src/utils/openaiToAnthropicStream.ts:222`
- tests:
  - `api/tests/openaiToAnthropicStream.test.ts:21`

Required fix:
- track streaming block state with enough granularity to preserve multi-part output
- add tests that cover multiple `content_part` events on a single output item

Suggested owner:
- Agent 2

### 5. Medium - Request translation can silently truncate mixed tool results

Problem:
- `serializeToolResultContent()` special-cases arrays by extracting only text blocks when any text exists.
- If a tool result contains text plus structured or non-text content, the non-text portion is dropped instead of preserved in the serialized payload.

Impact:
- translated tool_result payloads can lose data before they reach Codex
- tool loops can behave differently from the Anthropic-side transcript that OpenClaw sent

Evidence:
- scope:
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:20`
- implementation:
  - `api/src/utils/anthropicToOpenai.ts:67`
  - `api/src/utils/anthropicToOpenai.ts:69`
  - `api/src/utils/anthropicToOpenai.ts:74`

Required fix:
- serialize mixed-content tool results without dropping non-text portions
- add a regression test for text + structured tool_result arrays

Suggested owner:
- Agent 1

### 6. Medium - Request translation rewrites prompt text instead of preserving it

Problem:
- `joinTextParts()` trims every text segment and rejoins blocks with `\n\n`.
- That behavior is used for system instructions and ordinary user/assistant text messages.

Impact:
- prompt formatting, code blocks, and tool instructions can be mutated during translation
- this is a fidelity risk, not just a shape conversion

Evidence:
- `api/src/utils/anthropicToOpenai.ts:41`
- `api/src/utils/anthropicToOpenai.ts:48`
- `api/src/utils/anthropicToOpenai.ts:104`

Required fix:
- preserve user/system/assistant text as faithfully as possible
- if normalization is intentional anywhere, document the rule and constrain it narrowly
- add regression tests for whitespace-sensitive prompt text

Suggested owner:
- Agent 1

### 7. Medium - Unsupported content is silently dropped rather than rejected or surfaced

Problem:
- Request translation ignores any user block outside `text` / `image` / `tool_result`.
- Assistant translation ignores any block outside `text` / `thinking` / `tool_use`.
- Response translation ignores any OpenAI output item outside `message` / `function_call` / `reasoning`.

Impact:
- boundary adapters can lose data silently
- unsupported content should fail explicitly, or at minimum emit audit logging, instead of pretending translation succeeded

Evidence:
- request translation:
  - `api/src/utils/anthropicToOpenai.ts:140`
  - `api/src/utils/anthropicToOpenai.ts:187`
- response translation:
  - `api/src/utils/openaiToAnthropic.ts:49`

Required fix:
- decide per unsupported content type: translate, reject, or explicitly audit-and-drop
- add tests for unsupported content handling on both request and response translation

Suggested owner:
- Agent 1 / Agent 2

### 8. Medium - Phase A validation/deliverable bar is not met yet

Problem:
- The work split requires end-to-end validation for:
  - multi-turn tool use
  - fallback
  - streaming correctness
  - a canary script that runs a multi-turn tool-use conversation
- The current checked-in canary is only a single-turn `/v1/messages` smoke request.

Impact:
- current test/build green status is stronger than before, but still below the scope's exit criteria
- the most important translated conversation path is not yet proven end-to-end

Evidence:
- required validation:
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:137`
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:151`
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:157`
- current canary:
  - `api/scripts/openclaw_canary_matrix.sh:48`
  - `api/scripts/openclaw_canary_matrix.sh:57`
  - `api/scripts/openclaw_canary_matrix.sh:58`

Required fix:
- add a real multi-turn tool-use canary
- add a translated-path fallback validation case
- record success criteria directly in the canary output or paired validation doc

Suggested owner:
- Agent 3

### 9. Low - Operator contract docs are stale relative to runtime behavior

Problem:
- The API contract still says `POST /v1/messages` is pinned to Anthropic.
- It still lists `compat_provider_pinned` as a current reason value even though compat-mode pinning was removed from the runtime path.

Impact:
- future debugging and implementation work will use the wrong operational contract
- doc drift makes it harder to reason about current compat routing

Evidence:
- docs:
  - `docs/API_CONTRACT.md:70`
  - `docs/API_CONTRACT.md:85`
  - `docs/planning/PREFERENCE_ROUTING_VALIDATION.md:9`
  - `docs/planning/PREFERENCE_ROUTING_VALIDATION.md:43`
- runtime:
  - `api/src/routes/proxy.ts:2495`
  - `api/tests/anthropicCompat.route.test.ts:359`

Required fix:
- update API/operator docs so compat routing reflects the current translated preference path
- remove or re-scope `compat_provider_pinned` in docs if it is no longer a real emitted reason

Suggested owner:
- Agent 3

### 10. Low - Adapter test coverage is still below the claimed bar

Problem:
- The work split claims:
  - unit tests for every content type translation
  - unit tests for every streaming event type
  - parser-fidelity streaming validation
- Current adapter tests are much narrower than that.

Impact:
- high adapter complexity is still under-tested
- future refactors will be easier to break than the scope document implies

Evidence:
- request translation tests:
  - `api/tests/anthropicToOpenai.test.ts:9`
  - `api/tests/anthropicToOpenai.test.ts:73`
- streaming translation tests:
  - `api/tests/openaiToAnthropicStream.test.ts:21`
  - `api/tests/openaiToAnthropicStream.test.ts:43`
- stated test bar:
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:38`
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:95`
  - `docs/planning/COMPAT_TRANSLATION_WORK_SPLIT.md:98`
- current gap called out by Agent 2:
  - only two happy-path streaming cases exist today

Required fix:
- add direct tests for:
  - `tool_choice` variants
  - mixed response ordering
  - `response.failed`
  - stream event completeness
  - parser-fidelity validation against the Anthropic-side consumer

Suggested owner:
- Agent 2 / Agent 3

## Recommended Patch Order

1. Complete translated compat error mapping for `401`, `429`, and `5xx`.
2. Fix `call_id` strictness in translated tool paths.
3. Fix streaming failure/terminal event handling plus multi-part block state.
4. Preserve prompt text fidelity and make unsupported content handling explicit.
5. Fix mixed tool_result serialization.
6. Add end-to-end multi-turn tool-use validation and fallback canary coverage.
7. Update stale operator/docs contract.
8. Expand adapter test coverage to the scope-document bar.

## Exit Criteria For This Audit

- translated compat errors return Anthropic-shaped `401` / `429` / `5xx` payloads where required
- translated tool-use turns fail fast on missing `call_id`
- translated SSE handles upstream failure/terminal events correctly
- translated SSE preserves multi-part content structure
- prompt/tool text survives translation without avoidable normalization drift
- unsupported content is translated, rejected, or explicitly audited rather than silently dropped
- mixed tool_result payloads do not lose structured content during serialization
- checked-in canary covers multi-turn tool-use plus fallback
- operator docs describe the actual compat routing contract
- tests cover the actual adapter contract, not just happy paths
