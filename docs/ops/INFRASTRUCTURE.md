# Innies Infrastructure & Connection Points

Canonical reference for where Innies prod runs, how to connect to it, and common operational procedures.

This doc is the first place to look when you need to ssh into the VM, run SQL against the database, restart the service, or add a new env var. Secrets are **not** stored here — this doc tells you where to find them.

---

## Production topology

```
      Internet
         │
         ▼
  https://innies-api.exe.xyz         ← exe.dev HTTPS share (auto-TLS, public)
         │
         ▼ (proxies to localhost:4010)
  exe.dev VM "innies-api" (nyc)      ← Ubuntu 24.04, node 20, systemd unit `innies-api`
         │
         ▼ (transaction pooler :6543)
  Supabase Postgres 17 (us-east-1)   ← project ref `rcxokzsblffykipiljqv`
```

Single-node today. If you need to scale horizontally, stand up a second exe.dev VM with the same systemd unit pointing at the same Supabase URL; the transaction pooler handles concurrent connections.

---

## Exe.dev VM

### Basics
- **Host:** `innies-api.exe.xyz`
- **SSH user:** `exedev` (created by exe.dev on VM provisioning)
- **Region:** `nyc` (set via `ssh exe.dev set-region nyc`)
- **Disk:** 50 GB
- **RAM:** ~7.8 GB
- **OS:** Ubuntu 24.04.4 LTS
- **Dashboard:** `ssh exe.dev` (lands in the exe.dev REPL; type `help`)

### SSH access prerequisites

The SSH keypair used for exe.dev is:
- private key: `~/.ssh/id_exe`
- public key: `~/.ssh/id_exe.pub`

Your local `~/.ssh/config` should have:

```
Host exe.dev *.exe.xyz
  IdentityFile ~/.ssh/id_exe
  IdentitiesOnly yes
```

To register a new laptop's key with exe.dev:
1. Generate: `ssh-keygen -t ed25519 -f ~/.ssh/id_exe -N ""`
2. SSH into the exe.dev REPL from a machine that's already authorized: `ssh exe.dev`
3. Run: `ssh-key add` and paste the new pub key.

### Common commands

```bash
# tail live logs
ssh innies-api.exe.xyz sudo journalctl -u innies-api -f

# service control
ssh innies-api.exe.xyz sudo systemctl restart innies-api
ssh innies-api.exe.xyz sudo systemctl status innies-api

# exec into the VM for interactive work
ssh innies-api.exe.xyz

# from the exe.dev REPL:
ssh exe.dev                      # lands in REPL
ls                               # list all VMs
share show innies-api            # current HTTPS proxy config
share port innies-api 4010       # repoint HTTPS → localhost:4010
share set-public innies-api      # make publicly reachable
share set-private innies-api     # gate behind exe.dev auth
stat innies-api                  # disk + bandwidth
```

### Filesystem layout on the VM

| Path | Purpose |
|---|---|
| `/opt/innies` | Git clone of `shirtlessfounder/innies` (main branch) |
| `/etc/innies/prod.env` | Env file (mode 600, owned by `exedev`) |
| `/etc/innies/db.session.env` | Session-pooler DB URL alias (for admin scripts) |
| `/etc/systemd/system/innies-api.service` | Systemd unit |
| `/var/log/journal/` | Service logs via journalctl |

---

## Supabase Postgres

### Basics
- **Project:** `innies` in the `shirtless` PRO org
- **Project ref:** `rcxokzsblffykipiljqv`
- **Region:** `us-east-1`
- **Version:** PostgreSQL 17
- **Dashboard:** https://supabase.com/dashboard/project/rcxokzsblffykipiljqv

### Connection strings

Supabase exposes three URLs. Use the right one for the job:

| URL | Port | Use when |
|---|---|---|
| **Transaction pooler** | 6543 | Runtime connection from `innies-api` (high concurrency, short transactions). What `DATABASE_URL` in `/etc/innies/prod.env` points at. |
| **Session pooler** | 5432 | Running migrations, `pg_dump`, `pg_restore`, interactive `psql`, long-lived sessions that need `SET` / `LISTEN` / prepared statements. |
| **Direct connection** | 5432 | Do **not** use. IPv6-only, no pooling, unnecessary. |

General URL shape (password lives in `/etc/innies/prod.env` on the VM):

```
postgresql://postgres.rcxokzsblffykipiljqv:<PASSWORD>@aws-1-us-east-1.pooler.supabase.com:<PORT>/postgres?sslmode=<MODE>
```

