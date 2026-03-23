# Scripts

Only the focused operator commands remain.

## Install

```bash
cd /path/to/innies
chmod +x scripts/install.sh
./scripts/install.sh
```

Notes:
- if you accidentally run install from a temp worker/worktree path under `/tmp` or `/private/tmp`, it now prefers `~/innies` as the canonical symlink target when that repo exists
- override that behavior with `INNIES_INSTALL_ROOT=/absolute/path ./scripts/install.sh`

## Commands

```bash
innies-diagnose-loop
innies-diagnose-prod-journal
innies-diagnose-local-replay
innies-diagnose-direct-anthropic
innies-diagnose-anthropic-pool
innies-token-add
innies-token-rotate
innies-token-pause
innies-token-label-set
innies-token-contribution-cap-set
innies-token-refresh-token-set
innies-token-probe-run
innies-token-usage-refresh
innies-buyer-key-create
innies-buyer-preference-set
innies-buyer-preference-get
innies-buyer-preference-check
innies-slo-check
```

Compatibility aliases:
- `innies-issue80-local-replay`
- `innies-issue80-direct-anthropic`
- `innies-issue80-prod-journal`

What they do:
- `innies-diagnose-loop`: single entrypoint for the reusable diagnosis workflow; dispatches to the more specific diagnosis commands and points at the runbook
- `innies-diagnose-prod-journal`: fetch/filter Innies prod journal logs from the devops API for request-id / process / error correlation
- `innies-diagnose-local-replay`: replay a saved Anthropic `/v1/messages` body against local Innies, pin Anthropic, save artifacts, and print DB evidence
- `innies-diagnose-direct-anthropic`: replay the same saved body directly to Anthropic so a direct-vs-Innies diff can be proven
- `innies-diagnose-anthropic-pool`: print the active Anthropic token pool with reserve thresholds and latest provider-usage snapshots
- `innies-token-add`: create a Claude Code or Codex OAuth credential
- `innies-token-rotate`: rotate a Claude Code or Codex OAuth credential pool
- `innies-token-pause`: pause or unpause a token credential so routing excludes or re-admits it manually
- `innies-token-label-set`: change the stored `debugLabel` on an existing Claude Code or Codex credential without rotating it
- `innies-token-contribution-cap-set`: set the 5h / 7d reserve percents for a Claude token credential
- `innies-token-refresh-token-set`: set or clear the stored OAuth refresh token for an existing credential id
- `innies-token-probe-run`: directly probe an active or maxed token credential now; successful maxed probes immediately reactivate it
- `innies-token-usage-refresh`: fetch provider usage for a Claude Code or Codex token now and print raw plus parsed 5h / 7d values
- `innies-buyer-key-create`: create a new buyer key in `in_api_keys` and prompt for provider preference up front
- `innies-buyer-preference-set`: set a buyer key preference to `Claude Code`, `Codex`, or `null`
- `innies-buyer-preference-get`: read the current buyer key preference
- `innies-buyer-preference-check`: run the provider-preference canary after prompting for the expected provider (`Claude Code` or `Codex`)
- `innies-slo-check`: query analytics endpoints and report Phase 1 SLO pass/fail (TTFB p95, timeout rate, success rate, fallback rate); optional arg sets the window (default `24h`); exits 0 if all SLOs pass, 1 if any fail
- `innies-issue80-*`: compatibility aliases for the diagnosis commands above

Behavior:
- org id auto-uses `INNIES_ORG_ID`
- token expiry is auto-filled because the API still requires `expiresAt`
- `innies-buyer-key-create` uses `DATABASE_URL` directly because buyer-key creation does not have an admin API endpoint yet
- `innies-buyer-key-create` prompts for `Claude Code`, `Codex`, or `null`, stores the live key hash, and prints the automatic fallback provider
- `innies-buyer-key-create` optionally accepts an ISO8601 `expiresAt`; press Enter to create a non-expiring buyer key
- `innies-buyer-key-create` prints the live `in_live_...` key once after insert
- focused token scripts are OAuth-token flows, not provider API-key flows
- add/rotate always send `authScheme=bearer`
- on macOS, add/rotate reads the OAuth access token from your clipboard after you press Enter
- add/rotate now prompt for an optional OAuth refresh token; type `paste` to read it from your clipboard, or press Enter to skip
- `innies-token-rotate` accepts a credential UUID or exact `debugLabel`; if `DATABASE_URL` is available it lists existing credentials for the selected provider first so you can choose one by number
- `innies-token-rotate` shows labeled credentials plus unlabeled `active`/`maxed` credentials by default; unlabeled lower-priority rows stay collapsed behind a summary count
- `innies-token-rotate` can replace a selected `active`, `maxed`, or `expired` prior credential; `revoked` credentials remain ineligible
- `innies-token-rotate` preserves the previous credential's `debugLabel` when you leave the rotate label prompt blank
- `innies-token-pause` accepts optional args `pause|unpause`, then lists eligible credentials for the chosen provider and lets you select one by number / UUID / exact `debugLabel`
- `innies-token-pause` needs `DATABASE_URL` so it can list/select existing credentials and verify the current state before calling the admin API
- `innies-token-pause` needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API pause/unpause endpoint directly
- `innies-token-pause pause` only targets currently `active` credentials; `unpause` only targets currently `paused` credentials
- `innies-token-label-set` lists all non-revoked credentials for the chosen provider and lets you select one by number / UUID / exact current `debugLabel`
- `innies-token-label-set` needs `DATABASE_URL` so it can list/select existing credentials before calling the admin API
- `innies-token-label-set` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API label endpoint directly
- `innies-token-label-set` only sets non-empty labels; it does not support clearing a label to `null`
- `innies-token-contribution-cap-set` lists only `active`/`maxed` Claude Code credentials, lets you choose one by number / UUID / exact `debugLabel`, then prompts for the resulting `5h` and `7d` reserve percents
- `innies-token-contribution-cap-set` needs `DATABASE_URL` so it can list/select existing Claude credentials and show the current reserve percents as defaults
- `innies-token-refresh-token-set` accepts a credential UUID, then:
  - `paste` to read the refresh token from clipboard
  - `clear` to remove the stored refresh token
