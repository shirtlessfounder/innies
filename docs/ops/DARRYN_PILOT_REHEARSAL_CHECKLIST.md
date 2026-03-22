# Darryn Pilot Rehearsal Checklist

Use this checklist for a safe pre-launch dry run with a sacrificial non-Darryn F&F test user. Do not use Darryn's GitHub login, email, buyer key, token credentials, payment method, or payout destination anywhere in this checklist.

## Safety Rules

- Use only a dedicated rehearsal GitHub user and dedicated test provider credentials.
- Use only Stripe test mode.
- Use a newly created buyer key and newly created token credentials that can be discarded after rehearsal.
- Use only test payout destinations or fake metadata for withdrawal requests.
- Stop immediately if any step would touch Darryn-owned rows or live non-test payment artifacts.

## Required Environment And Secrets

### API runtime

- `DATABASE_URL`
- `SELLER_SECRET_ENC_KEY_B64`
- `PILOT_SESSION_SECRET`
- `PILOT_GITHUB_CLIENT_ID`
- `PILOT_GITHUB_CLIENT_SECRET`
- `PILOT_GITHUB_CALLBACK_URL`
- `PILOT_GITHUB_ALLOWLIST_LOGINS` or `PILOT_GITHUB_ALLOWLIST_EMAILS`
- `PILOT_GITHUB_STATE_SECRET`
- `PILOT_TARGET_ORG_SLUG`
- `PILOT_TARGET_ORG_NAME`
- `PILOT_UI_BASE_URL` or `UI_BASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

### UI/admin runtime

- `INNIES_API_BASE_URL` or `INNIES_BASE_URL`
- `INNIES_ADMIN_API_KEY`

## Required IDs And Artifacts

- `BASE_URL`
- `UI_BASE_URL`
- `ADMIN_TOKEN`
- `SOURCE_ORG_ID`
- `TARGET_ORG_SLUG`
- `TARGET_ORG_NAME`
- `TARGET_ORG_ID` after cutover or GitHub OAuth creates the F&F org
- `TEST_USER_GITHUB_LOGIN`
- `TEST_USER_EMAIL`
- `TEST_USER_DISPLAY_NAME`
- `TEST_BUYER_KEY_ID`
- `TEST_TOKEN_CREDENTIAL_ID_CLAUDE`
- `TEST_TOKEN_CREDENTIAL_ID_CODEX` if available
- `CUTOVER_ID` after the cutover dry run
- `TEST_WALLET_ID` once cutover or OAuth creates the F&F org
- test Stripe card and webhook tooling

## Rehearsal Prerequisites

- [ ] Confirm `TARGET_ORG_SLUG` is the F&F target and not a Darryn-only special case.
- [ ] Confirm `PILOT_GITHUB_ALLOWLIST_LOGINS` or `PILOT_GITHUB_ALLOWLIST_EMAILS` includes only the sacrificial test user for this rehearsal window.
- [ ] Confirm the routing reserve-floor migration adapter is configured.
- [ ] Confirm Stripe is in test mode and the webhook endpoint points to `/v1/payments/webhooks/stripe`.
- [ ] Confirm the test buyer key and token credentials are disposable and not used by Darryn.
- [ ] Confirm rollback payload values are prepared before the cutover dry run starts.

## Safe Test-User Setup In F&F

- [ ] Create or identify a sacrificial GitHub account and email for the rehearsal user.
- [ ] Create or identify one disposable buyer key in `SOURCE_ORG_ID`.
- [ ] Create or identify one disposable Claude token credential in `SOURCE_ORG_ID`.
- [ ] Create or identify one disposable Codex token credential in `SOURCE_ORG_ID` if Codex lane coverage is required.
- [ ] Record the exact ids above in the rehearsal notes.
- [ ] Confirm none of those ids appear in Darryn’s current inventory.

Expected result:
- a fully disposable test-user identity set exists for buyer, auth, and contributor flows

Rollback trigger:
- any ambiguity about whether an id belongs to Darryn or another real user

## Cutover Dry Run For The Test User

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/cutover" \
  -d "{
    \"sourceOrgId\": \"$SOURCE_ORG_ID\",
    \"targetOrgSlug\": \"$TARGET_ORG_SLUG\",
    \"targetOrgName\": \"$TARGET_ORG_NAME\",
    \"targetUserEmail\": \"$TEST_USER_EMAIL\",
    \"targetUserDisplayName\": \"$TEST_USER_DISPLAY_NAME\",
    \"buyerKeyIds\": [\"$TEST_BUYER_KEY_ID\"],
    \"tokenCredentialIds\": [\"$TEST_TOKEN_CREDENTIAL_ID_CLAUDE\"]
  }"
```

