# Issue 80 First-Pass Wire Diff Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable helper that diffs a failing Innies Anthropic first-pass request bundle against a known-good direct/OpenClaw Anthropic first-pass bundle and reports the exact header/body deltas for issue `#80`.

**Architecture:** Keep the change in the `scripts/` support-tooling surface. A thin shell wrapper will validate inputs and invoke a small Node script that normalizes the two request bundles, compares exact headers plus body metadata, and writes both a human-readable summary and machine-readable diff JSON.

**Tech Stack:** Bash, Node.js, JSON, shell regression tests

---

## References

- Issue brief: `/tmp/issue80.json`
- Existing script conventions: `/Users/dylanvu/Forge/.repos/github.com/shirtlessfounder/innies/.worktrees/worker-02-80-first-pass-wire-diff/scripts/_common.sh`
- Real failing extracted bundle: `/private/tmp/issue80-artifact-extract-real/upstream-request.json`
- Scripts docs: `/Users/dylanvu/Forge/.repos/github.com/shirtlessfounder/innies/.worktrees/worker-02-80-first-pass-wire-diff/scripts/README.md`

## File Structure

### Create

- `scripts/innies-compat-wire-diff.sh`
  - Operator entrypoint that validates bundle paths, creates an output directory, and invokes the diff engine.
- `scripts/innies-compat-wire-diff.mjs`
  - Normalizes the left/right request bundles and produces header/body delta artifacts plus a concise summary.
- `scripts/tests/innies-compat-wire-diff.test.sh`
  - Focused shell regression for matching bundles, header/body deltas, and missing-input failures.

### Modify

- `scripts/install.sh`
  - Install the new helper into `~/.local/bin`.
- `scripts/README.md`
  - Document the helper’s purpose, inputs, and output files.

## Chunk 1: Diff Helper

### Task 1: Lock the operator contract with failing tests

**Files:**
- Create: `scripts/tests/innies-compat-wire-diff.test.sh`

- [ ] **Step 1: Write the failing shell tests**

```bash
bash scripts/tests/innies-compat-wire-diff.test.sh
```

The tests should assert:
- identical request bundles report `body_match=true` and no header deltas
- changed headers/body metadata report explicit deltas in `summary.txt` and `diff.json`
- missing request bundle paths fail fast with a clear error

- [ ] **Step 2: Run the new test to verify it fails**

Run: `bash scripts/tests/innies-compat-wire-diff.test.sh`
Expected: FAIL because `scripts/innies-compat-wire-diff.sh` does not exist yet.

### Task 2: Implement the diff helper and wiring

**Files:**
- Create: `scripts/innies-compat-wire-diff.sh`
- Create: `scripts/innies-compat-wire-diff.mjs`
- Modify: `scripts/install.sh`
- Modify: `scripts/README.md`

- [ ] **Step 1: Add the shell entrypoint**

```bash
#!/usr/bin/env bash
set -euo pipefail

LEFT_BUNDLE="$1"
RIGHT_BUNDLE="$2"
OUT_DIR="${INNIES_WIRE_DIFF_OUT_DIR:-/tmp/innies-wire-diff}"

node "${ROOT_DIR}/scripts/innies-compat-wire-diff.mjs" \
  "$LEFT_BUNDLE" \
  "$RIGHT_BUNDLE" \
  "$OUT_DIR"
```

- [ ] **Step 2: Add the Node diff engine**

The engine should:
- read two request-bundle JSON files
- normalize header names to lowercase
- compare exact header values, missing-on-left, and missing-on-right
- compare `body_sha256`, `body_bytes`, `method`, `target_url`, and `request_id`
- write `summary.txt` and `diff.json`

- [ ] **Step 3: Wire the helper into install/docs**

Add one symlink line to `scripts/install.sh` and a concise command section to `scripts/README.md`.

- [ ] **Step 4: Re-run the focused test**

Run: `bash scripts/tests/innies-compat-wire-diff.test.sh`
Expected: PASS.

### Task 3: Verify with real issue-80 evidence

**Files:**
- No repo file changes

- [ ] **Step 1: Syntax-check the touched scripts**

Run:
```bash
bash -n scripts/innies-compat-wire-diff.sh scripts/tests/innies-compat-wire-diff.test.sh scripts/install.sh
node --check scripts/innies-compat-wire-diff.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the helper against real saved issue-80 evidence**

Run:
```bash
INNIES_WIRE_DIFF_OUT_DIR=/private/tmp/issue80-wire-diff-smoke \
scripts/innies-compat-wire-diff.sh \
  /private/tmp/issue80-artifact-extract-real/upstream-request.json \
  /private/tmp/issue80-artifact-extract-real/upstream-request.json
```

Expected: PASS with `body_match=true`, zero header deltas, and output artifacts under `/private/tmp/issue80-wire-diff-smoke`.

- [ ] **Step 3: Commit**

```bash
git add scripts/innies-compat-wire-diff.sh scripts/innies-compat-wire-diff.mjs scripts/tests/innies-compat-wire-diff.test.sh scripts/install.sh scripts/README.md docs/superpowers/plans/2026-03-17-issue80-first-pass-wire-diff.md
git commit -m "chore: add compat first-pass wire diff helper"
```
