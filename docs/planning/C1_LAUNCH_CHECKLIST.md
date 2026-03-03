# Checkpoint 1 Launch Checklist

Date: 2026-03-01
Scope: internal team-of-4 usage only

## 1) Must-Close Engineering Blockers
- [ ] Proxy idempotency DB compatibility is correct for `proxy.*` scope.
- [ ] Proxy idempotency behavior is deterministic and documented.
- [ ] Per-buyer cap gate is enforced before upstream call.
- [ ] Health-check + auto-quarantine job is active and testable.
- [ ] Admin audit logging is written for sensitive actions:
  - [ ] `POST /v1/admin/kill-switch`
  - [ ] `POST /v1/admin/replay-metering`
  - [ ] `POST /v1/seller-keys`
  - [ ] `PATCH /v1/seller-keys/:id`

## 2) Build/Test Gate
- [x] `api`: `npm run build`
- [x] `api`: `npm test`
- [x] `cli`: `npm run test:smoke`
- [ ] `ui`: `npm install && npm run dev` verified by operator

## 3) API Surface Gate (C1 minimum)
- [x] `POST /v1/proxy/*`
- [x] `POST /v1/seller-keys`
- [x] `PATCH /v1/seller-keys/:id`
- [x] `POST /v1/admin/kill-switch`
- [x] `POST /v1/admin/replay-metering`
- [x] `GET /v1/usage/me`
- [x] `GET /v1/admin/pool-health`

## 4) Behavior Validation Gate (manual, DB-backed)
- [ ] Idempotency duplicate request handling:
  - [ ] first request succeeds
  - [ ] duplicate behaves per policy without DB constraint failure
- [ ] Non-streaming proxy semantics:
  - [ ] upstream 2xx passthrough status/body
  - [ ] upstream 4xx passthrough status/body
- [ ] Streaming path:
  - [ ] SSE/chunk passthrough works
  - [ ] metering write is non-placeholder and reproducible
- [ ] Retry/failover telemetry:
  - [ ] failed attempts written to `routing_events`
  - [ ] final success attempt also written
- [ ] Kill switch behavior:
  - [ ] global `*` disables traffic
  - [ ] org disable works
  - [ ] model disable works

## 5) Data/Secrets Gate
- [ ] `SELLER_SECRET_ENC_KEY_B64` configured in runtime environment.
- [ ] Seller-key create/read path works with encryption enabled.
- [ ] Sample DB inspection confirms secrets are not plaintext.
- [ ] Idempotency rows for proxy scope satisfy metadata-only policy.

## 6) Infrastructure + Seed Gate
- [ ] Internal Postgres + Redis env deployed.
- [ ] Migration applied (`001_checkpoint1_init*`).
- [ ] Seeded:
  - [ ] 4 users
  - [ ] buyer/admin API keys
  - [ ] 2+ seller keys
  - [ ] model compatibility rules
  - [ ] org spend cap defaults

## 7) Team Onboarding Gate
- [ ] Team runbook published with:
  - [ ] `headroom login --token ...`
  - [ ] `headroom doctor`
  - [ ] `headroom link claude` (optional)
  - [ ] support/escalation contact
- [ ] UI shell URL shared (seller keys / buyer usage / pool health).
- [ ] Internal pilot start date announced.

## 8) Pilot Success Gate (2 weeks)
- [ ] 4 internal users route real traffic for >= 14 days.
- [ ] No unresolved reconciliation variance above threshold.
- [ ] Routing stable without manual intervention in normal operation.
- [ ] Dashboard trusted by team for usage decisions.

---

## Current Snapshot (prefilled)
- Build/tests:
  - `api` build: PASS
  - `api` tests: PASS
  - `cli` smoke: PASS
- UI:
  - scaffold files present
  - runtime verification pending
- Known open MVP concerns from latest audit:
  - per-buyer cap gate
  - health-check/quarantine automation
  - audit log persistence for sensitive mutations

## Launch Decision
- [ ] GO
- [ ] NO-GO

If NO-GO, list blocking items and owner:
- 