- Runtime uses `?sslmode=no-verify` — pg-node's Node TLS layer otherwise rejects Supabase's cert chain. Encryption still happens; only the chain-validation step is skipped.
- `psql` / `pg_dump` can use `?sslmode=require` directly (they use libpq, which handles the chain).

### Where to get the password

In order of preference:

1. **VM env file** (authoritative, always current):
   ```bash
   ssh innies-api.exe.xyz 'sudo grep ^DATABASE_URL= /etc/innies/prod.env'
   ```
2. **Supabase dashboard** → Project Settings → Database → Reset database password (destructive; creates a new one).
3. **Your password manager** (1password), if you saved it there at setup.

### Running SQL from your laptop

```bash
# stash the session pooler URL locally (don't commit!)
export SUPA_SESSION='postgresql://postgres.rcxokzsblffykipiljqv:<PASSWORD>@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require'

psql "$SUPA_SESSION" -c "select count(*) from in_orgs"
```

### Running SQL from the VM

The VM has `/etc/innies/db.session.env` with both pooler URLs pre-stashed (mode 600, root-only):

```bash
ssh innies-api.exe.xyz 'sudo bash -c "source /etc/innies/db.session.env && psql \"\$DATABASE_URL_SESSION\" -c \\\"select count(*) from in_orgs\\\""'
```

---

## Runtime env file

`/etc/innies/prod.env` on the VM is the source of truth for runtime config. Owned by `exedev`, mode 600.

### Required vars
Innies asserts these at boot and will refuse to start without them:
- `DATABASE_URL` — Supabase transaction pooler URL
- `SELLER_SECRET_ENC_KEY_B64` — 32-byte key (base64) that encrypts all seller OAuth tokens at rest

**Rotating `SELLER_SECRET_ENC_KEY_B64` invalidates every stored seller token.** The current value is derived from the sf-prod RDS era and carried into Supabase unchanged. Do not change it without a rotation migration that re-encrypts every row in `in_token_credentials`.

### Operationally important vars
- `PORT=4010` — must match the `share port` config on exe.dev
- `NODE_ENV=production`
- `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=true` — gates `POST /v1/messages`
- `ANTHROPIC_UPSTREAM_BASE_URL=https://api.anthropic.com`
- `OPENAI_UPSTREAM_BASE_URL=https://api.openai.com`
- `INNIES_BASE_URL=https://innies-api.exe.xyz`
- `ORG_GITHUB_CALLBACK_URL=https://innies-api.exe.xyz/v1/org/auth/github/callback`
- `TOKEN_MODE_ENABLED_ORGS=<org_id>`

### Retention (see `docs/migrations/032_archive_retention.sql`)
- `REQUEST_ARCHIVE_RETENTION_DAYS=30` (default 30)
- `REQUEST_ARCHIVE_OUTBOX_RETENTION_DAYS=7` (default 7)
- `ARCHIVE_RAW_REQUEST_ENABLED` — **leave unset** in prod. When set to `true`, the service re-enables raw-request body archival, which grew O(n²) per multi-turn session on sf-prod and filled the disk on 2026-04-17.

### OAuth / session secrets
Copied from a known-good local env at setup. Rotate only as part of a coordinated rollout that re-registers the GitHub OAuth app callbacks:
- `ORG_GITHUB_CLIENT_ID` / `ORG_GITHUB_CLIENT_SECRET` / `ORG_GITHUB_STATE_SECRET`
- `ORG_SESSION_SECRET` / `ORG_REVEAL_SECRET`

### Editing prod env

```bash
# view current keys (values hidden)
ssh innies-api.exe.xyz 'sudo grep -oE "^[A-Z_]+=" /etc/innies/prod.env | sort'

# edit — opens in a root-owned editor; restart service after
ssh innies-api.exe.xyz 'sudo nano /etc/innies/prod.env'
ssh innies-api.exe.xyz 'sudo systemctl restart innies-api && sudo journalctl -u innies-api --since "5 seconds ago" --no-pager | tail -10'
```

---

## Deploying code changes

Production runs `/opt/innies/api/node_modules/.bin/tsx src/server.ts` via systemd. There's no compiled `dist/` — we run TypeScript directly. To ship a change:

```bash
ssh innies-api.exe.xyz bash <<'REMOTE'
set -euo pipefail
cd /opt/innies
git fetch origin main
git reset --hard origin/main
cd api
npm ci
sudo systemctl restart innies-api
sleep 5
sudo journalctl -u innies-api --since "10 seconds ago" --no-pager | tail -20
REMOTE
```

The clone on the VM is over HTTPS without embedded credentials — the initial clone used a short-lived `gh auth token`. Subsequent `git fetch` / `git pull` against `github.com/shirtlessfounder/innies` will fail without credentials. Options:

