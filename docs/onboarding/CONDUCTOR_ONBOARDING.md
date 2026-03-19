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
- `Setup script` -> `bash scripts/conductor-bootstrap.sh`

3. Do not leave the imported repo rooted on a local-only branch.

If Conductor imports `~/innies` while that checkout is on a local branch like `codex/...`, it can incorrectly try to create new workspaces from `origin/codex/...`, which fails if that remote ref does not exist.

## Automatic Workspace Bootstrap

Conductor can run a repo-local setup command every time it creates a new workspace. For `innies`, use:

```bash
bash scripts/conductor-bootstrap.sh
```

This bootstrap script:
- symlinks `api/.env` from `~/innies/api/.env`
- symlinks `scripts/.env.local` from `~/innies/scripts/.env.local`
- symlinks `ui/.env.local` from `~/innies/ui/.env.local`
- installs missing local dependencies for `api` and `ui`

This gives each fresh Conductor workspace the same local env-backed setup as the canonical `~/innies` checkout, without copying secrets into git-tracked files.

`Run script` is separate from `Setup script`. Leave `Run script` blank unless you want the play button to start something specific like `cd api && npm run dev`.

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

## Launching Conductor For Opus

Conductor's Claude/Opus path is separate from its Codex path. To keep normal terminal `claude` unchanged while routing Conductor's Opus sessions through Innies, install the Conductor-only Claude shim:

```bash
conductor-claude-install
```

This installer:
- preserves Conductor's private Claude binary as `~/Library/Application Support/com.conductor.app/bin/claude-real`
- replaces Conductor's private `bin/claude` entrypoint with a wrapper
- routes only Conductor's Claude/Opus lane through `innies claude`
- leaves normal terminal `claude` untouched

The installer script lives at:
- `~/.local/bin/conductor-claude-install`

After installing or changing either helper, fully quit Conductor and relaunch it:

```bash
conductor-open
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
| Opus/Claude says authentication is required | Install the Conductor-only Claude shim with `conductor-claude-install`, then fully relaunch with `conductor-open`. |
| Conductor still behaves like the old config | Fully quit Conductor before relaunching; the app must start fresh with the new environment. |
| Failed workspace stuck in sidebar | Archive/delete it in Conductor, then recreate after fixing the base branch. |
| Opus routing breaks again after a Conductor update | Re-run `conductor-claude-install`; app updates may restore Conductor's private `bin/claude`. |

## Notes
- Keep `~/innies` itself on `main` unless you intentionally need otherwise.
- New workspaces should generally branch from pushed remote branches like `origin/main`, not unpublished local branches.
- Codex and Opus are wired separately inside Conductor:
  - Codex works through `conductor-open`
  - Opus works through Conductor's private Claude wrapper installed by `conductor-claude-install`
