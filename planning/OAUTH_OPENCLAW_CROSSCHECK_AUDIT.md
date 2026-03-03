# OAuth/OpenClaw Cross-Check Audit

Date: 2026-03-03
OpenClaw commit audited: `16ebbd24b5fdaa5c21efc407c1ba7e6a8b383049`

## Summary
This should have been caught earlier by direct source comparison. OpenClaw explicitly documents that losing Anthropic OAuth beta headers (especially `oauth-2025-04-20`) causes `401 OAuth authentication is currently not supported`. Innies currently has retry paths that can drop these betas.

## Confirmed Misses

1. Innies OAuth retry can drop required OAuth betas.
- In retry paths, Innies sanitizes betas to `undefined` and sets `skipOauthDefaultBetas=true`, which can remove `oauth-2025-04-20`.
- Innies refs:
  - `api/src/routes/proxy.ts:376`
  - `api/src/routes/proxy.ts:381`
  - `api/src/routes/proxy.ts:469`
  - `api/src/routes/proxy.ts:808`

2. Current Innies test encodes incorrect behavior.
- Test expects second retry to have no `anthropic-beta`, which bakes in the regression.
- Innies ref:
  - `api/tests/proxy.tokenMode.route.test.ts:429`

3. OpenClaw primary source states this exact failure mode.
- OpenClaw comments:
  - losing `oauth-2025-04-20` causes `401 "OAuth authentication is currently not supported"`
- OpenClaw ref:
  - `src/agents/pi-embedded-runner/extra-params.ts:413-447`

4. Innies blocked-403 retry has similar beta-drop risk.
- Blocked-policy fallback also sanitizes betas broadly.
- Innies refs:
  - `api/src/routes/proxy.ts:165`
  - `api/src/routes/proxy.ts:403`
  - `api/src/routes/proxy.ts:742`

5. Route-level compat regression coverage is still insufficient.
- Need a real `/v1/messages` regression for `401 oauth not supported` validating retry semantics end-to-end.
- Current coverage is mostly proxy-level compat flag simulation.

6. Policy notes intentionally ignored for this audit.
- This audit explicitly ignores provider policy guidance and terms-risk commentary.
- Scope here is technical compatibility/functionality only (headers, payload shape, retry semantics, and end-to-end request success).

## Why This Should Have Been Found
OpenClaw has explicit comments, tests, and docs for this class of OAuth beta-header failures. This was discoverable in primary source and should have been captured in first-pass cross-check.

## References (Primary Sources)
- OpenClaw `extra-params.ts` (OAuth beta requirements):
  - https://github.com/openclaw/openclaw/blob/16ebbd24b5fdaa5c21efc407c1ba7e6a8b383049/src/agents/pi-embedded-runner/extra-params.ts#L404-L456
- OpenClaw usage fetch test asserting OAuth beta:
  - https://github.com/openclaw/openclaw/blob/16ebbd24b5fdaa5c21efc407c1ba7e6a8b383049/src/infra/provider-usage.fetch.claude.test.ts#L56-L63

## MVP-Safe Next Fixes
1. Preserve required OAuth betas on OAuth retry paths (do not drop `oauth-2025-04-20`).
2. Keep payload-shape sanitization for OAuth fallback (tools/tool_choice/thinking/stream normalization) but decouple from beta removal.
3. Replace/adjust failing test expectation that currently requires missing `anthropic-beta` on retry.
4. Add `/v1/messages` route-level regression for `401 OAuth authentication is currently not supported`.
5. Update `docs/API_CONTRACT.md` to reflect actual OAuth fallback behavior.
