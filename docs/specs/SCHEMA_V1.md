# Headroom Schema V1

## Purpose
Concrete PostgreSQL schema blueprint for MVP execution.

- Checkpoint 1: internal team pooling, routing, metering, auditability.
- Checkpoint 2: external orgs, billing, payouts, disputes, reconciliation.

This is a design spec for migrations, not the migration file itself.

---

## Conventions

- Database: PostgreSQL 15+
- IDs: `uuid` primary keys (`gen_random_uuid()`)
- Times: `timestamptz` in UTC
- Money:
  - accounting amounts in minor units `bigint` (e.g. cents)
  - rates in `numeric(20,10)`
- Token/usage quantities: `bigint` raw units, derived normalized values in views/queries
- Append-only ledgers: no hard update/delete on ledger rows
- Multi-tenant key: `org_id` on all tenant-owned resources

Recommended extensions:
- `pgcrypto` (for UUID + encryption helpers)
- `citext` (case-insensitive email type)
- `btree_gist` (exclusion constraints for effective-date overlap guards)

---

## Global Invariants

1. Usage ledger is append-only.
2. Billing/earnings adjustments are additive reversal rows.
3. Idempotency keys are unique within endpoint scope and retention window.
4. Sensitive admin actions must emit an `audit_log_events` row.
5. `seller_keys` store encrypted key material only (no plaintext at rest).
6. Tenant-scoped uniqueness: request-level uniqueness includes `org_id`.
7. Proxy idempotency storage is metadata-only by default (no prompt/response bodies).

---

## Enums

```sql
-- Role and auth
role_type: admin | seller | buyer
api_key_scope: buyer_proxy | admin

-- Seller key state
seller_key_status: active | paused | quarantined | invalid | revoked

-- Kill switch scopes
disable_scope: seller_key | org | model | global

-- Ledger entry type
usage_entry_type: usage | correction | reversal
billing_entry_type: charge | credit | adjustment | reversal
payout_entry_type: pending | posted | settled | paid | reversed

-- Reconciliation
recon_status: ok | warn | breach | unresolved | resolved

-- Disputes
dispute_status: open | investigating | approved | rejected | settled
```

---

## Core Identity and Tenant Tables

### `users`
Internal + external users.

- `id uuid pk`
- `email citext not null unique`
- `display_name text`
- `is_active boolean not null default true`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes:
- unique(`email`)

### `orgs`
Tenant boundary for buyers/sellers.

- `id uuid pk`
- `name text not null`
- `slug text not null unique`
- `is_active boolean not null default true`
- `spend_cap_minor bigint` (optional hard cap)
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes:
- unique(`slug`)

### `memberships`
User membership in org with role.

- `id uuid pk`
- `org_id uuid not null fk -> orgs(id)`
- `user_id uuid not null fk -> users(id)`
- `role role_type not null`
- `created_at timestamptz not null default now()`

Constraints:
- unique(`org_id`, `user_id`)

Indexes:
- (`org_id`, `role`)
- (`user_id`)

---

## Auth and Access Tables

### `api_keys`
Buyer/admin API keys for proxy and admin endpoints.

- `id uuid pk`
- `org_id uuid fk -> orgs(id)` (nullable for platform-level admin)
- `name text not null`
- `key_hash text not null unique`
- `scope api_key_scope not null`
- `is_active boolean not null default true`
- `last_used_at timestamptz`
- `expires_at timestamptz`
- `created_by uuid fk -> users(id)`
- `created_at timestamptz not null default now()`

Indexes:
- unique(`key_hash`)
- (`org_id`, `is_active`)

### `idempotency_keys`
Deduplication for write endpoints and metered proxy writes.