If testing Codex too, include `TEST_TOKEN_CREDENTIAL_ID_CODEX` in `tokenCredentialIds`.

- [ ] Save `cutoverId`, `targetOrgId`, and `targetUserId`.
- [ ] Confirm the API returns `200`.
- [ ] Confirm new buyer-key auth no longer returns `423 cutover_in_progress`.
- [ ] Confirm the moved token credential stops appearing frozen for cutover reasons.

Expected result:
- committed cutover record exists
- freezes are released after commit
- the test user now resolves to the F&F org

Rollback trigger:
- any `423 cutover_in_progress` or freeze condition remains after a successful `200`
- the wrong org/user ids were targeted
- reserve-floor migration fails

## Rollback Dry Run For The Test User

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/rollback" \
  -d "{
    \"sourceCutoverId\": \"$CUTOVER_ID\",
    \"targetOrgId\": \"$SOURCE_ORG_ID\",
    \"buyerKeyIds\": [\"$TEST_BUYER_KEY_ID\"],
    \"tokenCredentialIds\": [\"$TEST_TOKEN_CREDENTIAL_ID_CLAUDE\"]
  }"
```

If Codex was included in cutover, include the Codex credential id here too.

- [ ] Confirm the API returns `200` with `rollbackId`.
- [ ] Confirm buyer-key and token-credential ownership resolve back to the source org.
- [ ] Confirm new admissions are not left frozen after rollback commit.

Expected result:
- rollback marker exists
- source ownership is restored for the rehearsal assets only

Rollback trigger:
- the test assets remain frozen or still resolve to the F&F org after `200`

## GitHub Allowlist Login Verification

UI:
- [ ] Open `$UI_BASE_URL/pilot`.
- [ ] Click `Sign in with GitHub`.
- [ ] Complete OAuth with `TEST_USER_GITHUB_LOGIN`.

API spot-check:
- [ ] `GET $BASE_URL/v1/pilot/session` with the pilot session cookie returns `200`.

Expected result:
- login succeeds only for the allowlisted test user
- the session resolves to the F&F org

No-go condition:
- non-allowlisted users can log in
- allowlisted test user cannot log in with a verified email

## Admin Impersonation Verification

UI:
- [ ] Open `$UI_BASE_URL/admin/pilot`.
- [ ] Confirm the sacrificial test user appears in the pilot identity list.
- [ ] Open `/admin/pilot/accounts/{targetOrgId}`.
- [ ] Click `Impersonate`.

Expected result:
- browser redirects to `/pilot`
- the page eyebrow changes to admin impersonation
- dashboard data loads in the target F&F context

No-go condition:
- the test user is missing from admin identity discovery
- impersonation lands in the wrong org

## Wallet Manual Credit Flow

```bash
IDEMPOTENCY_KEY="$(uuidgen)"
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/wallets/$TEST_WALLET_ID/adjustments" \
  -d '{
    "effectType": "manual_credit",
    "amountMinor": 2500,
    "reason": "rehearsal seed credit",
    "metadata": { "source": "pre_darryn_rehearsal" }
  }'
