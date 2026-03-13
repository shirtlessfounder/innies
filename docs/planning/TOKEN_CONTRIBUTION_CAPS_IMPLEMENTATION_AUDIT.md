# Token Contribution Caps Implementation Audit

Date: 2026-03-13

## Findings

- High: Migration `014` cannot create `in_token_credential_provider_usage` as written.
  - Both migration variants declare `token_credential_id text PRIMARY KEY REFERENCES in_token_credentials(id)` in `docs/migrations/014_token_contribution_caps.sql:75-76` and `docs/migrations/014_token_contribution_caps_no_extensions.sql:75-76`.
  - `in_token_credentials.id` is `uuid` in `docs/migrations/002_token_mode_credentials.sql:20`, and other dependent tables reference it as `uuid` in `docs/migrations/011_analytics_request_log_ttfb.sql:64-67`.
  - This foreign key definition is not type-compatible in Postgres, so the migration should fail and block the new provider-usage table entirely.

- High: The rollout is not code-before-migration safe.
  - Live credential reads in `api/src/repos/tokenCredentialRepository.ts:194-223`, `api/src/repos/tokenCredentialRepository.ts:543-572`, and `api/src/repos/tokenCredentialRepository.ts:1002-1015` now select the new reserve columns unconditionally.
  - Anthropic routing also reads the new provider-usage table unconditionally in `api/src/routes/proxy.ts:850-853` before it knows whether any reserve is non-zero.
  - There is no missing-column or missing-relation compatibility guard like the existing pattern in `api/src/repos/apiKeyRepository.ts:26-34`, so a missing migration or relation error will 500 live paths instead of degrading cleanly.

- High: Claude provider-usage data is routed and stored, but the analytics read layer never joins or selects it, so the new dashboard/token-health contract cannot actually show live cap state.
  - `api/src/routes/analytics.ts:919-931` builds dashboard payloads from `analytics.getTokenHealth(...)`, and `api/src/routes/analytics.ts:577-591` normalizes the new `fiveHour*` / `sevenDay*` / `providerUsageFetchedAt` fields.
  - `api/src/repos/analyticsRepository.ts:301-321` still selects only the legacy token-health columns from `in_token_credentials`; it does not select the new reserve columns and the query never joins `in_token_credential_provider_usage`.
  - `ui/src/lib/analytics/server.ts:658-699` derives `5H CAP` / `7D CAP` from those health fields, so Claude rows will stay `null`/`--` instead of reflecting the snapshots that routing is already using.

- High: The provider-usage poller and routing do not agree on what counts as a Claude OAuth credential.
  - `api/src/repos/tokenCredentialRepository.ts:543-577` only loads active provider-usage poll candidates where `auth_scheme = 'bearer'`.
  - `api/src/routes/admin.ts:80-95` still defaults token credential create/rotate requests to `authScheme = 'x_api_key'`.
  - `api/src/routes/proxy.ts:456-457` and `api/src/routes/proxy.ts:857-868` treat Anthropic OAuth as an access-token-prefix check (`sk-ant-oat...`) during routing and contribution-cap exclusion.
  - Result: a reserve-enabled Claude OAuth credential stored with the default auth scheme never gets an initial snapshot, is excluded indefinitely as `provider_usage_snapshot_missing`, and cannot have its extended `429` backoff cleared by the minute poller.

- High: Snapshot persistence failures can turn the Claude repeated-`429` path into a proxy `500` and can abort the minute poller.
  - `api/src/services/tokenCredentialProviderUsage.ts:300-320` awaits `repo.upsertSnapshot(...)` without catching repository write failures.
  - Both token-mode request loops await `recordTokenCredentialOutcome(...)` on upstream `429`s in `api/src/routes/proxy.ts:2119-2127` and `api/src/routes/proxy.ts:2758-2766`, and the Claude repeated-`429` escalation path then awaits `refreshAnthropicOauthUsageNow(...)` in `api/src/routes/proxy.ts:964-968`.
  - `api/src/jobs/tokenCredentialProviderUsageJob.ts:57-67` also awaits the same helper per credential, so a transient DB write failure can abort the request/poll loop instead of preserving the original `429` behavior or logging and continuing.

