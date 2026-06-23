# Tutorial: generate and approve your first week of content

By the end of this tutorial you will have a running Aries AI instance, a tenant you onboarded yourself, and a week of social posts that you generated, reviewed, approved, and scheduled. You will see a real result in the browser within the first few steps.

Aries hands the run to Hermes, the separate execution service, so you need a reachable Hermes endpoint to finish. The weekly run plans the week and writes the copy, and with the default scope it also requests image creatives. You stop at scheduled, so you never publish to a live social account in this tutorial.

What you will build:

- A local Aries AI app at `http://localhost:3000`.
- An onboarded tenant with a goal, business, website, brand, and channels.
- A weekly social-content job created from a brand brief.
- A reviewed and approved week of posts, scheduled for publish.

This is a learning path. For day-to-day repeat work, follow the how-to guides linked at the end. For full environment setup and architecture, see [../SELF_HOSTING.md](../SELF_HOSTING.md) and [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Before you start

You need:

- Node.js and npm.
- A reachable Postgres database (host, port, user, password, database name).
- The repo checked out. This tutorial uses the repo at `/home/node/docker-stack/aries-app`.

Hermes is the separate execution service that runs the workflow and owns provider auth, including media generation. You need a reachable Hermes endpoint for any run: set `HERMES_GATEWAY_URL`, `HERMES_API_SERVER_KEY`, and `HERMES_SESSION_KEY` in your `.env`. With the default weekly scope the run also requests image creatives, so the endpoint needs media generation configured. If you want a planning-only run that calls no media provider, see "What the weekly run requests" in Step 3.

## Step 1: Start the app and see it load

Install dependencies, create your env file, initialize the database, and start the dev server.

```bash
cd /home/node/docker-stack/aries-app
NODE_ENV=development npm ci
cp .env.example .env
npm run db:init
npm run dev
```

Open `http://localhost:3000`. You should see the Aries AI app load.

`npm run dev` uses Turbopack, which is required for Tailwind v4. If styles look unstyled or the build complains about Tailwind, you started Next without Turbopack. Stop the server and run `npm run dev` again, which is already wired for Turbopack in this repo.

Fill in your `.env` before `npm run db:init`. At minimum you need the database vars (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) and the app/auth vars (`APP_BASE_URL`, `NEXTAUTH_URL`, `AUTH_URL`, `NEXTAUTH_SECRET`, `AUTH_TRUST_HOST`, `OAUTH_TOKEN_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, `CODE_ROOT`, `DATA_ROOT`). For the Hermes handoff you also set `HERMES_GATEWAY_URL`, `HERMES_API_SERVER_KEY`, and `HERMES_SESSION_KEY` (usually `main`). The full list and meaning of each var lives in [../SELF_HOSTING.md](../SELF_HOSTING.md).

If `npm run db:init` fails to connect, your `DB_*` values are wrong or Postgres is not running. Fix the values in `.env`, confirm Postgres accepts connections, then run `npm run db:init` again.

## Step 2: Onboard your tenant

Sign in, then open the onboarding flow.

```text
http://localhost:3000/onboarding/start
```

The page checks your session and tenant. A brand-new tenant has no onboarding decision yet, so the page renders the onboarding flow (`AriesOnboardingFlow`). An already-onboarded tenant is redirected straight to `/dashboard`. If you land on `/dashboard` instead of the flow, your tenant is already onboarded and you can skip to Step 3.

Work through the five steps in order. The flow starts with the goal on purpose, so every later step is built around a real objective:

1. **Goal** - pick a goal. The options include a social-visibility goal and a custom business outcome.
2. **Business** - describe the business.
3. **Website** - enter the website.
4. **Brand identity** - capture the brand.
5. **Channels** - choose where content goes. Options include Meta, Instagram (Organic), YouTube, and Google Business.

When you finish, you land in the dashboard. You now have an onboarded tenant. That is your first visible result.

## Step 3: Create a weekly social-content job

Open the create screen.

```text
http://localhost:3000/dashboard/social-content/new
```

This is the New Social Content form. Leave the content type on **Weekly social content** (the default). This maps to the job type `weekly_social_content`.

Fill in the form:

- **Website URL** (required). Must look like `https://example.com`. The form normalizes a bare domain to `https://`, but it must validate as a real URL or the submit button stays disabled.
- Optional brand inputs you can add now or leave blank: **Brand voice**, **Style / vibe**, **Visual references** (one per line), **Logo uploads / brand assets**, **Must-use copy**, **Must-avoid aesthetics**, **Extra notes / instructions**, **Competitor website URL**.

Click **Start social content**.

On submit, the form builds a `FormData` request (with `jobType`, `brandUrl`, `websiteUrl`, and any optional fields you filled) and posts it to:

```text
POST /api/social-content/jobs
```

A successful create returns HTTP 202 (Accepted) with a body containing `jobId` and `jobStatusUrl`. The 202 means Aries accepted the request and handed the run to Hermes; the week is now being planned. The screen then routes you straight into the campaign workspace at the Brand Review view:

```text
/dashboard/social-content/<jobId>?view=brand
```

Seeing the Brand Review workspace open is your sign the job was created. That is your third visible result.

If the submit button is disabled, your Website URL is not valid yet. Enter a URL like `https://example.com` and the button enables.

If the request comes back with an error instead of routing you, the status code tells you what to fix:

- **400** - bad request, for example an unsupported job type. Make sure the content type is Weekly social content.
- **422** - validation failed. Check the required fields; inline red errors point at the offending field.
- **501** - `workflow_missing_for_route`. The weekly workflow is not registered in your environment. Confirm your Hermes config (`HERMES_GATEWAY_URL`, `HERMES_API_SERVER_KEY`, `HERMES_SESSION_KEY`).

### What the weekly run requests

The create form does not expose media-count inputs, so a job created here runs with the default scope. From `backend/social-content/defaults.ts`, `SOCIAL_CONTENT_DEFAULT_SCOPE` is:

- `window_days: 7`
- `static_post_count: 7`
- `story_count: 1`
- `image_creative_count: 6`
- `video_script_count: 1`
- `video_render_count: 0`
- `channels: ['meta', 'instagram']`

So a run created from this form asks Hermes for image creatives and one story; `video_render_count` is `0`, so there is no video render step. The planning, strategy, and copy stages run on Hermes regardless.

If you want a planning-only run that calls no media provider, submit the job through the API with the media counts set to `0` instead of using this form. The payload layer floors every count at `0` with `Math.max(0, count)` and caps the image-creative and video-render counts with `Math.min(MAX, Math.max(0, count))` (see `backend/social-content/payload.ts`), so zero counts disable media generation, and `renderVideoAfterApproval` is true only when the clamped video render count is greater than `0`. See [../how-to/generate-and-approve-a-week.md](../how-to/generate-and-approve-a-week.md) and [../reference/api-jobs-and-callbacks.md](../reference/api-jobs-and-callbacks.md) for the request shape.

## Step 4: Review the staged week

You are already in the campaign workspace at `/dashboard/social-content/<jobId>?view=brand`. This single workspace page renders every review stage; the `?view=` query param chooses which stage you see:

- `?view=brand` - Brand Review.
- `?view=strategy` - Strategy Review.
- `?view=creative` - Creative Review.
- `?view=publish` - Publish Status.
- no `view` (or any other value) - the Campaign overview.

Walk the stages in order. Start at Brand Review, then move to Strategy Review and Creative Review. Each stage shows the staged output for that part of the week and holds its own approval state. Read the proposed week: the static posts, the copy, and the plan. Publish stays blocked until the workflow is explicitly approved.

The week does not appear instantly. Aries submitted the run to Hermes, and Hermes posts authenticated callbacks to `/api/internal/hermes/runs` as the run progresses. Aries updates its runtime state and the read-model status from those callbacks. If a stage still looks empty, the run has not reported that stage yet. Give it time and refresh.

## Step 5: Approve and see posts scheduled

When the staged week looks right, approve it. Work through the review stages and approve each one, then move to Publish Status:

```text
/dashboard/social-content/<jobId>?view=publish
```

Approving releases the publish step. The default weekly scope sets `video_render_count: 0`, so there is no video render step to approve. Once publish is approved, the posts move to scheduled. Watch the Publish Status view show the week's posts as scheduled. That is the result you set out to build: a generated, reviewed, approved week of content, scheduled.

## What you built

You now have:

- A running Aries AI instance at `http://localhost:3000`.
- An onboarded tenant with a goal, business, website, brand, and channels.
- A weekly social-content job created at `/dashboard/social-content/new`, posted to `POST /api/social-content/jobs`, returned as HTTP 202.
- A week of posts reviewed across the Brand, Strategy, and Creative stages in the campaign workspace.
- An approved week with posts scheduled.

Next steps:

- Repeat this as a fast routine with the how-to guide: [../how-to/generate-and-approve-a-week.md](../how-to/generate-and-approve-a-week.md).
- Connect a platform so approved posts publish to a live account: [../how-to/connect-a-social-platform.md](../how-to/connect-a-social-platform.md).
- Understand the full environment and the Aries-to-Hermes execution model: [../SELF_HOSTING.md](../SELF_HOSTING.md) and [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Related

- [How to generate and approve a week of social content](../how-to/generate-and-approve-a-week.md)
- [How to connect a social platform](../how-to/connect-a-social-platform.md)
- [Self-hosting Aries AI](../SELF_HOSTING.md)
