# Aries AI — Feedback Submission Button

**Source:** Aries Dev Meeting — June 19, 2026 (Decisions → "Feedback tracking mechanism integration")
**Owner:** Brendan Kam
**Status:** Implemented (`feat/feedback-button`)

## Purpose

A persistent, floating feedback button on **every page** of Aries lets any user —
authenticated or not — submit a comment, automatically attaches context about
where/how the issue occurred, and logs each submission as **one row in a
centralized Google Sheet via Composio**. It must work even for users who can't
log in (that's the headline bug class it exists to capture).

## What ships

- **Floating button** (bottom-right, desktop + mobile), mounted once in the root
  layout (`app/layout.tsx`) so it appears on every route including login/auth.
- **Modal form**: comment (required), category dropdown, severity dropdown,
  optional screenshot attach. Submit stays disabled until the comment is non-empty.
- **Silent context capture**: tenant id (or `unauthenticated`), page URL, auth
  state, browser/UA/OS, viewport, recent console errors, screenshot, timestamp,
  environment (dev/prod), and a unique submission id.
- **Durable-first delivery**: each submission is written to `feedback_submissions`
  (Postgres) first, then mirrored as one row into the Google Sheet via Composio.
  Idempotent by submission id so retries never duplicate. A failed mirror is
  surfaced to the user as retryable; the durable row is never lost.

## Form fields

| Field | Type | Required |
|---|---|---|
| Comment | multi-line text | yes |
| Category | dropdown: Bug, Login issue, Feature idea, Content quality, Other | yes |
| Severity | dropdown: Low, Medium, High, Blocker | yes |
| Screenshot | optional image attach (PNG/JPEG/WebP/GIF, ≤5 MB) | no |

## Google Sheet schema (one row per submission)

Submission ID · Timestamp · Tenant ID · Auth state · Category · Severity ·
Comment · Page URL · Browser / UA · Viewport · Console errors · Screenshot link ·
Environment

(Defined once in `lib/feedback/feedback-sink.ts` → `FEEDBACK_SHEET_COLUMNS`.)

## Architecture

| Concern | File |
|---|---|
| Floating button + modal (client) | `frontend/feedback/feedback-widget.tsx` |
| Recent console-error capture | `frontend/feedback/console-capture.ts` |
| Public submit endpoint | `app/api/feedback/route.ts` |
| Screenshot serving | `app/api/feedback/screenshot/[submissionId]/route.ts` |
| Shared options (categories/severities/limits) | `lib/feedback/options.ts` |
| Input validation (pure) | `lib/feedback/submission.ts` |
| Env config | `lib/feedback/feedback-config.ts` |
| Durable store (pg) | `lib/feedback/feedback-store.ts` |
| Composio → Sheet mirror | `lib/feedback/feedback-sink.ts` |
| Table | `migrations/20260623000000_feedback_submissions.sql` |

The endpoint is intentionally **public**: it reads `auth()` defensively (never
`getTenantContext()`, which throws), recording tenant context when present and
`unauthenticated` otherwise. The Composio mirror reuses the existing
`LiveComposioGateway` seam (`executeTool`) used by the social publishers.

## Configuration

The capture path works with zero config (rows land in Postgres). The Google Sheet
mirror activates only when all of these are set (otherwise rows are saved and
marked `sheet_sync_status = 'skipped'`):

- `COMPOSIO_API_KEY`
- `COMPOSIO_FEEDBACK_GOOGLE_CONNECTED_ACCOUNT_ID`
- `FEEDBACK_GOOGLE_SHEET_ID` (+ optional `FEEDBACK_GOOGLE_SHEET_TAB`, default `Feedback`)
- `COMPOSIO_FEEDBACK_SHEETS_APPEND_ACTION` (action slug — never guessed)

Other knobs: `FEEDBACK_ENABLED` (default on), `NEXT_PUBLIC_FEEDBACK_DISABLED`
(client kill switch), `FEEDBACK_RATE_LIMIT_PER_HOUR` (default 20, per hashed IP),
`FEEDBACK_ENVIRONMENT` (label, defaults to `NODE_ENV`). See `.env.example`.

## Open items (§11)

- Confirm the exact destination Sheet (file + tab) and the Composio-connected
  Google account.
- Screenshots are currently stored durably in Postgres and served at
  `/api/feedback/screenshot/:id` (the link written into the Sheet). Pushing the
  image to Google Drive via Composio is deferred (the master `ComposioGateway`
  has no file-staging method yet).
- User identity (id/email) is intentionally **not** captured — the meeting decided
  on tenant id only. Revisit if per-user follow-up is needed.
