# How to connect Aries to a Hermes execution endpoint

Point Aries at a Hermes gateway, wire the authenticated callback route, and confirm the link before you run a workflow.

Aries does not execute workflows. It submits them to Hermes and ingests results back through a callback route protected by two layers of auth. This guide covers the env vars Aries needs to submit runs, the inbound callback route's two-layer auth, and how to verify the connection. For why the boundary is split this way (and why the outbound and inbound secrets are different), read [Hermes callback execution boundary](../ARCHITECTURE.md) instead.

## Prerequisites

- A running Hermes gateway you can reach over HTTP, plus its `API_SERVER_KEY` value.
- The Aries app deployed with a Postgres database (the callback layer reads the `oauth_callback_tokens` table).
- Shell access to edit the Aries `.env` file. Copy `.env.example` if you have not already.
- Basic familiarity with environment variables and bearer-token auth.

## Steps

### 1. Select Hermes as the execution provider

Set both provider switches in your `.env`:

```bash
ARIES_EXECUTION_PROVIDER=hermes
ARIES_MARKETING_EXECUTION_PROVIDER=hermes
```

Expected result: Aries routes run submissions through the Hermes port (`backend/marketing/ports/hermes.ts`) rather than any other provider.

### 2. Set the four required submission vars

Aries refuses to submit a run unless all four of these are present. The check lives in `configurationError()` in `backend/marketing/ports/hermes.ts`; a missing value yields `hermes_gateway_not_configured`.

```bash
# Outbound: where Aries sends runs, and the key it presents.
HERMES_GATEWAY_URL=http://127.0.0.1:8642
HERMES_API_SERVER_KEY=replace-with-the-value-of-API_SERVER_KEY-from-your-hermes-env

# Inbound: secret for the callback route, and the base URL Aries hands to Hermes.
INTERNAL_API_SECRET=your-internal-callback-secret
APP_BASE_URL=https://your-app.example.com
```

Notes:

- `HERMES_GATEWAY_URL` has its trailing slashes stripped before use. Aries submits to `POST <HERMES_GATEWAY_URL>/v1/runs` with header `Authorization: Bearer <HERMES_API_SERVER_KEY>`.
- `INTERNAL_API_SECRET` and `HERMES_API_SERVER_KEY` are deliberately separate secrets. The first is inbound (Hermes -> Aries), the second is outbound (Aries -> Hermes). See [the architecture doc](../ARCHITECTURE.md) for the rationale.
- `APP_BASE_URL` is used to build the callback URL Aries sends with every submission: `<APP_BASE_URL>/api/internal/hermes/runs`.

Expected result: Aries can now build a valid submission and a valid callback URL.

### 3. (Optional) Route marketing stages to separate Hermes profiles

The weekly marketing pipeline can split execution across three Hermes profiles. Each stage var falls back to the main `HERMES_GATEWAY_URL` / `HERMES_API_SERVER_KEY` when left blank, so a single-gateway deployment can leave all six empty.

```bash
HERMES_RESEARCH_GATEWAY_URL=
HERMES_RESEARCH_API_SERVER_KEY=
HERMES_STRATEGIST_GATEWAY_URL=
HERMES_STRATEGIST_API_SERVER_KEY=
HERMES_CONTENT_GATEWAY_URL=
HERMES_CONTENT_API_SERVER_KEY=
```

Stage-to-var mapping (from `backend/marketing/ports/hermes.ts`):

| Stage | Gateway var | Key var |
|---|---|---|
| Research | `HERMES_RESEARCH_GATEWAY_URL` | `HERMES_RESEARCH_API_SERVER_KEY` |
| Strategy + publish | `HERMES_STRATEGIST_GATEWAY_URL` | `HERMES_STRATEGIST_API_SERVER_KEY` |
| Production | `HERMES_CONTENT_GATEWAY_URL` | `HERMES_CONTENT_API_SERVER_KEY` |

Documented ports for a multi-gateway setup: research/default `8642`, strategist `8654`, content `8655`.

Expected result: each stage submits to its own gateway with its own key, or falls back to the main pair when blank.

### 4. (Optional) Tune session, timeout, and poll behaviour

