# AGENTS.md

Repo-local instructions for agents working in `innies`.

## Diagnosis Workflow

For Innies incident response, prod debugging, compat work, routing failures, auth failures, streaming failures, or Anthropic `/v1/messages` regressions:

1. Use the Innies diagnosis loop first.
2. Start with the dispatcher: `innies-diagnose-loop help`
3. Follow the runbook in `docs/ops/INNIES_DIAGNOSIS_LOOP.md`
4. Pull prod evidence first, then reproduce locally, then compare direct path vs Innies path when relevant.
5. Identify the smallest proven delta before patching.

Do not front-load old theories. Do not patch blindly.

## Product Bar

- Full fidelity/parity only.
- Do not ship degraded fallbacks that strip tool use, thinking, or streaming semantics just to make a request pass.
- For request-shape bugs, prefer the narrowest seam that already owns upstream normalization.

## Autonomy Boundary

- Local repo + local machine: full autonomy for edits, tests, and local servers.
- Prod logs/admin reads: allowed.
- EC2 probing: allowed.
- EC2 code/config changes: not allowed unless the user explicitly asks.
- Push/deploy to prod: never automatic.

## Evidence Rules

- Facts first.
- Cite concrete request ids, log artifacts, and file references when conclusions come from logs or captures.
- If evidence is insufficient, say exactly what artifact is missing next.

## Migration Rule

- When adding or editing SQL migrations in `docs/migrations/*.sql`, include `niyant` grants for the new surface introduced by that migration.
- Scope the grants narrowly to what the migration adds or changes:
  - new tables: grant `ALL PRIVILEGES` on the new table to `niyant`
  - new columns on existing tables: grant column-level permissions to `niyant` for the new columns instead of widening the whole table
  - paired `_no_extensions.sql` migrations: keep the `niyant` grant contract aligned there too
- Guard the grant block so the migration does not fail if the Postgres role `niyant` does not exist.
- If a migration genuinely introduces no new surface that should be granted to `niyant`, say so explicitly in the migration file with a short comment instead of silently omitting it.
