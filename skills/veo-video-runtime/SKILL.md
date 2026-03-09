---
name: veo-video-runtime
description: Generate and monitor Vertex AI Veo text-to-video jobs using the Vertex AI generative video API. Use when creating text-to-video requests, polling long-running operations until completion, collecting output URIs, and applying bounded section-only repairs for request/polling failures without redesigning validated artifacts.
---

# Veo Video Runtime (Vertex AI)

Use this skill to run Veo text-to-video generation against Vertex AI and normalize output metadata for downstream pipelines.

## Fixed Runtime Contract

- Provider: Vertex AI (Google Cloud)
- Primary mode: **text-to-video first**
- API host: `https://{LOCATION}-aiplatform.googleapis.com`
- Publisher path prefix: `publishers/google/models/veo`
- Authentication: OAuth2 Bearer token from `gcloud auth print-access-token` or equivalent ADC flow
- Never redesign validated onboarding/marketing artifacts.
- Apply bounded, section-only repair; max repair attempts after first failure: **3**.

## Required Request Pattern (Text-to-Video First)

1. Build a `generateVideos` request from text prompt input.
2. Keep generation parameters explicit (for example duration/aspect ratio/sample count when required by active model version).
3. Submit generation request and capture:
   - HTTP status
   - response body
   - long-running operation name
4. Treat missing operation name as hard failure.

## Long-Running Operation Polling

After submit, poll operation status using operation `name` until terminal state:

- Poll endpoint pattern: `GET https://{LOCATION}-aiplatform.googleapis.com/v1/{operationName}`
- Terminal success: `done=true` and no `error`
- Terminal failure: `done=true` with `error`
- Non-terminal: `done=false`; continue with backoff

Polling policy:
- Start interval: 5s
- Backoff: exponential up to 30s max interval
- Max total wait per job: 30 minutes (or caller override)
- Record every poll attempt (`status`, `done`, `error/message` when present)

## Output Artifact Normalization

On successful completion, normalize video outputs into a stable metadata object:

- `provider`: `vertex-ai`
- `model`: resolved model id used for generation
- `operationName`: full LRO name
- `prompt.text`: source text prompt
- `artifacts[]` with one record per generated video:
  - `id` (deterministic local id like `video-1`)
  - `mimeType` (default `video/mp4` when absent)
  - `uri` (prefer GCS or HTTPS URI from response)
  - `durationSeconds` (number or `null`)
  - `width` / `height` (number or `null`)
  - `sha256` (`null` unless computed)
  - `sourceIndex` (index in provider response)
- `createdAt` (ISO8601 UTC)
- `rawOperation` (full provider operation payload)

If provider response contains extra fields, preserve them under `artifacts[i].providerMetadata`.

## Error Handling and Bounded Repair

When submit or polling fails:

1. Isolate failing section (auth header, endpoint path, model id, prompt block, polling endpoint, timeout/backoff setting).
2. Patch only that section.
3. Retry from submit or poll stage as appropriate.
4. Stop after 3 repair attempts and return concise failure summary with last error payload.

### Section-only Patch Policy

Allowed patch scopes:
- Request auth/header section
- Request endpoint/model section
- Request body generation parameter section
- Polling interval/timeout section
- Output normalization mapping section

Disallowed patch scopes:
- Full runtime redesign
- Rewriting validated onboarding/marketing artifacts
- Switching away from Vertex AI Veo provider
- Image-first or multimodal-first request strategy replacing text-to-video primary flow

## Minimal Operational Checklist

Before submit:
- Vertex project/location/model are explicitly set.
- Request is text-to-video first.
- OAuth token is present.

During run:
- Operation name captured.
- Poll loop uses bounded backoff and timeout.

After completion:
- Success: normalized artifact metadata emitted.
- Failure: stage + last error + patched sections emitted.