```

- [ ] Confirm the response returns `200` and a wallet ledger entry.
- [ ] Confirm `/pilot` shows the updated wallet balance and ledger row.

Expected result:
- manual credit is visible in both admin and pilot views

Rollback trigger:
- wallet ledger changes but dashboard does not reconcile

## Stripe Test-Mode Payment Method Attach

UI:
- [ ] In `/pilot`, use the payment setup form that posts to `/api/pilot/payments/setup`.
- [ ] Complete Stripe setup in test mode with a Stripe test card.

Expected result:
- the pilot funding section shows a stored payment method
- auto-recharge controls become configurable

No-go condition:
- setup session cannot be created
- payment method attaches in Stripe but does not appear in the pilot funding view

## Manual Top-Up

UI:
- [ ] In `/pilot`, submit the top-up form that posts to `/api/pilot/payments/top-up`.
- [ ] Complete the Stripe checkout in test mode.

API/DB sanity:
- [ ] browser-authenticated `GET $BASE_URL/v1/pilot/payments` shows a recent attempt entry after redirect completes.
- [ ] `in_payment_attempts` and `in_payment_outcomes` contain the expected wallet rows.

Expected result:
- wallet balance increases
- a payment attempt and payment outcome exist
- the resulting wallet ledger credit appears in the dashboard

No-go condition:
- Stripe payment succeeds but the wallet credit never appears

## Auto-Recharge Before Paid Admission

Preparation:
- [ ] Keep a stored Stripe test payment method attached.
- [ ] Set auto-recharge enabled in `/pilot` via the form that posts to `/api/pilot/payments/auto-recharge`.
- [ ] Reduce wallet balance to zero or below using a safe manual debit if needed.

```bash
IDEMPOTENCY_KEY="$(uuidgen)"
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/wallets/$TEST_WALLET_ID/adjustments" \
  -d '{
    "effectType": "manual_debit",
    "amountMinor": 2500,
    "reason": "rehearsal zero-balance setup",
    "metadata": { "source": "pre_darryn_rehearsal" }
  }'
