# Script Command Renaming Design

## Goal

Make the operator scripts in `scripts/` easier to scan and easier to type by renaming the actual script files to explicit, grouped command names.

## Problem

The current script names are inconsistent in length and shape. Several names are hard to remember quickly, and a quick `ls scripts` does not make the command set feel obvious.

Examples of current pain:

- `innies-set-contribution-cap`
- `innies-set-refresh-token`
- `innies-refresh-token-usage`
- `innies-requeue-token-probe`
- `innies-create-buyer-key`

The user goal is not alias compatibility. The user wants the actual command names to be simpler to type and easier to discover by glancing at the folder.

## Scope

In scope:

- renaming the operator script filenames in `scripts/`
- updating install wiring so `~/.local/bin` gets the new names
- updating docs that list or reference the renamed commands
- removing the old names from the repo

Out of scope:

- changing script behavior
- adding shell aliases or compatibility wrappers
- introducing a dispatcher CLI such as `innies token add`
- changing API contracts or operator flows

## User-Facing Requirements

- The `scripts/` folder should be self-explanatory on quick glance.
- The command names should be explicit, not cryptic.
- Related commands should visually cluster together.
- Only the new names should exist after the change.
- The install flow should expose only the new command names in `~/.local/bin`.
- Documentation should show only the new command names.

## File Naming Rule

The repository script files keep the current `.sh` suffix.

That means:

- repo files stay shell-script files such as `scripts/innies-token-add.sh`
- installed commands in `~/.local/bin` stay extensionless such as `innies-token-add`

This keeps the current repo convention intact while simplifying what the user types.

## Naming Strategy

Use noun-first explicit command names so related commands sort together in directory listings.

Grouping rules:

- token lifecycle and token operations start with `innies-token-`
- buyer-key creation starts with `innies-buyer-key-`
- buyer preference operations start with `innies-buyer-preference-`

This produces a directory listing that is easier to scan than the current verb-first mix.

## Definitions

### Probe Run

For this rename set, `probe-run` means manually triggering the existing immediate token probe flow now.

It does not change probe semantics. It still:

- invokes the same admin probe endpoint
- can reactivate a `maxed` token on success
- does not introduce a new background job or new execution mode

## Approved Rename Table

### Token Commands

- `innies-add-token` -> `innies-token-add`
- `innies-rotate-token` -> `innies-token-rotate`
- `innies-pause-token` -> `innies-token-pause`
- `innies-set-contribution-cap` -> `innies-token-contribution-cap-set`
- `innies-set-refresh-token` -> `innies-token-refresh-token-set`
- `innies-requeue-token-probe` -> `innies-token-probe-run`
- `innies-refresh-token-usage` -> `innies-token-usage-refresh`

### Buyer Key Commands

- `innies-create-buyer-key` -> `innies-buyer-key-create`

### Buyer Preference Commands

- `innies-set-preference` -> `innies-buyer-preference-set`
- `innies-get-preference` -> `innies-buyer-preference-get`
- `innies-check-preference` -> `innies-buyer-preference-check`

## Resulting Script Inventory

After the rename, the installed operator-facing command inventory in `~/.local/bin` should read like this:

- `innies-buyer-key-create`
- `innies-buyer-preference-check`
- `innies-buyer-preference-get`
- `innies-buyer-preference-set`
- `innies-token-add`
- `innies-token-contribution-cap-set`
- `innies-token-pause`
- `innies-token-probe-run`
- `innies-token-refresh-token-set`
- `innies-token-rotate`
- `innies-token-usage-refresh`

The corresponding repo files remain `.sh` files under `scripts/`, for example `scripts/innies-token-add.sh`.

## Behavioral Expectations

The rename is naming-only.

Behavioral invariants:

- each script keeps its current runtime behavior
- any user-facing prompt or help text that mentions command names is updated to the new names
- each script continues to source `_common.sh`
- each script continues to use the same env variables
- each script continues to call the same API endpoints or database flows
- install behavior remains symlink-based

## Install Flow Changes

`scripts/install.sh` should be updated so it:

- links only the new command names into `~/.local/bin`
- stops linking the old names
- removes any previously installed legacy symlinks for the retired names
- prints only the new names in its install summary

No compatibility symlinks should be created for the retired names.

## Documentation Changes

The following docs should be updated to show only the new names where applicable:

- `README.md`
- `scripts/README.md`
- `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md`
- `docs/planning/ROADMAP.md`
- any other repo-local docs or runbooks that mention the old names directly

Documentation rules:

- prefer the new command names everywhere
- remove old-name examples instead of documenting a migration layer
- keep descriptions behaviorally identical unless a description is currently unclear

## Non-Goals

This change should not:

- rename `_common.sh`
- rename `install.sh`
- rename `innies-env.example`
- restructure the scripts into subdirectories
- add wrappers, symlinks, or deprecated aliases for old names
- redesign the operator UX beyond naming clarity

## Risk Assessment

Primary risk:

- internal docs or habits may still reference old names after the rename

Mitigation:

- update all repo-local references during the change
- keep the naming table explicit in the implementation plan
- verify the installed command list after `scripts/install.sh` runs

Accepted impact:

- old commands stop working immediately after the rename

This is intentional and matches the user request for only the new names to exist.

## Verification Requirements

Implementation is complete only if all of the following are true:

1. The operator shell-script subset inside `scripts/` matches the new rename table exactly, with `.sh` suffixes on the repo files.
2. `scripts/install.sh` installs only the new extensionless command names into `~/.local/bin`.
3. `scripts/install.sh` removes the retired legacy names from `~/.local/bin` if they already exist from a previous install.
4. `scripts/README.md` lists only the new names.
5. Known repo-local references in `README.md`, `scripts/README.md`, `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md`, and `docs/planning/ROADMAP.md` are updated if they mention renamed commands.
6. A repo-wide search is run for every retired command name, with zero remaining matches outside intentional history/spec references.
7. The full installed command inventory in `~/.local/bin` is checked to confirm that every expected new command exists and every retired command name is absent.
8. Every installed command symlink target is checked to confirm it points at the renamed `.sh` file.

## Implementation Notes

The change should be implemented as a file rename, not a copy-and-delete after behavior edits.

Preferred implementation shape:

- rename each script file
- update `install.sh`
- update `scripts/README.md`
- update other repo-local references found by search
- verify the resulting command inventory and install wiring

## Open Questions

None.