1. Use `gh auth token` from a developer box piped over SSH for each deploy (what the setup used).
2. Add a deploy key: generate `~/.ssh/id_deploy` on the VM, register the `.pub` half in GitHub repo settings → Deploy keys, then change origin to `git@github.com:shirtlessfounder/innies.git`.

---

## Running migrations

Migrations live in `docs/migrations/NNN_description.sql` and `docs/migrations/NNN_description_no_extensions.sql`. Apply the `_no_extensions` variant against Supabase (Supabase has restrictions on `CREATE EXTENSION`).

From the VM (uses the session pooler, never the transaction pooler — transaction mode can't do multi-statement transactions):

```bash
ssh innies-api.exe.xyz 'sudo bash -c "
source /etc/innies/db.session.env
for f in /opt/innies/docs/migrations/NNN_*_no_extensions.sql; do
  echo \"=== \$f ===\"
  psql \"\$DATABASE_URL_SESSION\" -v ON_ERROR_STOP=1 -f \"\$f\" 2>&1 | tail -5
done
"'
```

---

## Smoke test

Verifying end-to-end after a deploy or env change:

```bash
# 1. health
curl https://innies-api.exe.xyz/healthz   # expect {"ok":true}

# 2. auth + DB read path
export BUYER_KEY='<your innies buyer API key>'
curl -H "x-api-key: $BUYER_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -X POST https://innies-api.exe.xyz/v1/messages \
     -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"reply with only the word pong"}]}'

# 3. verify the request landed in supabase
psql "$SUPA_SESSION" -c "
  select created_at, proxied_path, provider, model
  from in_request_log
  where created_at > now() - interval '5 minutes'
  order by created_at desc limit 3"
```

If auth fails with `forbidden` / `Invalid API key scope`, check:
- the key is `is_active = true`
- `expires_at` is null or in the future

```sql
update in_api_keys set expires_at = now() + interval '30 days'
where key_hash = sha256('<your key>');
```

(`sha256()` here is pseudocode — do it in `openssl` or `shasum`, not in Postgres.)

---

## Critical encryption note

`in_token_credentials.refresh_token_enc` is encrypted with `SELLER_SECRET_ENC_KEY_B64` using AES-GCM. The same key was used on sf-prod RDS and is unchanged on Supabase. Consequences:

- **DO NOT rotate the key without a re-encryption migration** — all 93 token credentials become undecryptable, upstream OAuth refresh breaks, no seller traffic can route.
- The key is in `/etc/innies/prod.env` on the VM and was mirrored from a developer's local `api/.env` at setup time. Treat it like a bank vault key.

---

## Historical context

### The sf-prod → exe.dev + Supabase cutover (2026-04-18)

- **Prior setup:** sf-prod (single AWS VM running Node) + AWS RDS Postgres 16.
- **Incident:** on 2026-04-17 the RDS filled its disk and began rejecting logins (`server login has been failing, cached error: connect failed`), taking Innies fully offline.
- **Root cause:** migration 024 added prompt-archive tables (`in_request_attempt_archives`, `in_raw_blobs`, `in_message_blobs`) with no retention. `in_raw_blobs.raw_request` stored the cumulative conversation every turn, growing O(n²) per multi-turn agent session.
- **Code fix:** PR #190 + #191 — retention job `request-archive-retention-hourly` (runs hourly, 30-day archive retention, 7-day outbox retention) + gate `raw_request` writes behind `ARCHIVE_RAW_REQUEST_ENABLED` (default off). Migration 032 added the supporting `created_at` indexes.
- **Infrastructure move:** stood up `innies-api.exe.xyz` + Supabase project, ran all 30 migrations, copied 290,811 rows across 28 state tables (orgs, users, memberships, api_keys, token_credentials, seller_keys, payment/wallet/earnings/metering/usage ledgers, audit, cutover records) via `pg_dump --data-only` from RDS → `psql` into Supabase. Archive/projection tables were left behind — they will rebuild naturally.
- **Verified:** end-to-end smoke test passed, encryption key carried through (token credentials decrypted successfully), retention job ran its first hourly pass cleanly.

---

## Related docs

- [`AGENTS.md`](../../AGENTS.md) — repo-wide agent instructions
- [`docs/ops/RUNBOOK.md`](./RUNBOOK.md) — incident playbooks (latency spikes, failure waves, stripe recovery)
- [`docs/ops/INNIES_DIAGNOSIS_LOOP.md`](./INNIES_DIAGNOSIS_LOOP.md) — evidence-driven diagnosis workflow
