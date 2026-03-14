# Claude + Codex OAuth Tokens

Use this to get your own Claude or Codex/OpenAI login into a form an Innies admin can add.

## Claude

1. Use the real Claude binary, not the Innies wrapper at `~/.local/bin/claude`.

   If needed:

   ```bash
   which -a claude
   export INNIES_CLAUDE_BIN=/path/to/real/claude
   ```

2. Start Claude Code with the real binary, then run:

   ```text
   /login
   ```

3. Confirm Claude stays logged in when you reopen it.

4. On macOS, Claude OAuth credentials are stored in Keychain, not in a stable plain-text file.

5. Innies needs both:

   ```text
   access token: sk-ant-oat...
   refresh token: <your Claude OAuth refresh token>
   ```

## Codex

1. Log in:

   ```bash
   codex --login
   ```

2. Confirm Codex stays logged in when you reopen it.

3. Open:

   ```text
   ~/.codex/auth.json
   ```

4. Innies needs:
- provider: `openai`
- auth scheme: `bearer`
- `tokens.access_token`
- `tokens.refresh_token` if present

## Send To Admin

Claude:
- provider: `anthropic`
- token: `sk-ant-oat...`
- refresh token: optional, but useful if you have it

Codex:
- provider: `openai`
- access token: `tokens.access_token`
- refresh token: `tokens.refresh_token` if present

## Quick Fixes
- `claude` opens Innies instead of Claude Code: run `which -a claude` and use the non-wrapper path.
- You cannot find the Claude token on macOS: check Keychain Access.
- `~/.codex/auth.json` is missing: re-run `codex --login`.
