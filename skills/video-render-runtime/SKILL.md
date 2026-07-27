---
name: video-render-runtime
description: Submit provider-neutral video renders to Hermes and normalize artifacts. Use when Aries requests a video render, records Hermes run state, or ingests completed video metadata.
---

# Video Render Runtime

Use this skill only at the Aries-to-Hermes execution seam. Aries describes the render it needs; Hermes selects and operates the downstream media provider.

## Ownership boundary

Aries owns:

- tenant and job identity
- the generic render brief and media constraints
- idempotency and the Aries execution-run record
- the authenticated Hermes callback/reconciliation path
- durable ingestion of completed artifacts and approval state

Hermes owns:

- downstream provider and model selection
- provider credentials, endpoints, request translation, polling, and retries
- localization of generated media into the Hermes video cache
- reporting normalized completion or failure metadata to Aries

Never place downstream provider names, model identifiers, credentials, API hosts, operation handles, or provider retry policy in an Aries request or persisted Aries state.

## Request contract

Before submission, create the Aries execution-run record. Submit one generic request containing:

- `job_id`, `correlation_id`, and `tenant_id`
- `execution_provider: "hermes"`
- a stable `idempotency_key`
- `render_request.prompt`
- `render_request.video` constraints such as duration and aspect ratio
- optional source `assets`
- the authenticated Aries run-ingestion URL

The machine-checkable request and state shapes live in:

- `specs/video_job_contract_spec.v1.json`
- `specs/video_runtime_state_schema.v1.json`

## Completion contract

Treat Hermes run ingestion as the execution source of truth. A completed video artifact should expose only normalized media metadata Aries needs:

- `uri` or localized `path`
- `mime_type` (`video/mp4`)
- `duration_seconds`
- `width_px` and `height_px`
- optional `bytes` and `sha256`

Do not persist raw downstream provider responses. Preserve partial completed artifacts when Hermes reports a retryable or rate-limited failure, and let the existing Hermes execution lifecycle determine retries.

## Approval and ingestion

1. Keep the request idempotent.
2. Ingest localized video bytes into durable Aries storage before exposing the asset.
3. Require the existing video-render approval checkpoint before publishing.
4. Fail loudly when a requested render reaches a terminal Hermes state without a usable video artifact.
5. Never bypass tenant checks or expose raw runtime paths to the browser.
