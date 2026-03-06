# innies

CLI wrappers for routing Claude Code and OpenAI Codex through the Innies proxy.

## Install

```bash
npm install -g innies
```

## Commands

```bash
innies login --token <buyer_token> --base-url https://api.innies.computer
innies doctor
innies claude -- --help
innies codex -- --help
```

## What It Does

- `innies claude` runs Claude Code against the Innies Anthropic proxy path.
- `innies codex` runs Codex against the Innies OpenAI Responses proxy path.
- Innies authenticates with your buyer token and routes requests through pooled provider credentials.

## Notes

- You need an Innies buyer token, not a raw Anthropic/OpenAI API key.
- `innies login` stores config in `~/.innies/config.json`.
- Wrapper commands pass through extra arguments after `--`.

## Repo

Main repo: https://github.com/shirtlessfounder/innies