- `id uuid pk`
- `scope text not null` (example: `proxy.usage.write`, `admin.kill-switch`)
- `tenant_scope text not null` (partition key for dedupe; usually `org:<uuid>` or `platform`)
- `idempotency_key text not null`
- `request_hash text not null`
- `response_code int not null`
- `response_body jsonb` (nullable; do not store payload bodies for proxy scopes)
- `response_digest text` (digest for replay verification)
- `response_ref text` (optional pointer to redacted/object-stored payload if break-glass)
- `created_at timestamptz not null default now()`
- `expires_at timestamptz not null`

Constraints:
- unique(`scope`, `tenant_scope`, `idempotency_key`)
- proxy scopes enforce metadata-only persistence:
  - `scope LIKE 'proxy.%' => response_body IS NULL AND response_digest IS NOT NULL`

Indexes:
- (`expires_at`)
- (`scope`, `tenant_scope`)

---

## Seller Key and Pool State

### `seller_keys`
Contributed provider keys (encrypted).

- `id uuid pk`
- `org_id uuid not null fk -> orgs(id)`
- `provider text not null` (initially single provider)
- `provider_account_label text`
- `encrypted_secret bytea not null`
- `encryption_key_id text not null`
- `status seller_key_status not null default 'active'`
- `monthly_capacity_limit_units bigint`
- `monthly_capacity_used_units bigint not null default 0`
- `priority_weight int not null default 100`
- `failure_count int not null default 0`
- `last_health_at timestamptz`
- `last_used_at timestamptz`
- `compromised_at timestamptz`
- `revoked_at timestamptz`
- `created_by uuid fk -> users(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes:
- (`org_id`, `status`)
- (`status`, `priority_weight`)
- (`provider`, `status`)

Constraints:
- check non-negative numeric fields (`monthly_capacity_limit_units` when set, `monthly_capacity_used_units`, `priority_weight`, `failure_count`)

### `model_compatibility_rules`
Initial provider/model compatibility matrix for routing safety.

- `id uuid pk`
- `provider text not null`
- `model text not null`
- `supports_streaming boolean not null`
- `supports_tools boolean not null`
- `max_input_tokens int`
- `max_output_tokens int`
- `is_enabled boolean not null default true`
- `effective_from timestamptz not null default now()`
- `effective_to timestamptz`
- `created_at timestamptz not null default now()`

Constraints:
- unique(`provider`, `model`, `effective_from`)
- validity: `effective_to IS NULL OR effective_to > effective_from`
- no overlap per (`provider`, `model`) on active time windows (exclusion constraint)

Indexes:
- (`provider`, `model`, `is_enabled`)

### `kill_switch_events`
Global/org/model/key disable actions.

- `id uuid pk`
- `scope disable_scope not null`
- `target_id text not null` (key id, org id, model name, or literal `global`)
- `is_disabled boolean not null`
- `reason text not null`
- `triggered_by uuid fk -> users(id)`
- `created_at timestamptz not null default now()`

Indexes:
- (`scope`, `target_id`, `created_at desc`)

### `kill_switch_current`
Low-latency projection table for hot-path enforcement.

- `scope disable_scope not null`
- `target_id text not null`
- `is_disabled boolean not null`
- `reason text not null`
- `source_event_id uuid not null fk -> kill_switch_events(id)`
- `updated_at timestamptz not null default now()`

Constraints:
- pk(`scope`, `target_id`)

Write model:
- populated/updated by trigger on `kill_switch_events` inserts.

---

## Routing and Usage Tables (Checkpoint 1 Critical)

### `routing_events`
One row per routed request attempt (including retries/fallback).

- `id uuid pk`
- `request_id text not null` (client correlation id)
- `attempt_no int not null`
- `org_id uuid not null fk -> orgs(id)`
- `api_key_id uuid fk -> api_keys(id)`
- `seller_key_id uuid fk -> seller_keys(id)`
- `provider text not null`
- `model text not null`
- `streaming boolean not null default false`
- `route_decision jsonb not null` (reasoning metadata, caps snapshot)
- `upstream_status int`
- `error_code text`
- `latency_ms int not null`
- `created_at timestamptz not null default now()`

Constraints:
- unique(`org_id`, `request_id`, `attempt_no`)
- check `attempt_no >= 1`
- check `latency_ms >= 0`

Indexes:
- (`org_id`, `created_at desc`)
- (`seller_key_id`, `created_at desc`)
- (`provider`, `model`, `created_at desc`)

### `usage_ledger`
Append-only usage economics.

- `id uuid pk`
- `entry_type usage_entry_type not null default 'usage'`
- `request_id text not null`
- `attempt_no int not null default 1`
- `org_id uuid not null fk -> orgs(id)`
- `api_key_id uuid fk -> api_keys(id)`
- `seller_key_id uuid fk -> seller_keys(id)`
- `provider text not null`
- `model text not null`
- `input_tokens bigint not null default 0`
- `output_tokens bigint not null default 0`
- `usage_units bigint not null` (canonical billing units)
- `retail_equivalent_minor bigint not null`
- `currency char(3) not null default 'USD'`
- `source_event_id uuid fk -> usage_ledger(id)` (links correction/reversal to prior row)
- `note text`
- `created_at timestamptz not null default now()`

Constraints:
- exactly one primary usage row per (`org_id`, `request_id`, `attempt_no`) via partial unique index where `entry_type = 'usage'`
- check correction/reversal rows require `source_event_id`, and usage rows require null `source_event_id`
- check non-negative numeric fields:
  - `input_tokens >= 0`
  - `output_tokens >= 0`
  - `usage_units >= 0`
  - `retail_equivalent_minor >= 0`

Indexes:
- (`org_id`, `created_at desc`)
- (`seller_key_id`, `created_at desc`)
- (`request_id`)

### `daily_aggregates`
Materialized daily rollups for dashboard speed.

- `id uuid pk`
- `day date not null`
- `org_id uuid not null fk -> orgs(id)`
- `seller_key_id uuid fk -> seller_keys(id)`
- `provider text not null`
- `model text not null`
- `requests_count bigint not null`
- `usage_units bigint not null`
- `retail_equivalent_minor bigint not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique(`day`, `org_id`, `seller_key_id`, `provider`, `model`)
- check non-negative numeric fields (`requests_count`, `usage_units`, `retail_equivalent_minor`)

