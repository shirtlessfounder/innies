# /diagnose-innies-loop

Run the Innies autonomous diagnosis loop.

## Default Behavior

- Follow [INNIES_DIAGNOSIS_LOOP.md](../ops/INNIES_DIAGNOSIS_LOOP.md)
- Use local repo and local machine freely for edits/tests/server runs
- Treat prod access as read-only
- Treat EC2 probing as read-only
- Never push or deploy automatically

## Workflow

1. Gather the concrete failing evidence already available:
   - failing request id
   - latest prod log dump or live journal access
   - failing request body path
   - direct-path host/profile if relevant
2. Pull prod evidence first with `innies-diagnose-loop prod-journal`.
3. Reproduce locally before patching.
4. If the issue is Anthropic `/v1/messages` or OpenClaw/Innies compat-related:
   - start a local compat capture server
   - run `innies-diagnose-loop local-replay`
   - compare with `innies-diagnose-loop direct-anthropic` or EC2 direct-path evidence
   - inspect `innies-diagnose-loop anthropic-pool` if routing returns `429 No eligible token credentials available`
5. Identify the smallest proven delta.
6. Write a failing test before changing production code.
7. Patch locally and rerun:
   - targeted tests
   - the same local replay loop
8. Stop and report once:
   - the original failure disappears or clearly moves
   - the remaining blocker is deploy-only or pool-only

## Rules

- Findings first, not old theories first
- Do not strip features as a degraded shortcut
- Preserve full-fidelity tool use, thinking, and streaming semantics
- If evidence is insufficient, say exactly what artifact is missing next

## Preferred Tooling

Use the dispatcher:

```bash
innies-diagnose-loop help
```

Subcommands:

- `prod-journal`
- `local-replay`
- `direct-anthropic`
- `anthropic-pool`

Use the legacy `innies-issue80-*` commands only as compatibility aliases when the generic wrappers are unavailable.
