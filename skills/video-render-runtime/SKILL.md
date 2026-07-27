---
name: video-render-runtime
description: Use when Hermes executes Aries video render requests and callbacks.
version: 2.0.0
status: active
contract: contract.json
---

# Provider-neutral video render runtime

Use this skill when an Aries `social_content_weekly` run asks Hermes to render video. Aries owns the creative brief, tenant/job/run correlation, approval policy, and artifact acceptance. Hermes owns provider and model selection, credential use, retries, and execution.

## Authoritative protocol

- Validate the outbound payload as `HermesRunSubmissionSchema`.
- POST the exact payload to Hermes `/v1/runs`; do not introduce a second transport envelope.
- Send terminal results using `HermesRunCallbackPayloadSchema` to the supplied `callback_url`.
- The versioned projection is `../../specs/video_job_contract_spec.v2.json`.
- Aries runtime state is the existing `aries_execution_run` record. Do not persist a separate video state machine.

## Source safety

Input assets must use `{ "type": "https_url", "url": "https://..." }`. Reject local paths, `file:` URLs, credentials in URLs, traversal segments, loopback hosts, link-local hosts, and RFC1918 addresses. Never fetch a source that fails those checks.

## Execution

1. Read the serialized `video.generate` media request from the Hermes submission `input` string.
2. Keep `aries_run_id`, production `mkt_<uuid>` `job_id`, and `tenant_id` unchanged.
3. Select the execution provider/model within Hermes policy. Do not return provider credentials or provider-specific identifiers to Aries.
4. Preserve each completed artifact immediately. If a later render is rate-limited or fails, return the completed subset in the failed callback `output` and mark the error `retryable` when appropriate.
5. Emit each video artifact consistently:
   - `id`: stable logical artifact id
   - `path`: absolute path under the configured Hermes video cache
   - `mime_type`: `video/mp4`
   - `bytes`: non-negative byte count
   - optional `platform_slug`, `family_id`, dimensions, and duration
6. Use `stage: "video_render"`. Bind terminal outcomes exactly:
   - completed → callback `status: "completed"`
   - failed → callback `status: "failed"` with `error`
   - cancelled → callback `status: "cancelled"`
7. Authenticate the callback exactly as instructed by `callback_auth`. Never echo the shared secret or callback token in `output`, logs, or artifacts.

## Verification

Before callback delivery, verify:

- the outbound ownership fields match `callback_context`;
- no provider/model selection fields were added to the Aries payload;
- every local artifact path exists, is inside the configured Hermes cache, and reports the actual byte count;
- failed retryable runs retain any completed artifacts;
- callback `event_id` is stable across delivery retries.
