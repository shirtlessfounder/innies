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
innies-rotate-token
innies-set-refresh-token
innies-requeue-token-probe
innies-set-preference
innies-get-preference
innies-check-preference
```

What they do:
- `innies-add-token`: create a Claude Code or Codex OAuth credential
- `innies-rotate-token`: rotate a Claude Code or Codex OAuth credential pool
- `innies-set-refresh-token`: set or clear the stored OAuth refresh token for an existing credential id
- `innies-requeue-token-probe`: directly probe a maxed token credential now; successful probes immediately reactivate it
- `innies-set-preference`: set a buyer key preference to `Claude Code`, `Codex`, or `null`
- `innies-get-preference`: read the current buyer key preference
- `innies-check-preference`: run the provider-preference canary after prompting for the expected provider (`Claude Code` or `Codex`)

Behavior:
- org id auto-uses `INNIES_ORG_ID`
- token expiry is auto-filled because the API still requires `expiresAt`
- focused token scripts are OAuth-token flows, not provider API-key flows
- add/rotate always send `authScheme=bearer`
- on macOS, add/rotate reads the OAuth access token from your clipboard after you press Enter
- add/rotate now prompt for an optional OAuth refresh token; type `paste` to read it from your clipboard, or press Enter to skip
- `innies-set-refresh-token` accepts a credential UUID, then:
  - `paste` to read the refresh token from clipboard
  - `clear` to remove the stored refresh token
- `innies-requeue-token-probe` accepts either the token credential UUID or an exact `debugLabel`; it needs `DATABASE_URL`
- `innies-requeue-token-probe` prints the currently maxed credentials first so you can pick a live `debugLabel` or UUID
- `innies-requeue-token-probe` also needs `INNIES_ADMIN_API_KEY` (or prompts for it) because it calls the admin API probe endpoint directly
- `innies-requeue-token-probe` now prints a plain-English result summary (`REACTIVATED` vs `STILL MAXED`) before the raw JSON response
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
