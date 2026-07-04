# Customer Feedback/Incident Button — SC-70 port (AA-51)

Implementation record for the Sequence CRM SC-70 port. The source plan is the
self-contained port document (impact-rated, auth-gated incident reports filed
as Jira Bugs with persist-first durability, retry healing, and idempotency).
This file records the Aries-specific decisions, the evidence behind them, and
the operator runbook.

## What shipped

- `POST /api/feedback/submit` — auth-gated (all tenant roles). Identity comes
  from the session only; body-supplied identity/tenant/priority fields are
  never read. Persists a `feedback_reports` row (transactional rate limit
  10/user+tenant/hr + 60s title+description dedup) and COMMITS before any Jira
  I/O, then attempts the sync inline. Uniform response
  `{submission_id, jira_ticket_key, status, screenshot_discarded}`:
  201 when a ticket key exists (even if the attachment is still syncing),
  202 when the report parks for the sweep, 429 on throttle/dedup.
- `backend/feedback/` — impact→priority map, ADF builder (node types exactly
  `{doc, paragraph, text}`, zero marks, user text only in text-node values),
  Jira client (shared lazy instance, 15s timeout, token + basic-credential
  scrubbing BEFORE truncation, JQL label guard `^[a-z0-9-]+$` with zero HTTP on
  reject, issue-key validation `^[A-Z][A-Z0-9]*-\d+$`,
  `GET /rest/api/3/search/jql`), single-callsite search-before-create sync,
  retry sweep.
- `aries-feedback-retry-worker` sidecar (compose + deploy force-recreate block;
  parity test green). Default ON, inherently dormant without `JIRA_*` config.
- Dialog: the existing floating Feedback button now probes
  `/api/auth/session` once per page load — signed-in users get the impact-first
  report dialog (screen capture via `getDisplayMedia` + file picker, 2 MB
  client cap computed from base64 length, pinned
  `https://sugarandleather.atlassian.net/browse/<key>` success link); everyone
  else keeps the legacy public feedback form unchanged.

## Decisions (the plan's "confirm with Brendan" items)

1. **Project key = `AA`** — the legacy feedback mirror already files into AA on
   sugarandleather.atlassian.net via `JIRA_PROJECT_KEY` in the prod `.env`;
   verified live (2026-07-03, Atlassian MCP) that AA now has a **Bug** issue
   type (id 10140, added in the 15 Jun 2026 project migration). Same env var,
   so no `.env` change is needed to go live.
2. **Priority field**: AA's team-managed Bug create screen does **not** expose
   `priority` (verified live — 19 create fields, priority absent). The service
   still maps impact→priority per the plan and sends it optimistically; a
   create that 400s citing the priority field is retried once without it and
   the outcome is memoized per process. The impact ALWAYS also rides as an
   `impact-p0..p4` label, so board quick filters work either way. When a Jira
   admin associates the SC-71 priority scheme with AA, priorities start landing
   automatically (next process restart at the latest).
3. **Existing feedback code**: kept. The legacy public capture path
   (`/api/feedback`, `feedback_submissions`, Jira **Task**) is untouched and
   still serves unauthenticated users; the SC-70 pipeline is additive for
   signed-in users. `JIRA_ISSUE_TOKEN` is accepted as an alias for the existing
   `JIRA_API_TOKEN`.

## Aries adaptations vs the reference implementation

- Env names reuse the shipped `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`/
  `JIRA_PROJECT_KEY`; v2 issue type is `JIRA_INCIDENT_ISSUE_TYPE` (default
  `Bug`). New-name knobs (`FEEDBACK_MAX_IMAGE_BYTES`,
  `FEEDBACK_USER_RATE_LIMIT_PER_HOUR`, `FEEDBACK_DEDUP_WINDOW_SECONDS`,
  `FEEDBACK_RETRY_*`, `FEEDBACK_STALE_PENDING_MINUTES`) follow the plan.
  `FEEDBACK_RATE_LIMIT_PER_HOUR` (legacy, per-IP, public endpoint) is a
  different knob from `FEEDBACK_USER_RATE_LIMIT_PER_HOUR` (v2, per user+tenant).
- The retry sweep is a docker-compose sidecar (the repo's background-job
  pattern), not an in-process lifespan loop; the atomic claim makes concurrent
  sweeps safe regardless.
- The customer slug prefers the session's `tenantSlug` (already the product's
  company handle) → tenant id → `unknown`; a tenant-name DB lookup was not
  needed.
- A fourth label `impact-<pX>` is added beyond the plan's three (see decision
  2). The idempotency prefix stays product-unique: `aries-sub-`.

## Operator runbook

- **Go-live**: nothing to flip. Prod `.env` already carries the four `JIRA_*`
  vars; the first deploy creates `feedback_reports` (init-db) and starts
  `aries-feedback-retry-worker`. If Jira config is ever absent, submits return
  202 and park; the sweep heals them once config lands.
- **Board quick filters** (manual, one-time, Jira UI — no public API):
  - `labels = customer-incident`
  - one filter per priority: `labels = impact-p0` … `labels = impact-p4`
    (switch to `priority = "P0 - Crit Sit"` etc. once the SC-71 scheme is
    associated with AA)
  - per-customer: `labels = "customer-<slug>"`
- **Priority scheme**: to get real Jira priorities on AA, a Jira admin must
  put the `priority` field on AA's Bug create screen / associate the SC-71
  scheme. No Aries deploy needed afterwards.
- **Terminal `failed` rows**: `SELECT id, title, last_error FROM
  feedback_reports WHERE status='failed'` — attempts exhausted (default 5).
  Re-arm one with `UPDATE feedback_reports SET status='pending_retry',
  attempts=0 WHERE id='…'`; the sweep picks it up next tick and the
  `aries-sub-<id>` label search keeps it duplicate-proof.
- **Screenshot retention**: bytes live on the row only until the Jira sync
  completes, then are NULLed. Rows that never sync keep bytes until terminal
  `failed`; there is no serve endpoint for them (v2 attaches to Jira instead).

## Verification

- Self-contained: `tests/feedback-report-*.test.ts` (impact map incl.
  prototype-name lookups, screenshot quartet + pre-decode no-decode proof, ADF
  walk against malicious payloads, token scrub-before-truncate + JQL zero-HTTP
  guard, 201/202/429 contracts + spoof-ignored, sync idempotency paths +
  priority degrade + exhaust boundary, sweep isolation/no-op paths, dialog
  logic incl. pinned href + identity-free POST body).
- Live schema: `tests/feedback-reports-store.requires-infra.test.ts`
  (throwaway schema; run green against the prod Postgres 2026-07-03).