- `innies-token-probe-run` accepts either the token credential UUID or an exact `debugLabel`; it needs `DATABASE_URL`
- `innies-token-probe-run` prints only unexpired `active` / `maxed` credentials first so you can pick a live `debugLabel` or UUID
- `innies-token-probe-run` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API probe endpoint directly
- `innies-token-probe-run` now prints a plain-English result summary (`REACTIVATED`, `PROBE OK, NO STATUS CHANGE`, or `PROBE FAILED, NO STATUS CHANGE`) before the raw JSON response
- `innies-token-probe-run` also prints auth diagnosis details when the backend can derive them, including local OpenAI OAuth expiry and missing-refresh-token state
- `innies-token-usage-refresh` accepts a credential number, UUID, or exact `debugLabel`; it needs `DATABASE_URL`
- `innies-token-usage-refresh` lists only manual-refresh-eligible credentials: unexpired Claude Code and OpenAI/Codex OAuth/session credentials in `active|paused|maxed`, plus expired OAuth credentials from either provider that still have a stored refresh token (shown as `expired`)
- `innies-token-usage-refresh` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API provider-usage refresh endpoint directly
- `innies-token-usage-refresh` uses local credential decryption to hide unsupported OpenAI/Codex rows from the numbered selector; it reads `SELLER_SECRET_ENC_KEY_B64` from the environment or `api/.env` when needed
- `innies-token-usage-refresh` bypasses Anthropic in-memory usage-fetch backoff and prints both parsed 5h / 7d usage plus the raw upstream payload for either provider
- `innies-token-usage-refresh` only prints contribution-cap exhaustion lines when the backend returns Claude-specific cap state; Codex/OpenAI refreshes leave those fields `null`
- `label` maps to API field `debugLabel`
- set/get preference accept either the buyer-key UUID or the live buyer key value; live-key lookup uses `DATABASE_URL`
- script-side default provider display for `null` preference follows `BUYER_PROVIDER_PREFERENCE_DEFAULT` (legacy alias `INNIES_BUYER_PROVIDER_PREFERENCE_DEFAULT` also works)
- non-pinned buyer traffic always gets automatic cross-provider fallback to the other provider; flipping preference flips fallback order too
- `innies-buyer-preference-set` prints the effective preferred provider plus the automatic fallback provider before sending the update
- `innies-buyer-preference-check` now expects and validates the two-provider plan in DB evidence mode
- `innies-diagnose-local-replay` defaults `anthropic-beta` to `fine-grained-tool-streaming-2025-05-14`, sends `x-innies-provider-pin: true`, and keeps artifacts under `/tmp` unless `INNIES_DIAG_OUT_DIR` or `ISSUE80_OUT_DIR` is set
- `innies-diagnose-local-replay` also prints `in_routing_events`, `in_usage_ledger`, and `in_request_log` rows when `DATABASE_URL` + `psql` are available
- `innies-diagnose-direct-anthropic` picks its bearer token from `CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_OAUTH_ACCESS_TOKEN`, then `ANTHROPIC_ACCESS_TOKEN`
- `innies-diagnose-direct-anthropic caller_plus_oauth` is the closest direct-OAuth comparison lane to the working OpenClaw path
- `innies-diagnose-prod-journal` defaults to `https://admin.spicefi.xyz`, `env=prod`, `unit=innies-api`; `--since` is optional and trailing args are treated as local `rg`/`grep` patterns
- `innies-diagnose-prod-journal` reads credentials from `DEVOPS_JOURNAL_USER` / `DEVOPS_JOURNAL_PASSWORD` when set, otherwise prompts
- `innies-diagnose-*` commands are the supported names; the `innies-issue80-*` names remain as compatibility aliases
- `innies-diagnose-loop` is the preferred command to ask an agent to use, because it gives a single command prefix for future permission approval
- local API diagnosis can set `INNIES_COMPAT_CAPTURE_DIR=/tmp/innies-diagnose-capture` to save the exact compat ingress body plus the exact Anthropic first-pass upstream body under one request-id directory for diffing and direct replay

## Env

Scripts auto-load `~/.config/innies/.env` first, then `scripts/.env.local` if present.
Use the shared file for worktree-safe operator secrets; use `scripts/.env.local` only when you need checkout-local overrides.

Bootstrap shared config:

```bash
mkdir -p ~/.config/innies
cp scripts/innies-env.example ~/.config/innies/.env
```

Optional checkout-local override:

```bash
cp scripts/innies-env.example scripts/.env.local
```

For `innies-buyer-preference-check`:
- `DATABASE_URL` is optional, but needed for DB evidence
- `INNIES_MODEL_ANTHROPIC` is required if you check Claude Code
- `INNIES_MODEL_CODEX` is required if you check Codex

For `innies-diagnose-prod-journal`:
- `DEVOPS_JOURNAL_USER` is optional, but avoids the username prompt
- `DEVOPS_JOURNAL_PASSWORD` is optional, but avoids the password prompt
- `DEVOPS_JOURNAL_HOST` is optional; default is `https://admin.spicefi.xyz`
