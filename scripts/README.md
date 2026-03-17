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
innies-token-add
innies-token-rotate
innies-token-pause
innies-token-contribution-cap-set
innies-token-refresh-token-set
innies-token-probe-run
innies-token-usage-refresh
innies-compat-artifact-extract
innies-buyer-key-create
innies-buyer-preference-set
innies-buyer-preference-get
innies-buyer-preference-check
innies-compat-direct-request-bundle
innies-slo-check
innies-compat-first-pass-bundle-diff
```

What they do:
- `innies-token-add`: create a Claude Code or Codex OAuth credential
- `innies-token-rotate`: rotate a Claude Code or Codex OAuth credential pool
- `innies-token-pause`: pause or unpause a token credential so routing excludes or re-admits it manually
- `innies-token-contribution-cap-set`: set the 5h / 7d reserve percents for a Claude token credential
- `innies-token-refresh-token-set`: set or clear the stored OAuth refresh token for an existing credential id
- `innies-token-probe-run`: directly probe an active or maxed token credential now; successful maxed probes immediately reactivate it
- `innies-token-usage-refresh`: fetch Claude provider usage for a token now and print raw plus parsed 5h / 7d values
- `innies-compat-artifact-extract`: extract one issue-80 style Anthropic compat request bundle from a saved prod HTML/log artifact
- `innies-buyer-key-create`: create a new buyer key in `in_api_keys` and prompt for provider preference up front
- `innies-buyer-preference-set`: set a buyer key preference to `Claude Code`, `Codex`, or `null`
- `innies-buyer-preference-get`: read the current buyer key preference
- `innies-buyer-preference-check`: run the provider-preference canary after prompting for the expected provider (`Claude Code` or `Codex`)
- `innies-compat-direct-request-bundle`: replay a payload directly against Anthropic with an exact first-pass header TSV and write a reusable request/response bundle for issue-80 wire diffs
- `innies-slo-check`: query analytics endpoints and report Phase 1 SLO pass/fail (TTFB p95, timeout rate, success rate, fallback rate); optional arg sets the window (default `24h`); exits 0 if all SLOs pass, 1 if any fail
- `innies-compat-first-pass-bundle-diff`: compare extracted compat first-pass bundles and write exact header/body deltas for the current issue-80 wire-diff path

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
- `innies-token-rotate` preserves the previous credential's `debugLabel` when you leave the rotate label prompt blank
- `innies-token-pause` accepts optional args `pause|unpause`, then lists eligible credentials for the chosen provider and lets you select one by number / UUID / exact `debugLabel`
- `innies-token-pause` needs `DATABASE_URL` so it can list/select existing credentials and verify the current state before calling the admin API
- `innies-token-pause` needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API pause/unpause endpoint directly
- `innies-token-pause pause` only targets currently `active` credentials; `unpause` only targets currently `paused` credentials
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
- `innies-token-usage-refresh` accepts a credential number, UUID, or exact Claude `debugLabel`; it needs `DATABASE_URL`
- `innies-token-usage-refresh` lists unexpired Claude credentials in `active|paused|maxed`, plus expired Claude OAuth credentials that still have a stored refresh token (shown as `expired`) so you can recover them manually
- `innies-token-usage-refresh` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API provider-usage refresh endpoint directly
- `innies-token-usage-refresh` bypasses in-memory usage-fetch backoff and prints both parsed 5h / 7d usage plus the raw Anthropic payload
- `innies-compat-artifact-extract` writes `ingress.json`, `upstream-request.json`, `upstream-response.json`, `summary.txt`, and when available `payload.json` plus `invalid-request-payload.json`
- `innies-compat-artifact-extract` usage:
  - `INNIES_EXTRACT_OUT_DIR=/tmp/issue80-artifact scripts/innies-compat-artifact-extract.sh /path/to/response.html req_123`
- `innies-compat-first-pass-bundle-diff` accepts either:
  - one extracted bundle directory to compare `ingress.json` vs `upstream-request.json`
  - or two bundle specs, where directories default to `#upstream` and explicit `#ingress` / `#upstream` selectors override that
- `label` maps to API field `debugLabel`
- set/get preference accept either the buyer-key UUID or the live buyer key value; live-key lookup uses `DATABASE_URL`
- script-side default provider display for `null` preference follows `BUYER_PROVIDER_PREFERENCE_DEFAULT` (legacy alias `INNIES_BUYER_PROVIDER_PREFERENCE_DEFAULT` also works)
- non-pinned buyer traffic always gets automatic cross-provider fallback to the other provider; flipping preference flips fallback order too
- `innies-buyer-preference-set` prints the effective preferred provider plus the automatic fallback provider before sending the update
- `innies-buyer-preference-check` now expects and validates the two-provider plan in DB evidence mode
- `innies-compat-direct-request-bundle` accepts a payload JSON path plus a TSV file of exact direct headers (`name<TAB>value`), replays that body to Anthropic, redacts auth on disk, and writes `payload.json`, `direct-request.json`, `upstream-request.json`, `direct-response.json`, `upstream-response.json`, `response-headers.txt`, `response-body.txt`, and `summary.txt`

## Env

Scripts auto-load `scripts/.env.local` if present.

Bootstrap:

```bash
cp scripts/innies-env.example scripts/.env.local
```

For `innies-buyer-preference-check`:
- `DATABASE_URL` is optional, but needed for DB evidence
- `INNIES_MODEL_ANTHROPIC` is required if you check Claude Code
- `INNIES_MODEL_CODEX` is required if you check Codex