```bash
HERMES_SESSION_KEY=main
HERMES_RUN_TIMEOUT_MS=1200000
HERMES_POLL_INTERVAL_MS=
```

- `HERMES_SESSION_KEY` names the Hermes session. `.env.example` ships `main`. Note: if the var is unset, the code default in `sessionKey()` is `marketing`, so set it explicitly to avoid surprises.
- `HERMES_RUN_TIMEOUT_MS` is the per-run terminal-poll budget. `.env.example` ships `1200000` (20 minutes); if the var is unset, the code default in `pollRunUntilTerminal()` is `120000` (2 minutes).
- `HERMES_POLL_INTERVAL_MS` blank uses the built-in default (`2000`ms), clamped to a `50`ms floor.

Expected result: submissions carry your chosen session key and timeout.

### 5. Keep the reconciler running

This is the key operational fact: Hermes `/v1/runs` is a **polled** API. The gateway executes asynchronously and does **not** POST your `callback_url`. A durable reconciler side-process polls in-flight runs to completion and feeds the same callback handler internally. Do not expect Hermes itself to call your route. See [the architecture doc](../ARCHITECTURE.md) for the full model.

```bash
ARIES_RECONCILER_ENABLED=1
ARIES_RECONCILER_INTERVAL_MS=60000
# HERMES_RECONCILER_POLL_TIMEOUT_MS=15000
```

- `ARIES_RECONCILER_ENABLED=1` is the default. Leave it on, or runs never advance to completion.
- `ARIES_RECONCILER_INTERVAL_MS` defaults to `60000` (60s).
- `HERMES_RECONCILER_POLL_TIMEOUT_MS` is the per-poll Hermes `GET` timeout, default `15000` (15s).

Expected result: finished runs are reconciled and their state advances even though the gateway never calls back.

### 6. Understand the inbound callback route's two-layer auth

The route `POST /api/internal/hermes/runs` (`app/api/internal/hermes/runs/route.ts`) is the trusted ingestion boundary for run results. You do not call it by hand, but you must configure both layers correctly so the reconciler (and any direct caller) can pass.

**Layer 1, transport.** `verifyInternalCallbackRequest` (`lib/internal-callback-auth.ts`) checks the request's `Authorization: Bearer <token>` against `INTERNAL_API_SECRET` using a constant-time compare.

**Layer 2, per-run token.** Every submission includes a `callback_auth` object plus a per-run `callback_token` (32 random bytes, hex). At submission time Aries stores its SHA-256 hash:

```sql
INSERT INTO oauth_callback_tokens (token_hash, aries_run_id, tenant_id)
VALUES ($1, $2, $3)
ON CONFLICT (token_hash) DO NOTHING
```

On callback, `verifyCallbackToken` reads `callback_token` from the body, hashes it with SHA-256, and looks it up:

```sql
SELECT token_hash, aries_run_id FROM oauth_callback_tokens WHERE token_hash = $1 LIMIT 1
```

It then timing-safe compares the hash and requires the row's `aries_run_id` to match the payload's `aries_run_id`.

The `callback_auth` object Aries sends to Hermes looks like this:

```json
{
  "type": "internal_api_secret_bearer",
  "secret_ref": "INTERNAL_API_SECRET",
  "callback_token": "<per-run plaintext token>"
}
```

The inbound callback body Aries expects (validated by `parseHermesRunCallbackPayload` in `backend/execution/hermes-callbacks.ts`):

- Required: `aries_run_id` (must match `^arun_<uuid>$`), `event_id`, `status`, plus `callback_token` for layer 2.
- Optional: `hermes_run_id`, `stage`, `output`, `approval`, `error`, `protocol_version`.
- `status` is one of: `running`, `requires_approval`, `completed`, `failed`, `cancelled`, `stopped`.
- `approval` object: `stage`, `approval_step`, `workflow_step_id`, `prompt`, `resume_token`.
- `error` object: `code`, `message`, `retryable`.
- Correlation: `hermes_run_id` must equal the stored `external_run_id`. Duplicate `event_id` values are deduped (idempotent).

A success response is `{ "status": ..., "ariesRunId": ..., "duplicate": ... }`.