Indexes:
- (`day desc`, `org_id`)

---

## Audit and Ops Tables

### `audit_log_events`
Required for sensitive admin and finance actions.

- `id uuid pk`
- `actor_user_id uuid fk -> users(id)`
- `actor_api_key_id uuid fk -> api_keys(id)`
- `org_id uuid fk -> orgs(id)`
- `action text not null` (example: `seller_key.pause`, `kill_switch.enable`)
- `target_type text not null`
- `target_id text not null`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

Indexes:
- (`created_at desc`)
- (`target_type`, `target_id`, `created_at desc`)
- (`org_id`, `created_at desc`)

### `incident_events`
Operational incidents and responses.

- `id uuid pk`
- `severity text not null` (sev1-sev4)
- `category text not null`
- `summary text not null`
- `status text not null` (open, mitigated, closed)
- `opened_at timestamptz not null default now()`
- `closed_at timestamptz`
- `owner_user_id uuid fk -> users(id)`

Constraints:
- check allowed `severity` values (`sev1`, `sev2`, `sev3`, `sev4`)
- check allowed `status` values (`open`, `mitigated`, `closed`)

Note:
- Prefer enum migration once states stabilize to eliminate string drift.

---

## Billing and Payout Tables (Checkpoint 2)

### `rate_cards`
Versioned pricing rules with effective dates.

- `id uuid pk`
- `provider text not null`
- `model text not null`
- `effective_from timestamptz not null`
- `effective_to timestamptz`
- `buyer_rate numeric(20,10) not null`   -- target 0.75
- `seller_rate numeric(20,10) not null`  -- target 0.50
- `platform_rate numeric(20,10) not null`-- target 0.25
- `currency char(3) not null default 'USD'`
- `created_at timestamptz not null default now()`