```

- [ ] Trigger a paid admission path while balance is non-positive.

Expected result:
- wallet service attempts auto-recharge before admitting the paid request
- a successful charge restores positive balance and the request is admitted

Rollback trigger:
- paid admission proceeds with non-positive balance and no recharge
- recharge succeeds but the wallet remains negative because outcome recording failed

## Self-Free Request Path

- [ ] Use the rehearsal buyer key against the test user’s own connected capacity in the matching provider lane.
- [ ] Generate at least one finalized request through the test user’s own credential.
- [ ] Check `/pilot` request history and wallet view.

Expected result:
- request appears in `/v1/pilot/requests`
- routing mode is `self-free`
- no buyer debit appears in the wallet ledger
- no contributor accrual is created for self-use

No-go condition:
- self-use creates a buyer debit or contributor earnings row

## Paid-Team-Capacity Request Path

- [ ] Make the test user’s own eligible capacity unavailable for new admissions in a safe way.
- [ ] If needed, disable or exhaust the test user’s own capacity without touching Darryn or production team credentials.
- [ ] Send a buyer request that should fall back to team-owned capacity.

Expected result:
- request history shows `paid-team-capacity`
- a buyer debit appears after finalization
- no contributor earnings accrue to the test user for that request

No-go condition:
- fallback is silently unavailable without a clear failure when expected
- debit math does not reconcile with the finalized request

## Contributor-Earnings Path If Reproducible

- [ ] Attempt only if you can safely force internal/team traffic onto the test user’s contributed capacity.
- [ ] Generate one internal or team-origin request that overflows onto the sacrificial contributor credential.
- [ ] Verify earnings summary and earnings history in `/pilot`.

Expected result:
- request explanation and history show `team-overflow-on-contributor-capacity`
- contributor accrual appears for the test user
- no buyer debit is created for the test user for that overflow request

If not reproducible:
- [ ] record the missing prerequisite precisely
- [ ] do not mark this flow as passed from inference alone

No-go condition:
- neither a live repro nor another concrete evidence path exists for contributor earnings before Darryn cutover

## Withdrawal Request And Admin Review Path

UI:
- [ ] In `/pilot`, submit a small withdrawal request through `/api/pilot/withdrawals`.
- [ ] In `/admin/pilot/accounts/{targetOrgId}`, review the request.

API:
- [ ] Approve or reject via `/v1/admin/pilot/withdrawals/{withdrawalRequestId}/actions`.
- [ ] If approved, mark settled or settlement failed with a test reference.

Expected result:
- request status transitions are truthful
- settlement failure releases reserved funds back to withdrawable
- settlement success posts a payout-settlement ledger row

No-go condition:
- a request transitions but the earnings buckets do not reconcile

## Request-History Visibility Checks

Pilot view:
- [ ] `GET $BASE_URL/v1/pilot/requests?limit=50` returns only the test user’s F&F post-cutover request history.

Admin view:
- [ ] `GET $BASE_URL/v1/admin/requests?consumerOrgId=$TARGET_ORG_ID&historyScope=post_cutover&limit=50` returns the same post-cutover pilot history.
- [ ] Request explanation from `/v1/admin/requests/{requestId}/explanation` is available for at least one finalized request.

Expected result:
- pilot view is post-cutover only
- admin view can still explain the pilot requests

No-go condition:
- pilot history leaks pre-cutover/internal history
- admin explanation is missing for finalized rehearsal requests

## Reserve-Floor Edit And Enforcement Checks

UI:
- [ ] In `/pilot`, edit reserve floors through the connected-account form that posts to `/api/pilot/reserve-floors`.

API spot-check:

```bash
curl -s -H "x-api-key: $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/token-credentials/$TEST_TOKEN_CREDENTIAL_ID_CLAUDE/contribution-cap"
```

- [ ] Confirm the edited values are visible through the admin contribution-cap read.
- [ ] Attempt a sold-capacity path that should now be denied if the new reserve floors make the test credential ineligible.

Expected result:
- reserve-floor edits persist
- new sold work is blocked when the configured floors should fail closed

No-go condition:
- reserve-floor edits save in UI but do not persist in admin reads
- sold work still admits when fail-closed reserve-floor checks should deny it

## Webhook And Replay Sanity Checks

- [ ] Confirm the Stripe webhook endpoint is `/v1/payments/webhooks/stripe`.
- [ ] Inspect recent `in_payment_webhook_events`, `in_payment_attempts`, and `in_payment_outcomes` rows after a top-up or auto-recharge attempt.
- [ ] If a payment outcome exists with `wallet_recorded_at` null, replay the original Stripe test event after fixing the underlying issue.

Expected result:
- webhook events are claimed once
- replay is safe because wallet recording is idempotent on processor effect id

No-go condition:
- replay would create duplicate wallet credits
- webhook events remain unprocessed with no clear recovery path

## Exact No-Go Criteria Before Moving Darryn

- [ ] No real Darryn ids or payment artifacts were touched during rehearsal.
- [ ] Cutover and rollback both succeed cleanly for the sacrificial test user.
- [ ] GitHub allowlist login works only for the intended test user.
- [ ] Admin impersonation lands in the correct F&F context.
- [ ] Manual wallet credit is visible and reconciled.
- [ ] Stripe test-mode payment method attach succeeds.
- [ ] Manual top-up completes and records wallet credit correctly.
- [ ] Auto-recharge before paid admission is proven or the missing artifact is explicitly documented and accepted by the operator.
- [ ] `self-free` is proven.
- [ ] `paid-team-capacity` is proven.
- [ ] contributor-earnings path is either proven or blocked with a precisely documented missing prerequisite that the operator resolves before Darryn cutover.
- [ ] Withdrawal request and admin review path is proven.
- [ ] Request-history visibility boundaries are correct.
- [ ] Reserve-floor edits and fail-closed enforcement are correct.
- [ ] Webhook replay/recovery path is understood and safe.

If any line above is not proven with concrete rehearsal evidence, Darryn cutover stays blocked.