Expected result: only callbacks that present the right transport secret **and** a valid per-run token reach `handleHermesRunCallback`.

## Verification

### Check the health endpoint

```bash
curl -i http://localhost:3000/api/health/hermes
```

`GET /api/health/hermes` (`app/api/health/hermes/route.ts`) runs `probeHermesSocialContentRuntime(process.env)` and returns the report JSON. HTTP `200` means `report.ok` is true; `503` means the runtime contract is not satisfied. Read the JSON body for the failing field.

### Confirm the transport layer rejects bad auth

```bash
curl -i -X POST http://localhost:3000/api/internal/hermes/runs \
  -H 'Content-Type: application/json' \
  -d '{}'
```

With no `Authorization` header you should get `401 missing_internal_callback_secret`. This proves the route is live and layer 1 is enforcing. (Do not send a real bearer token from your shell history; this check is only to confirm rejection behaviour.)

### Submit a real run

Trigger a workflow through the normal Aries UI or API. A correctly wired endpoint produces a `run_id` in the Hermes response (absence yields `hermes_gateway_response_invalid`), and within one reconciler interval the run advances toward `completed`. Aries polls status with `GET <HERMES_GATEWAY_URL>/v1/runs/<runId>`.

## Troubleshooting

### Submission fails with `hermes_gateway_not_configured`

One of the four required vars is missing or blank: `HERMES_GATEWAY_URL`, `HERMES_API_SERVER_KEY`, `INTERNAL_API_SECRET`, `APP_BASE_URL`. Set all four (Step 2) and restart.

### Submission fails with `hermes_gateway_response_invalid`

Hermes accepted the request but the JSON response had no `run_id`. Check that `HERMES_GATEWAY_URL` points at a real Hermes `/v1/runs` endpoint and that `HERMES_API_SERVER_KEY` matches the gateway's `API_SERVER_KEY`.

### Callback returns `503 internal_api_secret_not_configured`

`INTERNAL_API_SECRET` is unset on the Aries side. Set it and restart the app.

### Callback returns `401 missing_internal_callback_secret`

The request had no `Authorization` header, or it was not a well-formed `Bearer <token>`. The caller must send `Authorization: Bearer <INTERNAL_API_SECRET>`.

### Callback returns `403 invalid_internal_callback_secret`

The bearer token did not match `INTERNAL_API_SECRET`. The outbound side (Hermes env, or the reconciler) and the inbound side disagree on the secret. Make them equal.

### Callback returns `400 invalid_json` or `400 invalid_hermes_callback_payload`

The body was not valid JSON, or it failed `parseHermesRunCallbackPayload`. Confirm all required fields are present and that `aries_run_id` matches `^arun_<uuid>$`.

### Callback returns `403 missing_callback_token` or `403 invalid_callback_token`

Layer 2 failed. `missing_callback_token` means the body had no `callback_token`. `invalid_callback_token` means the SHA-256 hash was not found in `oauth_callback_tokens`, or its stored `aries_run_id` did not match the payload. Note: the hash is only persisted when the run's `tenant_id` parses to a positive integer, so a submission without a valid tenant will never have a stored token to match.

### Callback returns `404 execution_run_not_found` or `409 execution_run_locked`

`handleHermesRunCallback` could not find the run (`404`) or the run record was locked by a concurrent write (`409`). For `409`, the reconciler retries on its next sweep.

### Runs never complete even though Hermes finished them

Confirm `ARIES_RECONCILER_ENABLED=1`. The gateway does not call your callback route; the reconciler does the driving. If it is disabled, in-flight runs stall.

## Advanced flags (not in `.env.example`)

These exist in `backend/marketing/ports/hermes.ts` but are not standard config. Do not rely on them in production setups:

- `HERMES_POLL_BRIDGE_ENABLED` (in-process fallback bridge; on unless set to `0`/`false`).
- `HERMES_SYNC_POLL_FOR_TESTS` (test-only synchronous polling).

## Related

- [Architecture and the Hermes execution boundary](../ARCHITECTURE.md)
- [API reference: social-content jobs and callbacks](../reference/api-jobs-and-callbacks.md)
- [Security model](../SECURITY_MODEL.md)
