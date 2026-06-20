# How to generate and approve a week of social content

Submit a weekly social-content job, walk it through the approval stages (strategy -> production -> publish), then edit and schedule the resulting posts. This guide covers the dashboard UI and the API.

## Prerequisites

- A tenant account that has finished onboarding. Jobs and approvals both return HTTP 409 with `reason: 'onboarding_required'` until onboarding is complete.
- For the API path: a way to call the app's HTTP endpoints with your tenant session (the same cookies/headers your browser sends). Tenant identity and the approving actor are derived server-side from this context, not from the request body.
- A connected social platform (for example Meta/Instagram) if you intend to live-publish. See [../how-to/connect-a-social-platform.md](../how-to/connect-a-social-platform.md).

## What a "week" is

The weekly job type is `weekly_social_content`. On the social-content route the submitted `jobType` field is ignored: `resolveRequestedJobType` always resolves to `weekly_social_content` (`app/api/marketing/jobs/handler.ts`).

Default scope, from `DEFAULT_SOCIAL_CONTENT_COUNTS` in `backend/social-content/types.ts` (this is the constant the normalizer reads):

| Field | Default | Cap |
| --- | --- | --- |
| `postWindowDays` | 7 | clamped 1-14 |
| `staticPostCount` | 7 | floored at 0 |
| `storyCount` | 1 | floored at 0 |
| `imageCreativeCount` | 6 | max 6 |
| `videoScriptCount` | 1 | floored at 0 |
| `videoRenderCount` | 0 | max 1 |
| `channels` | `['meta','instagram']` | enum: `meta\|instagram\|linkedin\|x\|tiktok\|youtube` |

The window-day bounds can be overridden with the env vars `ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MIN` and `ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MAX` (`backend/social-content/payload.ts`). Normalization is in `normalizeWeeklySocialContentPayload`; the day clamp is `clampWeeklyWindowDays`.

## Steps

### Option A: the dashboard UI

1. Open `/dashboard/social-content/new`. You land on the "New Social Content" screen (page title `New Social Content · Aries AI`). This route renders the shared `MarketingNewJobScreen` form (`app/dashboard/social-content/new/page.tsx`).
2. Fill in the brand fields. The form maps to the same payload keys the API uses: brand URL, business name, business type, primary goal, audience, offer, brand voice, style vibe, channels, and the per-week counts. Leave the counts untouched to accept the weekly defaults above.
3. Optionally attach brand assets. The form uploads them under the `brandAssets` field into the job workspace.
4. Submit. The job is created (HTTP 202 under the hood) and you are redirected into the dashboard for that job.
   - Expected result: a new job appears with status reflecting `social_content_job_status` and the first stage in `social_content_stage`.
5. Walk the approval checkpoints from the job's dashboard as each stage finishes generating. The job pauses at each checkpoint with stage status `awaiting_approval`. Approve in order: the weekly plan (strategy), then production (post copy, image creatives, video script/render), then publish.
6. After the production stage is approved, edit and schedule. Adjust caption/hashtags/CTA on the generated posts, then approve the publish checkpoint to schedule or live-publish. Pick platforms at this step (see `publishConfig` below).

### Option B: the API

The three endpoints (all thin wrappers that set `responseDialect: 'social-content'`):

- `POST /api/social-content/jobs` (`app/api/social-content/jobs/route.ts`)
- `GET /api/social-content/jobs/{jobId}` (`app/api/social-content/jobs/[jobId]/route.ts`)
- `POST /api/social-content/jobs/{jobId}/approve` (`app/api/social-content/jobs/[jobId]/approve/route.ts`)

1. **Create the job.** POST JSON with `{ jobType, payload }` (the route accepts JSON or `multipart/form-data`; for file uploads use FormData with `brandAssets`). For JSON, `payload` defaults to `{}` if omitted, and `jobType` is ignored on this route.

   ```bash
   curl -X POST https://YOUR_HOST/api/social-content/jobs \
     -H 'Content-Type: application/json' \
     --cookie "$ARIES_SESSION_COOKIE" \
     -d '{
       "jobType": "weekly_social_content",
       "payload": {
         "brandUrl": "https://example.com",
         "businessName": "Example Co",
         "businessType": "ecommerce",
         "primaryGoal": "drive sales",
         "audience": "small business owners",
         "channels": ["meta", "instagram"],
         "postWindowDays": 7
       }
     }'
   ```

   Expected result: HTTP **202** with a body containing `social_content_job_status`, `social_content_stage`, `jobId`, `jobType` (`weekly_social_content`), `approvalRequired`, `approval`, `reason`, `message`, and `jobStatusUrl` (a status PAGE path, `/social-content/status?jobId=<id>`). Save the `jobId`.

   Note: counts you send are normalized. `postWindowDays` is clamped to 1-14 (default 7), `imageCreativeCount` is capped at 6, `videoRenderCount` is capped at 1, and the rest are floored at 0. Token-like strings in the payload are redacted before persistence (`redactTokenLikeString`), so do not rely on putting secrets in any field.

