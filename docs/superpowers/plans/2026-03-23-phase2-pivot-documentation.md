# Darryn Phase 2 Pivot Documentation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the completed Darryn Phase 2 work, rehearsal evidence, and explicit pivot to Phase 3 in repo-visible docs without changing product behavior.

**Architecture:** Add one canonical status doc for the Darryn Phase 2 pilot and a short roadmap note that points to it. Keep the edits narrow, factual, and anchored to what actually shipped and what was proven in rehearsal.

**Tech Stack:** Markdown docs in `docs/planning/` and `docs/superpowers/plans/`

---

## Chunk 1: Canonical Status Doc

### Task 1: Add the parked-status document

**Files:**
- Create: `docs/planning/PHASE2_DARRYN_PILOT_STATUS.md`
- Reference: `docs/planning/PHASE2_DARRYN_PILOT_SCOPE.md`
- Reference: `docs/ops/DARRYN_PILOT_REHEARSAL_CHECKLIST.md`

- [x] **Step 1: Draft the outline**

Include these sections:
- decision/status
- what is completed on `main`
- what was verified in prod rehearsal
- bugs/env gaps found during rehearsal
- what remains intentionally paused
- what is reusable for Phase 3

- [x] **Step 2: Write the document**

Keep it concise and factual. Do not restate the entire Phase 2 scope. Focus on actual shipped state and explicit next direction.

- [x] **Step 3: Review for scope discipline**

Confirm the doc does not promise new Darryn rollout work and does not imply launch signoff.

## Chunk 2: Roadmap Pointer

### Task 2: Add a roadmap note for the pivot

**Files:**
- Modify: `docs/planning/ROADMAP.md`
- Reference: `docs/planning/PHASE2_DARRYN_PILOT_STATUS.md`

- [x] **Step 1: Add a short status note near the Phase 2 heading**

State that the Darryn pilot infrastructure is largely built and rehearsed, but the Darryn-specific migration is parked. Point readers to the canonical status doc.

- [x] **Step 2: Add a short Phase 3 focus note**

State that active product work should move toward permissionless org creation and self-serve onboarding.

- [x] **Step 3: Check wording**

Ensure the roadmap remains a roadmap, not a changelog.

## Chunk 3: Verification

### Task 3: Verify the docs edits

**Files:**
- Verify: `docs/planning/PHASE2_DARRYN_PILOT_STATUS.md`
- Verify: `docs/planning/ROADMAP.md`

- [x] **Step 1: Inspect the rendered text**

Run:

```bash
sed -n '1,260p' docs/planning/PHASE2_DARRYN_PILOT_STATUS.md
sed -n '1,220p' docs/planning/ROADMAP.md
```

Expected: both files read cleanly and the roadmap points to the new status doc.

- [x] **Step 2: Check the diff**

Run:

```bash
git diff -- docs/planning/PHASE2_DARRYN_PILOT_STATUS.md docs/planning/ROADMAP.md docs/superpowers/plans/2026-03-23-phase2-pivot-documentation.md
```

Expected: docs-only diff with no product code changes.
