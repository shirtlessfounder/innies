# Innies Diagnosis Loop

Reusable operator + agent workflow for diagnosing and fixing Innies issues without autonomous deploys.

## Goal

Run the same evidence-driven loop every time:

1. capture prod evidence
2. reproduce locally
3. compare direct path vs Innies path when relevant
4. identify the smallest proven delta
5. patch locally with tests first
6. rerun the same loop until the failure disappears or clearly moves

This is not specific to issue `#80`. That incident supplied the first proven workflow.

## Autonomy Boundary

- Local repo + local machine: full autonomy
- Local code edits/tests/server runs: allowed
- Prod logs/admin reads: allowed
- EC2 probing: allowed
- EC2 code/config changes: not allowed
- Push/deploy to prod: not allowed automatically

## Preferred Entry Point

Use the single dispatcher first:

```bash
innies-diagnose-loop help
```

Subcommands:

- `innies-diagnose-loop prod-journal`
- `innies-diagnose-loop local-replay`
- `innies-diagnose-loop direct-anthropic`
- `innies-diagnose-loop anthropic-pool`

The older `innies-issue80-*` commands remain as legacy aliases. The supported surface is `innies-diagnose-*`.

## Required Inputs

Gather whatever is available before patching:

- repo path
- concrete failing request id if known
- latest prod journal dump or live log access
- failing request body path if available
- direct-path host/profile if a direct comparison lane exists
- current branch / baseline sha

If one input is missing, continue with the others. Do not block on perfect evidence when a tighter loop is possible locally.

## Standard Loop

### 1. Capture Prod Evidence First

Pull the latest journal and isolate the relevant request/process before forming theories.

```bash
innies-diagnose-loop prod-journal --since 2026-03-18T00:00:00Z 'req_123' 'bash[271104]' '/v1/messages'
```

Rules:

- prefer the newest process after restart, not stale debug-era logs
- cite exact request ids
- if a response already says `401`, `403`, `429`, or `400 invalid_request_error`, preserve that raw evidence

### 2. Classify the Failure Before Patching

Use the first concrete failure to choose the branch:

- `401` / `authentication_error`: auth/refresh problem
- `403` / policy blocked: retry/header normalization/policy lane
- `429 No eligible token credentials available`: routing/capacity/pool eligibility problem
- `400 invalid_request_error`: request-shape, payload, or compatibility problem
- broken or malformed SSE: streaming/bridge problem

Do not mix branches. Fix the current blocker first.

### 3. Reproduce Locally

For Anthropic `/v1/messages` or compat issues, run a local capture server so ingress and first upstream request can be diffed exactly.

```bash
cd /path/to/innies/api
ANTHROPIC_COMPAT_ENDPOINT_ENABLED=true \
TOKEN_MODE_ENABLED_ORGS="${INNIES_ORG_ID:?set INNIES_ORG_ID}" \
INNIES_ANTHROPIC_FIRST_PASS_TRACE=1 \
INNIES_COMPAT_CAPTURE_DIR=/tmp/innies-diagnose-capture \
INNIES_COMPAT_TRACE=true \
INNIES_NO_AUTOSTART=1 \
PORT=4012 \
./node_modules/.bin/tsx --eval "
(async () => {
  const { createApp } = await import('./src/server.ts');
  createApp().listen(4012, () => console.log('diagnose api listening on :4012'));
})();
"
```

Then replay the saved body:

```bash
INNIES_ENV_FILE=/dev/null \
INNIES_BASE_URL=http://localhost:4012 \
INNIES_BUYER_API_KEY="$INNIES_BUYER_API_KEY" \
innies-diagnose-loop local-replay /path/to/body.json
```

What this gives you:

- local response headers/body
- DB routing evidence
- exact compat ingress body
- exact first upstream Anthropic request body

### 4. Compare Direct Path vs Innies Path

Only do this when there is a plausible working direct lane.

For Anthropic:

```bash
innies-diagnose-loop direct-anthropic /path/to/body.json caller_plus_oauth
```

For EC2-backed OpenClaw:

- probe only
- inspect installed provider code
- capture a real successful direct request if available
- do not modify EC2 code or config

The goal is to identify the smallest proven delta between:

- working direct materialization
- failing Innies materialization

### 5. Check Pool Eligibility When Routing Blocks First

If local replay returns `429 No eligible token credentials available`, inspect the active Anthropic pool:

```bash
innies-diagnose-loop anthropic-pool
```

This catches cases where the body bug may already be fixed locally, but replay cannot finish because all live Claude credentials are excluded by reserves, stale usage, or max/rate-limit state.

### 6. Convert Evidence Into a Minimal Hypothesis

Good:

- “direct path prepends one extra system block; Innies does not”
- “routing excludes every active Anthropic token because 7d reserve thresholds are breached”
- “upstream 401 happens before any retry normalization”

Bad:

- “maybe Anthropic just doesn’t like tools”
- “maybe OpenClaw serialization is broken”
- “maybe we should strip features”

### 7. Patch Locally With TDD

- write the failing test first
- verify red
- implement the smallest local change
- rerun targeted tests

For request-shape fixes, prefer the narrowest seam that already owns upstream normalization.

### 8. Rerun the Same Loop

After the patch:

1. rerun targeted unit tests
2. rerun local replay on the original failing body
3. confirm the old failure changed or disappeared
4. if a new blocker appears, classify it and continue from that branch

Do not claim success from unit tests alone when a real replay loop exists.

### 9. Stop Before Deploy

If the code is locally fixed and verified, stop and report:

- exact code change
- exact tests run
- exact real replay result
- whether the remaining blocker is deploy-only, token-pool-only, or still unresolved

## Branch Notes

### Request-Shape / Compat Problems

Look at:

- local capture ingress body
- first upstream request body
- direct-path body or provider source

Typical proven deltas:

- missing system prelude
- wrong tool schema shape
- wrong retry normalization
- wrong streaming flags

### Routing / Capacity Problems

Look at:

- `innies-diagnose-loop anthropic-pool`
- DB routing events
- provider-usage snapshots
- reserve percents

If every token is excluded, fix/refresh pool state before using live replay as proof of a body patch.

### Auth Problems

Look at:

- upstream status and error type
- token expiry
- refresh token availability
- retry audit logs

Do not confuse auth failures with payload failures.

### Streaming Problems

Look at:

- passthrough vs synthetic bridge mode
- first-byte and stream-latency logs
- terminal SSE framing
- whether the upstream was JSON, true SSE, or mislabelled SSE

## Artifacts

Prefer a per-run directory under `/tmp`, for example:

```text
/tmp/innies-diagnose-20260318T1500Z/
```

Keep:

- prod journal dump
- local replay headers/body
- compat capture directory
- direct replay headers/body
- any DB pool snapshot you relied on

## Repo-Local Agent Trigger

Use:

```text
/diagnose-innies-loop
```

The repo-local slash command lives at:

```text
docs/slash-commands/diagnose-innies-loop.md
```

It tells a fresh agent to run this loop with the correct autonomy boundary by default.
