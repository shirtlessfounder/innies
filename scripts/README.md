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
innies-set-preference
innies-get-preference
innies-check-preference
```

What they do:
- `innies-add-token`: create a Claude Code or Codex OAuth credential
- `innies-rotate-token`: rotate a Claude Code or Codex OAuth credential pool
- `innies-set-refresh-token`: set or clear the stored OAuth refresh token for an existing credential id
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
- `label` maps to API field `debugLabel`
- set/get preference accept either the buyer-key UUID or the live buyer key value; live-key lookup uses `DATABASE_URL`

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
