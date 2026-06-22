# API reference: social-content jobs and callbacks

This is the consumer/integrator reference for the Aries AI core API: creating a weekly social-content job, polling its status, approving (or denying) a gated stage, receiving inbound Hermes run callbacks, and the health probes.

Five route groups are documented here in full:

- `POST /api/social-content/jobs` and the legacy `POST /api/marketing/jobs` alias
- `GET /api/social-content/jobs/{jobId}` (status)
- `POST /api/social-content/jobs/{jobId}/approve`
- `POST /api/internal/hermes/runs` (inbound Hermes callback)
- `GET /api/health/db` and `GET /api/health/hermes`

For the exhaustive inventory of UI-facing and operator routes, see [../../ROUTE_MANIFEST.md](../../ROUTE_MANIFEST.md) and [../SYSTEM-REFERENCE.md](../SYSTEM-REFERENCE.md). The route manifest is marketing-dialect-centric: it lists the legacy `/api/marketing/jobs*` routes and does not list the `/api/social-content/*`, `/api/internal/hermes/runs`, or `/api/health/*` routes. This page is the reference for those.

This page describes *what* the surface is. It does not explain *why*. For task walkthroughs, see [Related](#related).

## The two dialects: social-content and marketing

The social-content routes and the legacy marketing routes share the same handlers. The only difference is the `responseDialect` option, which changes a few response field names and the `jobStatusUrl` path.

| | social-content | marketing (legacy) |
|---|---|---|
| Create | `POST /api/social-content/jobs` | `POST /api/marketing/jobs` |
| Status | `GET /api/social-content/jobs/{jobId}` | `GET /api/marketing/jobs/:jobId` |
| Approve | `POST /api/social-content/jobs/{jobId}/approve` | `POST /api/marketing/jobs/:jobId/approve` |
| Job types accepted | `weekly_social_content` only (any requested type is ignored) | `weekly_social_content`, `one_off_post`, `one_off_campaign` |
| Shared handler | `app/api/marketing/jobs/handler.ts` (`handlePostMarketingJobs`) | same |

Prefer the `/api/social-content/*` routes for new integrations. The `/api/marketing/*` routes are the legacy alias.

Authentication and tenant resolution are the same for create, status, and approve: the request resolves a tenant context through `loadTenantContextOrResponse` (session + tenant membership). When the caller has no tenant membership, the response is:

```json
{
  "status": 409,
  "reason": "onboarding_required",
  "message": "Complete tenant onboarding before starting a marketing job."
}
```

(The approve handler uses the same shape with the message `Complete tenant onboarding before approving brand campaigns.`)

---

## POST /api/social-content/jobs

Create a weekly social-content job. Source: `app/api/social-content/jobs/route.ts` -> `handlePostMarketingJobs(req, loader, { responseDialect: 'social-content' })` in `app/api/marketing/jobs/handler.ts`.

The social-content dialect always forces the job type to `weekly_social_content`. Any `jobType` you send is ignored (`resolveRequestedJobType`). Use the legacy `/api/marketing/jobs` route if you need `one_off_post` or `one_off_campaign`.

### Request

You can send either `application/json` or `multipart/form-data`.

JSON body shape:

```json
{
  "jobType": "weekly_social_content",
  "payload": { }
}
```

For `multipart/form-data`, the handler reads fields explicitly (see `parseCreateJobRequest`) and reads file uploads from the `brandAssets` field. Use FormData when you upload brand assets.

The `payload` object carries the brief and the weekly scope. For `weekly_social_content` it runs through `normalizeWeeklySocialContentPayload` (`backend/social-content/payload.ts`), which fills defaults, clamps counts, and redacts tokens.

#### Weekly scope fields

| Field | Alias | Type | Default | Constraint |
|---|---|---|---|---|
| `postWindowDays` | `windowDays` | integer | 7 | clamped 1..14 |
| `staticPostCount` | `staticPostsCount` | integer | 7 | floored at 0 (no upper cap) |
| `storyCount` | `storiesCount` | integer | 1 | floored at 0 (no upper cap) |
| `imageCreativeCount` | `imageCreativesCount` | integer | 6 | clamped 0..6 |
| `videoScriptCount` | `videoScriptsCount` | integer | 1 | floored at 0 (no upper cap) |
| `videoRenderCount` | `renderVideoAfterApproval` (boolean) | integer | 0 | clamped 0..1 |
| `channels` | | string[] | `["meta","instagram"]` | empty falls back to default |
| `forbiddenVisualPatterns` | | string[] | 6-pattern default list | empty falls back to default |

Notes on normalization:

- `postWindowDays` falls back to `windowDays`. Unparseable values become `7`. The clamp bounds (default min 1, max 14) are overridable with the env vars `ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MIN` and `ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MAX`. The handler writes the clamped value to both `postWindowDays` and `windowDays`.
- Only `imageCreativeCount` (max 6) and `videoRenderCount` (max 1) have an upper cap. `staticPostCount`, `storyCount`, and `videoScriptCount` are only floored at 0.
- `videoRenderCount` can be derived from the boolean `renderVideoAfterApproval` when the count is absent: `true` -> 1, `false` -> 0.
- The default `forbiddenVisualPatterns` are: `split-screen`, `before/after`, `side-by-side comparison`, `two-panel layout`, `old way vs new way`, `generic stock office`.
- The handler also writes back-compat snake/plural fields (`staticPostsCount`, `storiesCount`, `imageCreativesCount`, `videoScriptsCount`, `renderVideoAfterApproval`).

#### Brief fields

The create handler also normalizes brief fields such as `brandUrl`/`websiteUrl`, `competitorUrl`, `competitorBrand`, `facebookPageUrl`/`competitorFacebookUrl`, `adLibraryUrl`, `metaPageId`, `primaryGoal`/`goal`, `launchApproverName`/`approverName`, `businessName`, `businessType`, `brandVoice`, `styleVibe`, `offer`, `audience`, `notes`, `visualReferences`, `mustUseCopy`, and `mustAvoidAesthetics`. Missing brief fields are backfilled from the tenant business profile. See `app/api/marketing/jobs/handler.ts` for the exact field list.

#### Token redaction

Before normalization, the payload is sanitized by `sanitizeWeeklySocialContentPayload`:

- Keys whose name looks sensitive (segments matching `token`, `secret`, `auth`, `authorization`, `oauth`, or `apikey`/`api`+`key`) are dropped entirely.
- Token-like string values are rewritten to `[redacted]`: Bearer tokens, OpenAI `sk-` keys, and common provider tokens (`ya29.`, `xox*-`, `gh*_`).
- Sensitive URL query params are stripped: `access_token`, `refresh_token`, `id_token`, `client_secret`, `api_key`, `token`, `key`, `signature`, `sig`.

### Response

Success is `202 Accepted`. social-content dialect body:

| Field | Description |
|---|---|
| `social_content_job_status` | job status (`result.status`) |
| `social_content_stage` | current stage (`result.currentStage`) |
| `jobId` | created job id |
| `jobType` | always `weekly_social_content` |
| `approvalRequired` | boolean |
| `approval` | approval descriptor (or null) |
| `reason` | status reason |
| `message` | human-readable message |
| `jobStatusUrl` | `/social-content/status?jobId=<encoded>` |

The marketing dialect returns the same data with `marketing_job_status`, `marketing_stage`, and a `jobStatusUrl` of `/marketing/job-status?jobId=<encoded>`.

### Status codes

| Code | When | Body |
|---|---|---|
| 202 | created | create response above |
| 400 | unsupported job type | `{ "error": "unsupported_job_type:<value>" }` |
| 400 | missing required fields | `{ "error": "missing_required_fields:<...>" }` |
| 400 | bad competitor URL | `{ "error": "<COMPETITOR_URL_SOCIAL_ERROR \| COMPETITOR_URL_INVALID_ERROR>" }` |
| 409 | no tenant membership | onboarding_required (see above) |
| 422 | one-off brief invalid (marketing dialect only) | `{ "error": "one_off_brief_invalid", "fieldErrors": { } }` |
| 422 | brand kit error | `{ "error": "brand_kit_<...>" }` |
| 501 | no workflow for route | `{ "error": "workflow_missing_for_route:<...>", "reason": "workflow_missing_for_route" }` |
| 500 | unhandled | `{ "error": "<message>" }` |

Errors from the orchestrator may also be remapped by `mapAriesExecutionError`.

### Example: create a weekly job (JSON)

```bash
curl -X POST https://your-host/api/social-content/jobs \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d '{
    "jobType": "weekly_social_content",
    "payload": {
      "brandUrl": "https://example.com",
      "primaryGoal": "Drive bookings",
      "postWindowDays": 7,
      "staticPostCount": 7,
      "storyCount": 1,
      "imageCreativeCount": 6,
      "videoScriptCount": 1,
      "videoRenderCount": 0,
      "channels": ["meta", "instagram"]
    }
  }'
```

### Example: create with brand asset uploads (FormData)

```bash
curl -X POST https://your-host/api/social-content/jobs \
  -H "Cookie: <your session cookie>" \
  -F "brandUrl=https://example.com" \
  -F "primaryGoal=Drive bookings" \
  -F "postWindowDays=7" \
  -F "channels=meta" \
  -F "channels=instagram" \
  -F "brandAssets=@./logo.png" \
  -F "brandAssets=@./brand-guide.pdf"
```

---

## GET /api/social-content/jobs/{jobId}

Read a job's status. Source: `app/api/social-content/jobs/[jobId]/route.ts` -> `handleGetMarketingJobStatus(jobId, undefined, { responseDialect: 'social-content' })` in `app/api/marketing/jobs/[jobId]/handler.ts`.

### Response

Success is `200 OK` with header `x-cache: <cacheStatus>`. The body is large and built by `buildResponsePayload`. The social-content dialect key fields:

| Field | Notes |
|---|---|
| `jobId` | |
| `jobType` | `weekly_social_content` |
| `social_content_job_state` | |
| `social_content_job_status` | |
| `social_content_stage` | |
| `social_content_stage_status` | |
| `approvalRequired`, `approval` | gate state |
| `summary`, `stageCards`, `timeline`, `statusHistory` | progress views |
| `artifacts`, `contentBrief`, `dashboard`, `calendarEvents` | content views |
| `workflowState`, `publishConfig`, `nextStep`, `needs_attention` | control views |
| `postWindow`, `durationDays`, `plannedPostCount`, `createdPostCount` | scope counts |
| `reason`, `message` | |

The marketing dialect uses `marketing_job_state`, `marketing_job_status`, `marketing_stage`, and `marketing_stage_status` instead of the `social_content_*` names. For the full shape, read `app/api/marketing/jobs/[jobId]/handler.ts`.

### Status codes

| Code | When | Body |
|---|---|---|
| 200 | found | status payload (header `x-cache`) |
| 404 | not found | `{ "error": "Marketing job not found.", "reason": "marketing_job_not_found" }` |
| 409 | no tenant membership | onboarding_required |
| 500 | unhandled | error body |

### Example

```bash
curl https://your-host/api/social-content/jobs/<jobId> \
  -H "Cookie: <your session cookie>"
```

---

## POST /api/social-content/jobs/{jobId}/approve

Approve or deny a gated stage and resume the job. Source: `app/api/social-content/jobs/[jobId]/approve/route.ts` -> `handleApproveMarketingJob(jobId, req, undefined, { responseDialect: 'social-content' })` in `app/api/marketing/jobs/[jobId]/approve/handler.ts`.

### Request

JSON body fields:

| Field | Type | Notes |
|---|---|---|
| `approvedBy` | string | required for approve/deny (server enforces) |
| `approved` | boolean | defaults to `true` when omitted or non-boolean |
| `approvalStep` | string | one of the approval steps below |
| `approvedStages` | string[] | subset of `research`, `strategy`, `production`, `publish` |
| `approvalId` | string | targets a specific checkpoint |
| `resumePublishIfNeeded` | boolean | |
| `denialReasonCode` | string | used when `approved: false` |
| `denialNote` / `note` | string | denial note (`denialNote` preferred) |
| `publishConfig` | object | `{ platforms, livePublishPlatforms, videoRenderPlatforms }` |

Actor identity beyond `approvedBy` (user id, role, tenant slug) is derived server-side from tenant context and is never read from the request body.

`publishConfig` uses camelCase in the request. The handler maps it to snake_case before the orchestrator: `livePublishPlatforms` -> `live_publish_platforms`, `videoRenderPlatforms` -> `video_render_platforms`. `platforms` is passed through.

Valid `approvalStep` values (`SocialContentApprovalStep`) and the stage each maps to:

| `approvalStep` | Stage |
|---|---|
| `approve_weekly_plan` | strategy |
| `approve_post_copy` | production |
| `approve_image_creatives` | production |
| `approve_video_script` | production |
| `approve_video_render` | production |
| `approve_publish` | publish |

`approved: true` calls `approveSocialContentJob`; `approved: false` calls `denySocialContentJob`.

### Response

Built by `buildApproveResponse`. Base fields:

| Field | Notes |
|---|---|
| `approval_status` | for social-content, `resumed`/`denied` are normalized to `submitted` |
| `jobId` | |
| `resumedStage` | stage resumed (or null) |
| `completed` | boolean |
| `approvalId` | |
| `reason` | defaults to `unknown` |
| `jobStatusUrl` | `/social-content/status?jobId=<encoded>` |

The social-content dialect adds `social_content_approval_status` (same value as `approval_status`) and `jobType: "weekly_social_content"`.

### Status codes

| Code | When | Body / reason |
|---|---|---|
| 202 | social-content, status `resumed` or `denied` | approve response |
| 200 | marketing, status `resumed` / `already_resolved` / `denied` | approve response |
| 400 | other / `missing_approved_by` | `missing_approved_by` -> `{ "error": "approvedBy is required.", "reason": "missing_approved_by" }` |
| 404 | not found / tenant mismatch | `{ "error": "...", "reason": "marketing_job_not_found" }` |
| 409 | no active checkpoint | `reason: "approval_not_available"` |
| 409 | checkpoint stage not selected | `reason: "approval_stage_not_selected"` |
| 409 | no tenant membership | onboarding_required |
| 501 | no workflow for route | `reason: "workflow_missing_for_route"` |
| 500 | unhandled | error body |

### Example: approve the weekly plan

```bash
curl -X POST https://your-host/api/social-content/jobs/<jobId>/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d '{
    "approvedBy": "operator@example.com",
    "approved": true,
    "approvalStep": "approve_weekly_plan"
  }'
```

### Example: deny with a reason

```bash
curl -X POST https://your-host/api/social-content/jobs/<jobId>/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d '{
    "approvedBy": "operator@example.com",
    "approved": false,
    "approvalStep": "approve_post_copy",
    "denialReasonCode": "off_brand",
    "denialNote": "Tone is too casual; revise captions."
  }'
```

---

## POST /api/internal/hermes/runs

Inbound callback from Hermes when a run advances, pauses for approval, or completes. Source: `app/api/internal/hermes/runs/route.ts`. This is a server-to-server endpoint, not a browser route.

### Authentication (two layers)

Layer 1, `verifyInternalCallbackRequest` (`lib/internal-callback-auth.ts`): a shared bearer secret.

```
Authorization: Bearer <INTERNAL_API_SECRET>
```

| Condition | Code | reason |
|---|---|---|
| `INTERNAL_API_SECRET` env unset | 503 | `internal_api_secret_not_configured` |
| no/invalid `Authorization: Bearer` header | 401 | `missing_internal_callback_secret` |
| wrong secret | 403 | `invalid_internal_callback_secret` |

The secret comparison uses `timingSafeEqual`.

Layer 2, `verifyCallbackToken`: a per-run token sent in the JSON body field `callback_token` (not a header). The token is SHA-256 hashed (`hashCallbackToken`, hex digest) and looked up in the `oauth_callback_tokens` table by `token_hash`, then the row's `aries_run_id` must match the payload's `aries_run_id`.

| Condition | Code | reason |
|---|---|---|
| `callback_token` missing/empty | 403 | `missing_callback_token` |
| token not found, hash mismatch, or run-id mismatch | 403 | `invalid_callback_token` |

### Flow

1. `verifyInternalCallbackRequest` (bearer secret).
2. Parse JSON. On failure: `400 { "status": "error", "reason": "invalid_json" }`.
3. `parseHermesRunCallbackPayload`. On null: `400 { "status": "error", "reason": "invalid_hermes_callback_payload" }`. This returns null when `aries_run_id` is missing or malformed, when the Zod schema fails, or when `protocol_version` is present and its major version does not match.
4. `verifyCallbackToken` (per-run token).
5. `handleHermesRunCallback`.

### Payload

Schema: `HermesRunCallbackPayloadSchema` (`packages/aries-hermes-protocol/src/schemas.ts`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | string | yes | idempotency key; non-empty, must contain a non-whitespace char |
| `aries_run_id` | string | yes | `arun_<uuid>`; pre-validated before Zod |
| `callback_token` | string | yes | per-run auth token (read from body) |
| `status` | enum | yes | see CallbackStatus below |
| `hermes_run_id` | string | no | |
| `stage` | enum | no | granular Hermes step (CallbackStage) |
| `output` | object or array of objects | no | stage outputs |
| `artifacts` | array | no | |
| `approval` | object | no | present when `status === "requires_approval"` |
| `error` | object | no | `{ code?, message, retryable? }` |
| `protocol_version` | semver string | no | major-version mismatch rejected (parse returns null). Current `PROTOCOL_VERSION` is `1.1.1`. |

`CallbackStatus` enum: `running`, `requires_approval`, `completed`, `failed`, `cancelled`, `stopped`.

The `approval` object (`CallbackApprovalSchema`):

| Field | Type | Required |
|---|---|---|
| `stage` | ApprovalStage enum | yes |
| `workflow_step_id` | string | yes |
| `prompt` | string | yes |
| `approval_step` | ApprovalStep enum | no |
| `resume_token` | string | no |

`ApprovalStage` enum: `strategy`, `production`, `publish` (plus legacy `plan`, `creative`, `video`).

`ApprovalStep` enum: `approve_weekly_plan`, `approve_post_copy`, `approve_image_creatives`, `approve_video_script`, `approve_video_render`, `approve_publish`.

### Response

Success:

```json
{
  "status": "<result.status>",
  "ariesRunId": "<aries_run_id>",
  "duplicate": false
}
```

Errors are shaped `{ "status": "error", "reason": "<reason>" }`. The `errorStatus` mapping:

| reason | Code |
|---|---|
| `execution_run_not_found` | 404 |
| `execution_run_locked` | 409 |
| anything else | 400 |

### Example

```bash
curl -X POST https://your-host/api/internal/hermes/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  -d '{
    "event_id": "evt_01HZX...",
    "aries_run_id": "arun_3f9b2c10-...",
    "callback_token": "<per-run token>",
    "status": "requires_approval",
    "stage": "plan_review",
    "protocol_version": "1.1.1",
    "approval": {
      "stage": "strategy",
      "approval_step": "approve_weekly_plan",
      "workflow_step_id": "step_plan_review",
      "prompt": "Review the weekly plan."
    }
  }'
```

---

## Health endpoints

### GET /api/health/db

Source: `app/api/health/db/route.ts`. Probes `SELECT 1` with a 1-second cache (`HEALTH_CACHE_TTL_MS = 1000`).

Success `200`:

```json
{
  "status": "ok",
  "poolStats": { },
  "roundTripMs": 3,
  "cacheAgeMs": 0,
  "cached": false
}
```

On failure `503`:

```json
{
  "status": "error",
  "error": "<message>",
  "poolStats": { }
}
```

### GET /api/health/hermes

Source: `app/api/health/hermes/route.ts`. Calls `probeHermesSocialContentRuntime(process.env)` and returns the report. Status is `200` when `report.ok` is true, otherwise `503`.

```bash
curl https://your-host/api/health/db
curl https://your-host/api/health/hermes
```

---

## Defaults and limits quick reference

| Constant | Value | Source |
|---|---|---|
| `postWindowDays` default | 7 | `backend/social-content/types.ts` (`DEFAULT_SOCIAL_CONTENT_COUNTS`) |
| `postWindowDays` clamp | 1..14 | `backend/social-content/payload.ts` |
| `staticPostCount` default | 7 | `backend/social-content/types.ts` (`DEFAULT_SOCIAL_CONTENT_COUNTS`) |
| `storyCount` default | 1 | `backend/social-content/types.ts` (`DEFAULT_SOCIAL_CONTENT_COUNTS`) |
| `imageCreativeCount` default / max | 6 / 6 | default `backend/social-content/types.ts`; max `backend/social-content/defaults.ts` |
| `videoScriptCount` default | 1 | `backend/social-content/types.ts` (`DEFAULT_SOCIAL_CONTENT_COUNTS`) |
| `videoRenderCount` default / max | 0 / 1 | default `backend/social-content/types.ts`; max `backend/social-content/defaults.ts` |
| `channels` default | `["meta","instagram"]` | `backend/social-content/types.ts` |
| `PROTOCOL_VERSION` | `1.1.1` | `packages/aries-hermes-protocol/src/schemas.ts` |
| Redaction value | `[redacted]` | `backend/social-content/payload.ts` |

Environment variables: `INTERNAL_API_SECRET`, `ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MIN`, `ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MAX`.

To run the create/approve flow tests (covers `tests/marketing-job-route.smoke.test.ts` and `tests/social-content-approve-route.test.ts`):

```bash
npm run validate:social-content
```

## Related

- [How to generate and approve a week of social content](../how-to/generate-and-approve-a-week.md)
- [How to connect Aries to a Hermes execution endpoint](../how-to/integrate-hermes.md)
- [System reference](../SYSTEM-REFERENCE.md)