2. **Poll status.** GET the job to see which stage is waiting on you.

   ```bash
   curl https://YOUR_HOST/api/social-content/jobs/JOB_ID \
     --cookie "$ARIES_SESSION_COOKIE"
   ```

   Expected result: HTTP **200** (with an `x-cache` response header). The body includes `social_content_job_state`, `social_content_job_status`, `social_content_stage`, `social_content_stage_status`, `approvalRequired`, `approval`, `stageCards`, `artifacts`, `timeline`, `nextStep`, `publishConfig`, `contentBrief`, `postWindow`, `plannedPostCount`, `createdPostCount`, and `jobType: 'weekly_social_content'`. Wait until `social_content_stage_status` is `awaiting_approval` before approving.

3. **Approve the weekly plan (strategy).** Use `approvalStep: approve_weekly_plan`, which maps to the `strategy` stage (`stageFromSocialApprovalStep`).

   ```bash
   curl -X POST https://YOUR_HOST/api/social-content/jobs/JOB_ID/approve \
     -H 'Content-Type: application/json' \
     --cookie "$ARIES_SESSION_COOKIE" \
     -d '{
       "approved": true,
       "approvalStep": "approve_weekly_plan",
       "approvedBy": "you@example.com"
     }'
   ```

   Expected result: HTTP **202** with `approval_status: "submitted"`, `social_content_approval_status`, `jobId`, `resumedStage`, `completed`, `approvalId`, `reason`, `jobStatusUrl`, and `jobType: 'weekly_social_content'`. (`approved` defaults to `true` if omitted, but send it explicitly.)

4. **Approve production.** As copy and creatives finish, approve the production checkpoints. These steps all map to the `production` stage: `approve_post_copy`, `approve_image_creatives`, `approve_video_script`, `approve_video_render`. Re-poll status (step 2) between each, then:

   ```bash
   curl -X POST https://YOUR_HOST/api/social-content/jobs/JOB_ID/approve \
     -H 'Content-Type: application/json' \
     --cookie "$ARIES_SESSION_COOKIE" \
     -d '{
       "approved": true,
       "approvalStep": "approve_post_copy",
       "approvedBy": "you@example.com"
     }'
   ```

   You can also drive stages directly with `approvedStages` (any of `research`, `strategy`, `production`, `publish`); if you send `approvedStages` it takes precedence over the stage derived from `approvalStep`.

5. **Edit and schedule, then approve publish.** Edit the generated post copy/creatives in the dashboard first. Then approve the final checkpoint with `approve_publish` (maps to `publish`) and choose where it goes via `publishConfig`. Request keys are camelCase and map to the orchestrator's snake_case fields:

   ```bash
   curl -X POST https://YOUR_HOST/api/social-content/jobs/JOB_ID/approve \
     -H 'Content-Type: application/json' \
     --cookie "$ARIES_SESSION_COOKIE" \
     -d '{
       "approved": true,
       "approvalStep": "approve_publish",
       "approvedBy": "you@example.com",
       "resumePublishIfNeeded": true,
       "publishConfig": {
         "platforms": ["meta", "instagram"],
         "livePublishPlatforms": ["meta"],
         "videoRenderPlatforms": []
       }
     }'
   ```

   - `publishConfig.platforms` -> `platforms`
   - `publishConfig.livePublishPlatforms` -> `live_publish_platforms`
   - `publishConfig.videoRenderPlatforms` -> `video_render_platforms`

   Expected result: HTTP **202**, same shape as step 3. Posts on `livePublishPlatforms` go out live; the rest are scheduled within the post window.

### Denying a checkpoint

To reject instead of approve, send `approved: false`. This routes to `denySocialContentJob`. You can add `denialReasonCode` (validated against the known codes) and `denialNote` (alias `note`):

