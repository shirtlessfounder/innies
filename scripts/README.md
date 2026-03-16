# Scripts

Only the focused operator commands remain.

## Install

```bash
cd /Users/dylanvu/innies
chmod +x scripts/install.sh
./scripts/install.sh
```

## Commands

```bash
innies-add-token
innies-create-buyer-key
innies-rotate-token
innies-pause-token
innies-set-contribution-cap
innies-set-refresh-token
innies-requeue-token-probe
innies-refresh-token-usage
innies-set-preference
innies-get-preference
innies-check-preference
```

What they do:
- `innies-add-token`: create a Claude Code or Codex OAuth credential
- `innies-create-buyer-key`: create a new buyer key in `in_api_keys` and prompt for provider preference up front
- `innies-rotate-token`: rotate a Claude Code or Codex OAuth credential pool
- `innies-pause-token`: pause or unpause a token credential so routing excludes or re-admits it manually
- `innies-set-contribution-cap`: set the 5h / 7d reserve percents for a Claude token credential
- `innies-set-refresh-token`: set or clear the stored OAuth refresh token for an existing credential id
- `innies-requeue-token-probe`: directly probe an active or maxed token credential now; successful maxed probes immediately reactivate it
- `innies-refresh-token-usage`: fetch Claude provider usage for a token now and print raw plus parsed 5h / 7d values
- `innies-set-preference`: set a buyer key preference to `Claude Code`, `Codex`, or `null`
- `innies-get-preference`: read the current buyer key preference
- `innies-check-preference`: run the provider-preference canary after prompting for the expected provider (`Claude Code` or `Codex`)

Behavior:
- org id auto-uses `INNIES_ORG_ID`
- token expiry is auto-filled because the API still requires `expiresAt`
- `innies-create-buyer-key` uses `DATABASE_URL` directly because buyer-key creation does not have an admin API endpoint yet
- `innies-create-buyer-key` prompts for `Claude Code`, `Codex`, or `null`, stores the live key hash, and prints the automatic fallback provider
- `innies-create-buyer-key` optionally accepts an ISO8601 `expiresAt`; press Enter to create a non-expiring buyer key
- `innies-create-buyer-key` prints the live `in_live_...` key once after insert
- focused token scripts are OAuth-token flows, not provider API-key flows
- add/rotate always send `authScheme=bearer`
- on macOS, add/rotate reads the OAuth access token from your clipboard after you press Enter
- add/rotate now prompt for an optional OAuth refresh token; type `paste` to read it from your clipboard, or press Enter to skip
- `innies-rotate-token` accepts a credential UUID or exact `debugLabel`; if `DATABASE_URL` is available it lists existing credentials for the selected provider first so you can choose one by number
- `innies-rotate-token` shows labeled credentials plus unlabeled `active`/`maxed` credentials by default; unlabeled lower-priority rows stay collapsed behind a summary count
- `innies-rotate-token` preserves the previous credential's `debugLabel` when you leave the rotate label prompt blank
- `innies-pause-token` accepts optional args `pause|unpause`, then lists eligible credentials for the chosen provider and lets you select one by number / UUID / exact `debugLabel`
- `innies-pause-token` needs `DATABASE_URL` so it can list/select existing credentials and verify the current state before calling the admin API
- `innies-pause-token` needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API pause/unpause endpoint directly
- `innies-pause-token pause` only targets currently `active` credentials; `unpause` only targets currently `paused` credentials
- `innies-set-contribution-cap` lists only `active`/`maxed` Claude Code credentials, lets you choose one by number / UUID / exact `debugLabel`, then prompts for the resulting `5h` and `7d` reserve percents
- `innies-set-contribution-cap` needs `DATABASE_URL` so it can list/select existing Claude credentials and show the current reserve percents as defaults
- `innies-set-refresh-token` accepts a credential UUID, then:
  - `paste` to read the refresh token from clipboard
  - `clear` to remove the stored refresh token
- `innies-requeue-token-probe` accepts either the token credential UUID or an exact `debugLabel`; it needs `DATABASE_URL`
- `innies-requeue-token-probe` prints only unexpired `active` / `maxed` credentials first so you can pick a live `debugLabel` or UUID
- `innies-requeue-token-probe` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API probe endpoint directly
- `innies-requeue-token-probe` now prints a plain-English result summary (`REACTIVATED`, `PROBE OK, NO STATUS CHANGE`, or `PROBE FAILED, NO STATUS CHANGE`) before the raw JSON response
- `innies-requeue-token-probe` also prints auth diagnosis details when the backend can derive them, including local OpenAI OAuth expiry and missing-refresh-token state
- `innies-refresh-token-usage` accepts a credential number, UUID, or exact Claude `debugLabel`; it needs `DATABASE_URL`
- `innies-refresh-token-usage` lists unexpired Claude credentials in `active|paused|maxed`, plus expired Claude OAuth credentials that still have a stored refresh token (shown as `expired`) so you can recover them manually
- `innies-refresh-token-usage` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API provider-usage refresh endpoint directly
- `innies-refresh-token-usage` bypasses in-memory usage-fetch backoff and prints both parsed 5h / 7d usage plus the raw Anthropic payload
- `label` maps to API field `debugLabel`
- set/get preference accept either the buyer-key UUID or the live buyer key value; live-key lookup uses `DATABASE_URL`
- script-side default provider display for `null` preference follows `BUYER_PROVIDER_PREFERENCE_DEFAULT` (legacy alias `INNIES_BUYER_PROVIDER_PREFERENCE_DEFAULT` also works)
- non-pinned buyer traffic always gets automatic cross-provider fallback to the other provider; flipping preference flips fallback order too
- `innies-set-preference` prints the effective preferred provider plus the automatic fallback provider before sending the update
- `innies-check-preference` now expects and validates the two-provider plan in DB evidence mode

## Env

Scripts auto-load `scripts/.env.local` if present.

Bootstrap:

```bash
cp scripts/innies-env.example scripts/.env.local
```

For `innies-check-preference`:
- `DATABASE_URL` is optional, but needed for DB evidence
- `INNIES_MODEL_ANTHROPIC` is required if you check Claude Code
- `INNIES_MODEL_CODEX` is required if you check Codex