- Medium: The Claude repeated-`429` safeguard is still incomplete.
  - `api/src/routes/proxy.ts:950-992` applies the extended cooldown before the immediate provider refresh and only logs the refresh result.
  - If the fresh snapshot is healthy, the request path does not clear the longer backoff; only the minute job can clear it early in `api/src/jobs/tokenCredentialProviderUsageJob.ts:78-87`.
  - If the immediate refresh fails or only yields an otherwise-eligible stale state, there is no persistent "hold closed until fresh healthy snapshot" marker beyond `rate_limited_until`. After that timestamp expires, `api/src/repos/tokenCredentialRepository.ts:225-229` can re-admit the token without a fresh healthy snapshot. Reserved tokens may still be re-excluded by missing/hard-stale snapshot policy, but zero-reserve Claude tokens fail open here.

- Medium: Provider-usage operator visibility is only partially implemented.
  - Routed attempts do attach the selected credential's provider-usage metadata into routing events via `api/src/routes/proxy.ts:1864-1869` and `api/src/routes/proxy.ts:2512-2517`.
  - But excluded Claude credentials are filtered in memory in `api/src/routes/proxy.ts:857-870`, and their exclusion counts are only surfaced when all credentials are excluded in `api/src/routes/proxy.ts:1813-1819`.
  - `api/src/services/tokenCredentialProviderUsage.ts:428-458` computes soft-stale warning state, but nothing consumes it.
  - `api/src/jobs/tokenCredentialProviderUsageJob.ts:57-67` logs fetch failures through the job logger only, and `api/src/routes/analytics.ts:919-931` still hardcodes `warnings: []`.

- Medium: The Anthropic usage poller has no per-token retry/backoff state for quota-endpoint failures or `429`s.
  - `api/src/jobs/tokenCredentialProviderUsageJob.ts:51-57` loops every active Claude OAuth credential on each run and immediately fetches usage.
  - `api/src/services/tokenCredentialProviderUsage.ts:231-237` treats upstream non-OK responses, including endpoint `429`s, as ordinary fetch failures.
  - `api/src/services/tokenCredentialProviderUsage.ts:300-320` persists successful snapshots but records no retry gate or cooldown for repeated provider-usage fetch failures, so failing tokens are retried again on the next minute tick.

- Low: `docs/API_CONTRACT.md` still documents the pre-change Claude/OAuth repeated-`429` semantics.
  - `docs/API_CONTRACT.md:807-809` still says OAuth/session credentials auto-max after `15` consecutive `429`s, but `api/src/routes/proxy.ts:950-992` now keeps Claude repeated-`429` handling local via cooldown/backoff plus provider refresh.

- Low: `5H CAP` / `7D CAP` sorting does not match the rendered placeholder cells for non-Claude rows.
  - The UI intentionally renders non-Claude cap cells as `0%` in `ui/src/lib/analytics/present.ts:100-105`.
  - But the underlying normalized sort key stays `null` for non-Claude rows in `ui/src/lib/analytics/server.ts:293-300`.
  - Descending nullable CAP sorts in `ui/src/lib/analytics/sort.ts:54-56` and `ui/src/lib/analytics/sort.ts:98-101` can therefore place placeholder non-Claude rows above real Claude cap values even though the cells render as percentages in `ui/src/components/analytics/AnalyticsTables.tsx:279-345`.

## Verification

- Ran `npm test -- admin.tokenCredentials.route.test.ts tokenCredentialRepository.test.ts tokenCredentialProviderUsageRepository.test.ts`
- Ran `npm test -- proxy.tokenMode.route.test.ts analytics.route.test.ts tokenCredentialProviderUsageJob.test.ts`
- Ran `npm run build` in `api/`
- Ran `npm run build` in `ui/`