```bash
curl -X POST https://YOUR_HOST/api/social-content/jobs/JOB_ID/approve \
  -H 'Content-Type: application/json' \
  --cookie "$ARIES_SESSION_COOKIE" \
  -d '{
    "approved": false,
    "approvalStep": "approve_post_copy",
    "approvedBy": "you@example.com",
    "denialNote": "Tone is off, regenerate."
  }'
```

A denial also returns HTTP 202 with `approval_status: "submitted"` for the social-content dialect.

## Text-only run

There is no dedicated text-only flag. Zero out the image and video counts; the normalizer floors each at 0, so zero is preserved:

```json
{
  "jobType": "weekly_social_content",
  "payload": {
    "brandUrl": "https://example.com",
    "businessType": "ecommerce",
    "primaryGoal": "drive sales",
    "staticPostCount": 7,
    "storyCount": 0,
    "imageCreativeCount": 0,
    "videoScriptCount": 0,
    "videoRenderCount": 0
  }
}
```

Set `storyCount: 0` to suppress the default image story, `imageCreativeCount: 0` to suppress generated images, and both `videoScriptCount: 0` and `videoRenderCount: 0` to suppress video. Sending `renderVideoAfterApproval: false` also zeroes the video render count, but set the script count to 0 as well to fully suppress video.

## Verification

- After create: you got HTTP 202 and a `jobId`. GET the job and confirm `jobType` is `weekly_social_content` and `social_content_stage` is set.
- During approval: GET the job between steps and confirm `social_content_stage` advances and `social_content_stage_status` moves off `awaiting_approval` for the stage you just approved. The full stage enum is `intake | research | planning | plan_review | copy_production | image_briefing | image_generation | creative_review | social_copy_finalize | video_script | video_review | video_render | publish_review | completed | failed` (`backend/social-content/types.ts`).
- After publish: GET the job and check `plannedPostCount`/`createdPostCount` and `publishConfig`. Posts on live platforms publish immediately; scheduled posts appear in the timeline.

## Troubleshooting

**Create (`POST /api/social-content/jobs`)**

- **HTTP 409, `reason: 'onboarding_required'`** - finish tenant onboarding, then resubmit.
- **HTTP 400, `unsupported_job_type:...`** - only relevant off the social-content route; on this route `jobType` is forced to `weekly_social_content`.
- **HTTP 400, competitor URL error** (`COMPETITOR_URL_INVALID_ERROR` / `COMPETITOR_URL_SOCIAL_ERROR`) - the `competitorUrl` you sent failed validation; fix or omit it.
- **HTTP 400, `missing_required_fields:...`** - supply the listed fields (typically brand URL, business type, primary goal).
- **HTTP 422, `brand_kit_...`** - a brand-kit precondition failed; check brand assets/config.
- **HTTP 501, `workflow_missing_for_route:...`** - the weekly workflow is not registered in this environment; this is a deployment issue, not your request.
- **HTTP 500** - unhandled server error; check the `error` message and server logs.

**Status (`GET /api/social-content/jobs/{jobId}`)**

- **HTTP 404** - job not found, or it belongs to a different tenant than your session. Confirm the `jobId` and that you are signed in as the owning tenant.
- **HTTP 409, `onboarding_required`** - finish onboarding.

**Approve (`POST /api/social-content/jobs/{jobId}/approve`)**

- **HTTP 404, `reason: 'marketing_job_not_found'`** - job not found or tenant mismatch.
- **HTTP 400, `error: 'approvedBy is required.'`, `reason: 'missing_approved_by'`** - include a non-empty `approvedBy`.
- **HTTP 409, `reason: 'approval_not_available'`** - the job is not waiting on an active checkpoint right now. Re-poll status until `social_content_stage_status` is `awaiting_approval`.
- **HTTP 409, `reason: 'approval_stage_not_selected'`** - the checkpoint you targeted is not the one currently open; match `approvalStep`/`approvedStages` to the current stage.
- **HTTP 501, `reason: 'workflow_missing_for_route'`** - workflow not registered; deployment issue.
- **HTTP 500** - unhandled server error; check the `error` message.

## Related

- [Tutorial: generate and approve your first week of content](../tutorials/first-week-of-content.md)
- [API reference: social-content jobs and callbacks](../reference/api-jobs-and-callbacks.md)
- [How to connect a social platform](../how-to/connect-a-social-platform.md)
