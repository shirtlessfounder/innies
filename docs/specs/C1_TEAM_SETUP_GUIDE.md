# C1 Team Setup Guide (Innies + OpenClaw)

Simple flow for each teammate:

1. Contribute Claude OAuth token.
2. Receive Innies access details.
3. Connect OpenClaw to Innies.

## 1) Teammate Contributes Claude OAuth Token

Teammate sends admin a Claude setup-token/OAuth token (`sk-ant-oat01-...`) using your secure channel.

Admin adds that token into Innies pool:

```bash
export INNIES_BASE_URL="http://localhost:4010"

curl -sS -X POST "$INNIES_BASE_URL/v1/admin/token-credentials" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Idempotency-Key: 12345678901234567890123456789012" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId":"818d0cc7-7ed2-469f-b690-a977e72a921d",
    "provider":"anthropic",
    "authScheme":"bearer",
    "accessToken":"sk-ant-oat01-REDACTED",
    "expiresAt":"2026-12-31T00:00:00Z"
  }'
```

Expected success:
- `{"ok":true,...}`

## 2) Teammate Receives Innies Stuff

Admin sends each teammate:

1. `INNIES_BASE_URL` (reachable URL, not localhost unless same machine)
2. Personal `BUYER_TOKEN`
3. Default model ID: `claude-opus-4-6`
4. Org ID for reference: `818d0cc7-7ed2-469f-b690-a977e72a921d`

Do not share:
- `ADMIN_TOKEN`
- raw seller OAuth token

## 3) Teammate Sets Up OpenClaw on Innies

Run:

```bash
export INNIES_BASE_URL="http://localhost:4010"
export BUYER_TOKEN="paste_buyer_token_here"

openclaw onboard \
  --auth-choice custom-api-key \
  --custom-base-url "$INNIES_BASE_URL/v1" \
  --custom-model-id "claude-opus-4-6" \
  --custom-api-key "$BUYER_TOKEN" \
  --custom-compatibility anthropic
```

Then verify with a quick proxy test:

```bash
export INNIES_BASE_URL="http://localhost:4010"
export BUYER_TOKEN="paste_buyer_token_here"

curl -i -sS -X POST "$INNIES_BASE_URL/v1/proxy/v1/messages" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Idempotency-Key: 12345678901234567890123456789013" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "provider":"anthropic",
    "model":"claude-opus-4-6",
    "streaming":false,
    "payload":{
      "model":"claude-opus-4-6",
      "max_tokens":32,
      "messages":[{"role":"user","content":"Reply with one word: hi"}]
    }
  }'
```

Success = HTTP `200`.

## Troubleshooting

1. `403 forbidden`: wrong/missing `BUYER_TOKEN`.
2. `model_invalid`: model not enabled in `in_model_compatibility_rules`.
3. `401 unauthorized`: contributed OAuth token invalid/expired.
4. `capacity_unavailable`: no eligible credential currently routable.