Constraints:
- unique(`provider`, `model`, `effective_from`)
- validity: `effective_to IS NULL OR effective_to > effective_from`
- no overlap per (`provider`, `model`) on active time windows (exclusion constraint)

Indexes:
- (`provider`, `model`, `effective_from desc`)

### `usage_invoices`
Buyer invoice headers.

- `id uuid pk`
- `org_id uuid not null fk -> orgs(id)`
- `period_start date not null`
- `period_end date not null`
- `status text not null` (draft, posted, paid, void, disputed)
- `subtotal_minor bigint not null`
- `adjustments_minor bigint not null default 0`
- `total_minor bigint not null`
- `currency char(3) not null default 'USD'`
- `stripe_invoice_id text`
- `locked_at timestamptz`
- `created_at timestamptz not null default now()`

Constraints:
- unique(`org_id`, `period_start`, `period_end`)
- check non-negative numeric fields (`subtotal_minor`, `adjustments_minor`, `total_minor`)
- check allowed `status` values (`draft`, `posted`, `paid`, `void`, `disputed`)

Note:
- Prefer enum migration once states stabilize to eliminate string drift.

### `invoice_line_items`
Links invoice to usage or adjustment entries.

- `id uuid pk`
- `invoice_id uuid not null fk -> usage_invoices(id)`
- `usage_ledger_id uuid fk -> usage_ledger(id)`
- `adjustment_id uuid fk -> adjustments(id)`
- `description text not null`
- `quantity bigint not null`
- `unit_amount_minor bigint not null`
- `line_total_minor bigint not null`
- `created_at timestamptz not null default now()`

Constraints:
- exactly one reference must be set:
  - (`usage_ledger_id IS NOT NULL AND adjustment_id IS NULL`) OR
  - (`usage_ledger_id IS NULL AND adjustment_id IS NOT NULL`)

Indexes:
- (`invoice_id`)
- (`usage_ledger_id`)
- (`adjustment_id`)

### `seller_earnings_ledger`
Append-only seller-side earnings.

- `id uuid pk`
- `seller_org_id uuid not null fk -> orgs(id)`
- `usage_ledger_id uuid fk -> usage_ledger(id)`
- `entry_type billing_entry_type not null`
- `amount_minor bigint not null`
- `currency char(3) not null default 'USD'`
- `source_event_id uuid fk -> seller_earnings_ledger(id)`
- `note text`
- `created_at timestamptz not null default now()`

Indexes:
- (`seller_org_id`, `created_at desc`)
- (`usage_ledger_id`)

Constraints:
- `source_event_id` self-fk for reversal/adjustment lineage
- check `amount_minor >= 0`

### `payout_batches`
Monthly payout settlement state machine.

