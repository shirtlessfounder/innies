# Claude Subagent Routing Diagnosis

Date: 2026-03-10

Scope:
- Issue: `innies claude` parent session works, Claude Code subagents fail with "Subagents are hitting a model routing issue."
- Constraint: code analysis only, no runtime logs.

## Findings

### 1. Claude wrapper depends on a local loopback bridge
- `innies claude` starts a local HTTP server and points `ANTHROPIC_BASE_URL` at `http://127.0.0.1:<port>`.
- The real Claude binary is spawned with:
  - `ANTHROPIC_API_KEY=<innies buyer key>`
  - `ANTHROPIC_BASE_URL=<loopback bridge>`
- Reference: [cli/src/commands/claude.js](../../cli/src/commands/claude.js)
- Reference: [cli/src/commands/claudeProxy.js](../../cli/src/commands/claudeProxy.js)

Implication:
- Parent Claude process works only if it can reach that loopback bridge and preserve those env vars.
- Any child/subagent process that does not inherit the same env or cannot reach the same loopback interface will fail before reaching Innies correctly.

### 2. Claude bridge forwards arbitrary paths, but API only exposes limited Anthropic compat surface
- The bridge forwards `req.url` to the Innies API root without constraining path shape.
- Innies exposes Anthropic compat at `POST /v1/messages`.
- API contract in repo documents `POST /v1/messages`, not a broader Anthropic endpoint set for Claude clients.
- Reference: [cli/src/commands/claudeProxy.js](../../cli/src/commands/claudeProxy.js)
- Reference: [api/src/server.ts](../../api/src/server.ts)
- Reference: [docs/API_CONTRACT.md](../API_CONTRACT.md)

Implication:
- If Claude subagents call extra Anthropic endpoints such as model discovery/validation, those requests can miss compat handling entirely.
- A missing compat endpoint can surface inside Claude Code as a generic routing/model error rather than a clear transport error.

### 3. Model validation is strict and happens before routing succeeds
- Proxy path derives provider/model from the request body for Anthropic-native `/v1/messages`.
- Innies then checks `runtime.repos.modelCompatibility.findActive(provider, model)`.
- If no row exists, API throws `model_invalid` with "No active compatibility rule for provider/model".
- Reference: [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts)

Implication:
- Parent session can work if it uses the wrapper-injected model.
- Subagents can fail if they choose a different Anthropic model id than the parent session uses.

### 4. Wrapper only injects model at top-level Claude spawn
- `innies claude` injects `--model <anthropic default>` only when spawning the top-level `claude` binary.
- Docs say default injected model is `claude-opus-4-6`.
- There is no code here enforcing that all child requests/subagents keep using that same model id.
- Reference: [cli/src/commands/claude.js](../../cli/src/commands/claude.js)
- Reference: [docs/onboarding/CLI_ONBOARDING.md](../onboarding/CLI_ONBOARDING.md)

Implication:
- Claude subagents may select their own model ids internally.
- If those ids are absent from Innies compatibility rules, subagents fail while the parent remains healthy.

### 5. Bridge overwrites every forwarded Claude request with one session-wide `x-request-id`
- `runClaude()` creates one `correlationId` for the whole wrapper session.
- Bridge replaces inbound `x-request-id` with that single value on every forwarded request.
- Proxy uses request id for request correlation and request-seeded credential ordering.
- Reference: [cli/src/commands/claude.js](../../cli/src/commands/claude.js)
- Reference: [cli/src/commands/claudeProxy.js](../../cli/src/commands/claudeProxy.js)
- Reference: [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts)

Implication:
- Parent and subagent requests lose per-request identity.
- This is probably not the primary root cause of the reported error string, but it is a real bug and can make concurrent/subagent behavior less predictable and much harder to debug.

### 6. Auth precedence is likely not the bug
- Bridge strips `Authorization` and injects `x-api-key`.
- API auth middleware intentionally prefers `x-api-key` over bearer auth because Claude may send both.
- Reference: [cli/src/commands/claudeProxy.js](../../cli/src/commands/claudeProxy.js)
- Reference: [api/src/middleware/auth.ts](../../api/src/middleware/auth.ts)

Implication:
- The buyer-key auth bridge design looks intentional and internally consistent.
- The failure is more likely path/model/child-process related than auth precedence related.

## Ranked Hypotheses

### Hypothesis 1. Missing Anthropic compat endpoints needed by subagents
Confidence: high

Why:
- Claude bridge forwards any path.
- Innies compat surface in repo is centered on `POST /v1/messages`.
- Claude subagents may do model discovery or other endpoint calls not used by the parent prompt loop.

Expected symptom:
- Parent session works for normal chat/tool loop.
- Subagent startup or dispatch fails with a vague Claude-side routing/model error.

### Hypothesis 2. Subagents use a different model id than the wrapper-injected parent model
Confidence: high

Why:
- Wrapper only injects `--model` once at top-level process start.
- API hard-fails unknown `(provider, model)` pairs.
- Repo docs already call out `No active compatibility rule` as a known failure.

Expected symptom:
- Parent requests on `claude-opus-4-6` succeed.
- Subagent requests on a different Claude model fail with `model_invalid`, surfaced by Claude as a routing issue.

### Hypothesis 3. Loopback bridge is not reachable from child/subagent execution context
Confidence: medium

Why:
- Claude lane depends on `127.0.0.1:<ephemeral-port>`.
- If subagents run with env scrubbing, separate network namespace, or a sandboxed child runtime, they may not reach the parent bridge.

Expected symptom:
- Parent session works.
- Child sessions fail early, likely during request dispatch or model bootstrap.

### Hypothesis 4. Session-wide `x-request-id` reuse causes subagent-side routing instability
Confidence: medium-low

Why:
- All forwarded Claude traffic in a session shares one request id.
- Proxy uses request id in routing-related bookkeeping.

Expected symptom:
- Mostly observability/correlation damage.
- Possible secondary effects under concurrency, but weaker match for the user-facing error text than the first three hypotheses.

## Most Likely Root Cause

Best current read from code:
- Claude subagents are exercising a path or model contract that the parent session does not.
- The strongest candidates are:
  - missing Anthropic compat endpoints beyond `POST /v1/messages`
  - subagent-selected model ids missing from Innies compatibility rules

## Suggested Validation Targets

If validating next:
- capture exact path used by a failing subagent request
- capture exact `model` value used by a failing subagent request
- verify whether subagents still inherit `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
- verify whether failing subagent requests ever reach Innies at all

## Code Areas To Inspect First For A Fix

- [cli/src/commands/claudeProxy.js](../../cli/src/commands/claudeProxy.js)
- [cli/src/commands/claude.js](../../cli/src/commands/claude.js)
- [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts)
- [api/src/middleware/auth.ts](../../api/src/middleware/auth.ts)
- [api/src/routes/anthropicCompat.ts](../../api/src/routes/anthropicCompat.ts)
