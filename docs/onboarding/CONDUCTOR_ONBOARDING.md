# Conductor Onboarding

## What It Does
- Conductor manages isolated repo workspaces for parallel tasks.
- For `innies`, each workspace is a separate copy under `~/conductor/workspaces/innies/<name>`.
- Each workspace gets its own branch, terminal, and agent session.

## Prerequisites
- Local repo at `~/innies`
- Conductor installed at `/Applications/Conductor.app`
- `OPENAI_API_KEY` already working in your normal shell for Codex via Innies

## First-Time Setup

1. Import the repo:

   ```text
   Open Project -> select ~/innies
   ```

2. Open repo settings and set:
- `Branch new workspaces from` -> `origin/main`
- `Remote` -> `origin`

3. Do not leave the imported repo rooted on a local-only branch.

If Conductor imports `~/innies` while that checkout is on a local branch like `codex/...`, it can incorrectly try to create new workspaces from `origin/codex/...`, which fails if that remote ref does not exist.

## Launching Conductor For Codex

Conductor strips `OPENAI_API_KEY` from the shell environment it loads. Since local Codex here is configured to use Innies through `OPENAI_API_KEY`, launch Conductor through the helper instead of Dock or Finder:

```bash
conductor-open
```

This helper:
- reads `OPENAI_API_KEY` from the current shell or Keychain
- launches `/Applications/Conductor.app` with that env var set
- avoids changing the existing `~/.codex/config.toml` provider setup

The helper scripts live at:
- `~/.local/bin/conductor-open`
- `~/.local/bin/conductor-openai-key-sync`

If the key changes, refresh the saved Keychain copy from a shell that already has the new key:

```bash
conductor-openai-key-sync
```

## Daily Flow

1. Start Conductor:

   ```bash
   conductor-open
   ```

2. Create a workspace with the `+` button in the sidebar.

3. Confirm the workspace is based on `origin/main`.

4. Work inside the Conductor workspace, not in `~/innies`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Couldn't find origin/codex/...` during workspace creation | Repo base branch is wrong. Set `Branch new workspaces from` to `origin/main`, remove the failed workspace, and recreate it. |
| `Missing environment variable: OPENAI_API_KEY` in Codex | Quit Conductor and relaunch with `conductor-open`. |
| Conductor still behaves like the old config | Fully quit Conductor before relaunching; the app must start fresh with the new environment. |
| Failed workspace stuck in sidebar | Archive/delete it in Conductor, then recreate after fixing the base branch. |

## Notes
- Keep `~/innies` itself on `main` unless you intentionally need otherwise.
- New workspaces should generally branch from pushed remote branches like `origin/main`, not unpublished local branches.