- `id uuid pk`
- `seller_org_id uuid not null fk -> orgs(id)`
- `period_start date not null`
- `period_end date not null`
- `status payout_entry_type not null`
- `gross_minor bigint not null`
- `adjustments_minor bigint not null default 0`
- `net_minor bigint not null`
- `currency char(3) not null default 'USD'`
- `stripe_transfer_id text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique(`seller_org_id`, `period_start`, `period_end`)
- check non-negative numeric fields (`gross_minor`, `adjustments_minor`, `net_minor`)

### `adjustments`
Manual or automated financial corrections.

- `id uuid pk`
- `org_id uuid fk -> orgs(id)`
- `target_table text not null`
- `target_id uuid not null`
- `amount_minor bigint not null`
- `direction text not null` (`credit` or `debit`)
- `currency char(3) not null default 'USD'`
- `reason text not null`
- `created_by uuid not null fk -> users(id)`
- `created_at timestamptz not null default now()`

Constraints:
- check `amount_minor >= 0`
- check allowed `direction` values (`credit`, `debit`)

### `disputes`
External billing disputes.

- `id uuid pk`
- `org_id uuid not null fk -> orgs(id)`
- `invoice_id uuid fk -> usage_invoices(id)`
- `status dispute_status not null default 'open'`
- `reason text not null`
- `opened_by uuid fk -> users(id)`
- `owner_user_id uuid fk -> users(id)`
- `resolution_note text`
- `opened_at timestamptz not null default now()`
- `resolved_at timestamptz`

Indexes:
- (`org_id`, `status`)
- (`invoice_id`)

### `reconciliation_runs`
Daily finance/usage reconciliation runs.

- `id uuid pk`
- `run_date date not null`
- `provider text not null`
- `status recon_status not null`
- `expected_units bigint not null`
- `actual_units bigint not null`
- `delta_units bigint not null`
- `delta_pct numeric(8,4) not null`
- `delta_minor bigint`
- `reviewed_by uuid fk -> users(id)`
- `reviewed_at timestamptz`
- `notes text`
- `created_at timestamptz not null default now()`

Constraints:
- unique(`run_date`, `provider`)
- check non-negative `expected_units`, `actual_units`

---

## Retention Policy Mapping

- `routing_events`: 90 days hot, archive to cold storage after.
- `idempotency_keys`: TTL purge after 7 days.
- `audit_log_events`: 13 months minimum.
- `usage_ledger`, `seller_earnings_ledger`, `usage_invoices`, `payout_batches`, `adjustments`: 7 years.
  - rationale: these are financial source records used for invoices, payouts, disputes, audits, and reversals.
- Optional break-glass prompt/response captures (if ever enabled): max 7 days, encrypted, explicitly audited.

---

## Schema Invariants Enforcement (DB-Level)

Required migration mechanics:

1. Append-only ledgers
- block `UPDATE`/`DELETE` on:
  - `usage_ledger`
  - `seller_earnings_ledger`
  - `adjustments` (financial source record)
- implement via triggers (or strictly restricted DB roles + policy).

2. Kill switch projection
- `AFTER INSERT` trigger on `kill_switch_events` upserts into `kill_switch_current`.

3. Effective-date overlap protection
- use exclusion constraints (`btree_gist`) on:
  - `model_compatibility_rules` by (`provider`, `model`, `tstzrange(...)`)
  - `rate_cards` by (`provider`, `model`, `tstzrange(...)`)

4. Idempotency privacy guard
- add check constraint to prevent storing `response_body` for `proxy.%` scopes.

5. Usage primary-row uniqueness
- enforce with partial unique index:
  - unique (`org_id`, `request_id`, `attempt_no`) where `entry_type = 'usage'`
- allow multiple correction/reversal rows over time for the same request.

6. Idempotency TTL semantics
- if key reuse is allowed after retention window, run purge on a fixed cadence (recommended hourly).
- document that uniqueness remains blocked until expired rows are deleted by purge.

---

## Suggested First Migration Cut (Checkpoint 1)

Implement first:
- `users`, `orgs`, `memberships`
- `api_keys`, `idempotency_keys`
- `seller_keys`, `model_compatibility_rules`, `kill_switch_events`, `kill_switch_current`
- `routing_events`, `usage_ledger`, `daily_aggregates`
- `audit_log_events`

Checkpoint 2 migration pack:
- `rate_cards`, `usage_invoices`, `adjustments`, `invoice_line_items`
- `seller_earnings_ledger`, `payout_batches`
- `disputes`, `reconciliation_runs`

---

## Open Decisions (to resolve before migration)

1. Exact canonical `usage_units` formula per provider/model.
2. Whether `orgs` can be both buyer and seller simultaneously (recommended: yes).
3. CITEXT usage vs lowercase email normalization strategy.
4. Whether to partition `usage_ledger` by month once volume grows.
5. Which fields must be included in legal/audit export reports.
