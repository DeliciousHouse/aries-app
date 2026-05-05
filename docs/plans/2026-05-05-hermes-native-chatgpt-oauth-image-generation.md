# Hermes-Native Weekly Media Request Plan

> Repo: `aries-app`
> Date: 2026-05-05
> Status: implemented in-progress on this branch

## Goal

Make weekly social-content image/video generation Hermes-native.

Aries must not broker ChatGPT/OpenAI OAuth for this workflow. Hermes already owns the connected ChatGPT/OpenAI-capable agent account. Aries should submit abstract weekly media requests to Hermes, Hermes should execute them asynchronously, and Hermes callbacks should update Aries runtime state.

## Current repo truth

- Weekly social content already submits Hermes runs through `backend/marketing/ports/hermes.ts`.
- Hermes callbacks already land at `POST /api/internal/hermes/runs` and flow through `backend/execution/hermes-callbacks.ts` and `backend/marketing/hermes-callbacks.ts`.
- The broken part was the weekly-media contract layered on top:
  - `backend/marketing/orchestrator.ts` blocked media requests on an Aries-side OpenAI connection.
  - `backend/social-content/workflow-request.ts` serialized `media_provider` and `auth_mode: 'user_oauth'` fields.
  - docs/tests claimed tenants must connect ChatGPT/OpenAI in Aries before weekly media generation.

## Correct architecture

```text
Client
  -> POST /api/social-content/jobs
  -> Aries validates request and creates runtime job
  -> Aries submits social_content_weekly run to Hermes
       callback_url = ${APP_BASE_URL}/api/internal/hermes/runs
       media_requests = abstract generation intent only

Hermes
  -> resolves its own connected ChatGPT/OpenAI-capable agent account
  -> executes image/video work
  -> POSTs authenticated callbacks back to Aries

Aries
  -> validates INTERNAL_API_SECRET bearer callback
  -> persists stage/output/artifact state
  -> renders weekly posts, creatives, approvals, and failures in UI
```

## Contract rules

### Aries -> Hermes weekly request

- Keep workflow key/version:
  - `workflow_key: social_content_weekly`
  - `workflow_version: 2026-05-social-content-weekly-v1`
- Keep weekly defaults:
  - `window_days: 7`
  - `static_post_count: 3`
  - `image_creative_count: up to 2`
  - `video_script_count: 1`
  - `video_render_count: 0` unless explicitly requested
- Serialize abstract media requests only.
- Include explicit image `target_channels` so Hermes does not have to infer posting context only from outer scope.
- Do not serialize any Aries OpenAI connection reference.
- Do not serialize `tenant_id` / `user_id` auth hints for media provider selection.
- Do not serialize raw token-like values.

Target request shape:

```json
{
  "workflow_key": "social_content_weekly",
  "workflow_version": "2026-05-social-content-weekly-v1",
  "callback_url": "https://aries.example.com/api/internal/hermes/runs",
  "input": {
    "scope": {
      "window_days": 7,
      "static_post_count": 3,
      "image_creative_count": 2,
      "video_script_count": 1,
      "video_render_count": 1,
      "channels": ["meta", "instagram"]
    },
    "media_requests": [
      {
        "type": "image.generate",
        "aspect_ratio": "4:5",
        "count": 2,
        "target_channels": ["meta", "instagram"],
        "creative_briefs": ["..."]
      },
      {
        "type": "video.generate",
        "aspect_ratio": "9:16",
        "count": 1,
        "requires_human_approval": true,
        "script_id": "weekly_primary"
      }
    ]
  }
}
```

### Hermes -> Aries callback

- Preserve existing authenticated async callback flow.
- Preserve idempotent callback application in Aries runtime.
- Preserve partial-progress handling for weekly artifacts and approvals.

## Non-goals

- Do not remove generic Aries OpenAI OAuth support from unrelated integration surfaces.
- Do not add provider-selection logic to weekly social-content payloads.
- Do not poll Hermes to terminal completion in production.
- Do not reintroduce Lobster/OpenClaw as the default weekly media path.

## Implementation checklist

### 1. Runtime contract

- Remove Aries-side OpenAI connection lookup/gating from `backend/marketing/orchestrator.ts`.
- Update `backend/social-content/workflow-request.ts` to emit abstract `media_requests` only.
- Keep `backend/marketing/ports/hermes.ts` async submit behavior unchanged.

### 2. Status and operator copy

- Update `backend/marketing/jobs-status.ts` so `needs_connection` copy points at Hermes media setup rather than Aries OAuth.
- Remove doc copy that tells operators to connect ChatGPT/OpenAI in Aries for weekly media generation.

### 3. Docs and env guidance

- Rewrite `.env.example`, `README.md`, `SETUP.md`, `DOCKER.md`, `PRODUCTION_HANDOFF.md`, `docs/SYSTEM-REFERENCE.md`, and `TOOLS.md` to say:
  - weekly social content is Hermes-native
  - Hermes owns ChatGPT/OpenAI auth for weekly media work
  - text-only planning still works with media disabled
- Keep generic OpenAI OAuth env vars documented where they remain relevant outside weekly social content.

### 4. Tests

- Update `tests/social-content-weekly-defaults.test.ts`:
  - no `media_provider`
  - no `auth_mode: 'user_oauth'`
  - no serialized Aries OpenAI connection id
- Update `tests/marketing-execution-port.test.ts`:
  - Hermes request body contains abstract media requests only
- Update `tests/marketing-job-route.smoke.test.ts`:
  - weekly media requests are accepted without Aries-side OpenAI connection state
  - expired Aries OpenAI connections do not block Hermes-owned weekly media generation
- Update `tests/docs-social-content-guidance.test.ts` to reflect the new operator guidance.

## Validation

Run at minimum:

```bash
npx tsx --test tests/social-content-weekly-defaults.test.ts
npx tsx --test tests/marketing-execution-port.test.ts
npx tsx --test tests/marketing-job-route.smoke.test.ts
npx tsx --test tests/docs-social-content-guidance.test.ts
```

Then run broader repo validation if the targeted suite passes:

```bash
npm run verify
```

## Acceptance criteria

- Weekly social-content media requests no longer depend on Aries-side ChatGPT/OpenAI OAuth state.
- Weekly Hermes payloads contain abstract media generation intent only.
- Hermes async callback behavior remains the execution model.
- Runtime/status copy tells operators to fix Hermes media setup, not Aries OAuth.
- Docs no longer claim weekly media generation requires connecting ChatGPT/OpenAI in Aries.
- Tests prove token-like values and Aries OpenAI connection ids are not serialized into weekly Hermes request payloads.
