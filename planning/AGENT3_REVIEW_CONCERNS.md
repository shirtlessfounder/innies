# Agent 3 Review Concerns (Handoff)

Purpose: quick patch list for cross-agent follow-up. MVP-focused only.

## 1) Idempotent replay payload mismatch (non-streaming)

Issue:
- Initial proxy response includes `data`, but stored replay payload omits it.
- Duplicate requests can receive a different response shape than the first request.

Where:
- `api/src/routes/proxy.ts`
  - first response body includes `data`
  - idempotency body omits `data`

Suggested fix:
- Store the exact response payload used for the first successful response as idempotency replay body.
- Ensure replay returns identical status + body shape.

---

## 2) Streaming idempotency is not replayable

Issue:
- Streaming path commits idempotency with `responseBody: null`.
- Replay branch rejects null body with `idempotency_replay_unavailable`.

Where:
- `api/src/routes/proxy.ts`
- `api/src/services/idempotencyService.ts`

Suggested fix:
- Define explicit streaming idempotency behavior for MVP.
- Option A: treat streaming requests as non-replayable but return deterministic 409 with documented code.
- Option B: store replayable stream metadata contract and return a stable replay response.
- Pick one and enforce consistently in code + docs.

---

## 3) Routing attempt telemetry misses failed attempts

Issue:
- `routing_events` writes occur only on successful terminal paths.
- Failed attempts during retry/failover are not persisted.

Where:
- `api/src/routes/proxy.ts`
- `api/src/repos/routingEventsRepository.ts`

Suggested fix:
- Persist one `routing_events` row for each attempt (success and failure), including error code/status when available.
- Keep final success write as-is, add writes in failure branches.

---

## 4) Proxy idempotency scope naming bypasses DB privacy guard

Issue:
- DB guard for proxy metadata-only storage applies to scopes matching `proxy.*`.
- Route currently uses `proxy_v1`, which does not match guard pattern.

Where:
- `api/src/routes/proxy.ts` (`idempotencyScope`)
- `migrations/001_checkpoint1_init.sql` and `_no_extensions.sql` (`scope !~ '^proxy\\.' ...` check)

Suggested fix:
- Rename proxy scope to dot-prefixed format (example: `proxy.v1`) so DB guard applies.
- Keep admin scopes separate.

---

## 5) Reconciliation source is currently self-referential

Issue:
- `expectedUnits` and `actualUnits` are both sourced from internal `hr_usage_ledger`.
- Job runs, but cannot detect provider drift.

Where:
- `api/src/jobs/reconciliationDataSource.ts`

Suggested fix (MVP-safe):
- Keep current implementation for now, but annotate as temporary in code/docs.
- Add TODO contract for provider-side usage pull integration.

---

## 6) Non-streaming proxy response shape is not provider-native

Issue:
- Non-streaming path returns a Headroom envelope (`requestId`, `keyId`, `upstreamStatus`, `data`) instead of raw upstream body/status.
- Clients expecting provider-native response schema can break.

Where:
- `api/src/routes/proxy.ts` (`responseBody` construction and `res.status(200).json(responseBody)`)

Suggested fix:
- For non-streaming requests, return upstream status + raw upstream JSON body directly.
- Keep Headroom metadata in headers/logs/ledger only.

---

## 7) Upstream 4xx (other than 401/403/429) is surfaced as proxy 200

Issue:
- If upstream returns 400/404/etc, code currently treats it as success path and wraps it in HTTP 200.
- This breaks semantic fidelity and retry/client behavior.

Where:
- `api/src/routes/proxy.ts` (status handling around upstream fetch and final response write)

Suggested fix:
- Pass through upstream 4xx status/body (except intentionally remapped cases).
- Only return 200 when upstream response is truly successful.

---

## 8) Seller secret persistence is plaintext-equivalent

Issue:
- Seller secret is stored as `Buffer.from(secret)` and later decoded directly.
- This is encoding, not encryption at rest.

Where:
- `api/src/repos/sellerKeyRepository.ts`

Suggested fix:
- Add encrypt/decrypt adapter with AEAD (e.g. AES-GCM) using app-provided key material.
- Store ciphertext + nonce/tag metadata, not raw UTF-8 bytes.

---

## 9) Streaming metering remains placeholder (all zeros)

Issue:
- Streaming path always records zero usage/tokens.
- This causes usage drift for teams primarily using streaming.

Where:
- `api/src/routes/proxy.ts` (streaming branch metering write)

Suggested fix:
- Parse stream events for usage where available, or mark estimated usage with deterministic fallback.
- At minimum, write a non-zero estimate and reconcile later.

---

## 10) Idempotency duplicate handling depends on error message text

Issue:
- Concurrent insert conflict is detected by searching for `'duplicate'` in error message.
- Fragile across drivers/locales and can mask other DB errors.

Where:
- `api/src/services/idempotencyService.ts`

Suggested fix:
- Check postgres error code (`23505`) explicitly in repository/service boundary.
- Re-throw all non-unique-violation errors.

---

## 11) Global kill-switch sentinel is implicit

Issue:
- Proxy checks global disable using target `'*'`, but admin payload schema does not enforce this convention.
- Easy for operators to write non-effective global rows.

Where:
- `api/src/routes/proxy.ts`
- `api/src/routes/admin.ts`

Suggested fix:
- Enforce `targetId='*'` when `scope='global'` in admin validation.
- Reject other `targetId` values for global scope.

---

## 12) Runtime hard-fails on module import without `DATABASE_URL`

Issue:
- `runtime.ts` resolves required env at module load time.
- This can break local scripts/tests that import runtime indirectly.

Where:
- `api/src/services/runtime.ts`

Suggested fix:
- Lazily initialize runtime from explicit bootstrap path.
- Keep pure module imports side-effect free where possible.

---

## 13) API TypeScript build currently fails on nullable auth fields

Issue:
- `req.auth.orgId` / `req.auth.apiKeyId` are nullable in type shape.
- Proxy route passes them into metering/routing writes expecting `string`, causing compile failure.

Where:
- `api/src/routes/proxy.ts` (metering/routing write inputs)

Suggested fix:
- Narrow auth type in guarded branch or add explicit non-null checks before write path.
- Prefer a small helper guard (`assertOrgAuth`) so this stays consistent across routes.

---

## 14) UI shell is present but not runnable as a standalone app

Issue:
- Agent 3 delivered shell pages/components, but `ui/` has no runnable app scaffold/scripts yet.
- Internal team cannot validate shell pages end-to-end from this repo state.

Where:
- `ui/src/...` exists, but no `ui/package.json`/runtime scaffold.

Suggested fix:
- Add minimal Next.js scaffold and scripts (`dev`, `build`, `start`) for shell pages only.
- Keep data adapters mocked for C1, but ensure pages can be launched locally.

---

## Validation status note

- This concern list is based on code review plus local verification.
- Current local status in `api/`: tests pass, but TypeScript build currently fails.
