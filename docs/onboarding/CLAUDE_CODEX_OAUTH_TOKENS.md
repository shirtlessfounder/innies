# Claude + Codex OAuth Tokens

Use this to get your own Claude or Codex/OpenAI login into a form an Innies admin can add.

## Claude

1. Make sure you're using the real Claude binary, not the Innies wrapper.

   Run `which -a claude` to see all paths. If the only result is the Innies wrapper, find the real binary (usually at `~/.local/share/claude/versions/<version>`) and run it directly:

   ```bash
   ~/.local/share/claude/versions/<version> /login
   ```

   If `claude` already points to the real binary, just run:

   ```bash
   claude /login
   ```

3. Confirm Claude stays logged in when you reopen it.

4. On macOS, Claude OAuth credentials are stored in **Keychain Access**, not in a plain-text file.

   To find them:
   - Open **Keychain Access** (search for it in Spotlight)
   - Search for **"claude"** in the search bar
   - Double-click **"Claude Code-credentials"**
   - Check **"Show password"** at the bottom — enter your macOS password when prompted
   - The revealed value is a JSON blob containing your `access_token` (starts with `sk-ant-oat...`) and `refresh_token`

5. Innies needs both:

   ```text
   access token: sk-ant-oat...
   refresh token: <your Claude OAuth refresh token>
   ```

## Codex

1. Log in:

   ```bash
   codex login
   ```

2. Confirm Codex stays logged in when you reopen it. A quick sanity check is:

   ```bash
   codex login status
   ```

3. Current Codex CLI builds store the login session in:

   ```text
   ~/.codex/auth.json
   ```

4. Innies needs:
- provider: `openai`
- auth scheme: `bearer`
- `tokens.access_token`
- `tokens.refresh_token`

## Send To Admin

Claude:
- provider: `anthropic`
- token: `sk-ant-oat...`
- refresh token: required for the org dashboard add-token flow

Codex:
- provider: `openai`
- access token: `tokens.access_token`
- refresh token: `tokens.refresh_token` (required for the org dashboard add-token flow; Innies probes the OAuth token before saving it)

## Quick Fixes
- `claude` opens Innies instead of Claude Code: run `which -a claude` and use the non-wrapper path.
- You cannot find the Claude token on macOS: check Keychain Access.
- `~/.codex/auth.json` is missing: re-run `codex login`. If `codex login status` still shows a logged-in session but the file is absent, your Codex build may be storing auth elsewhere, so confirm the current storage path before extracting tokens manually.
