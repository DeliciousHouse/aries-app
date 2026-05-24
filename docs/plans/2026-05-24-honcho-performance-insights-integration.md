# Honcho performance-insights integration — design doc for the analytics-page workstream

**Status:** Open for the analytics-page developer to pick up.
**Author:** Auto-generated 2026-05-24 from the `/goal` Honcho rollout session.
**Related:**
- `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md` (Phase 2 spec)
- `backend/memory/write-events.ts` (write functions already shipped)
- `backend/marketing/hermes-callbacks.ts:1558,1579` (existing call sites)

---

## Context

As of v0.1.8.6 (PR #441), Honcho continuous-profile-writes Phases 1+2+3 are live in production with their env gates flipped on. The marketing pipeline now writes to Honcho on:

| Surface | Trigger | What gets written |
|---|---|---|
| Strategy approval | User clicks approve at strategy stage | `kind=fact` to `peer-brand` |
| Stage denial | User clicks deny at any stage | `kind=rejected_angle` + audit record |
| Publish verification | `runPublishVerification` returns `verified` | `kind=constraint` to `peer-policy` (queued) |
| Scheduled post | `upsertScheduledPost` succeeds | `kind=constraint` to `peer-policy` (auto-approved) |
| Hermes publish-stage callback | `markJobCompleted` for publish stage | `kind=research_conclusion` to `peer-market-signal-<topicPseudonym>` |
| Creative voice preference | User saves a UI preference | `kind=preference` to `peer-user-<userPseudonym>` |

**What's missing:** There is no scheduled job that reaches back into the Meta Graph API for actual post performance metrics (likes, comments, reach, impressions, video views) after a post has been live for 24–72 hours. Right now Honcho gets "we published X" but never "X got 300 likes vs Y got 50."

This doc is the integration contract for the analytics-page workstream to close that loop.

---

## Goal

Build a worker that, for every post Aries published, fetches actual Meta `/insights` metrics 24–72 hours after publish and writes them to Honcho via the already-shipped `recordPerformanceEvent` / `scheduleHermesPublishPerformanceHonchoWrite` functions. Honcho then becomes the brand's long-term performance memory the marketing pipeline can pull from.

---

## Integration contract — what to call

**Function (already shipped):** `scheduleHermesPublishPerformanceHonchoWrite` from `backend/memory/write-events.ts` (around line 708)

```typescript
scheduleHermesPublishPerformanceHonchoWrite({
  doc: MarketingJobRuntimeDocument,   // the job runtime doc, fetched via readMarketingJobRuntimeDocument(jobId)
  payloadRecord: {                    // your scrubbed metrics payload
    platform: 'instagram' | 'facebook',
    post_id_pseudonym: string,        // NEVER raw platform post ID — see scrub note below
    published_at_ymd: string,         // YYYYMMDD
    metrics: {
      reach?: number,
      impressions?: number,
      engagement?: number,
      likes?: number,
      comments?: number,
      shares?: number,
      saves?: number,
      video_views?: number,
      // ...anything else from /insights
    },
    metrics_fetched_at: string,       // ISO timestamp of when you polled Meta
    metrics_source_url: string,       // the Meta Graph API URL you called (helps Honcho cite the source)
  },
}): void
```

The function is non-blocking (`setImmediate`-wrapped), reads `HONCHO_WRITE_PUBLISH_ENABLED` itself, and silently no-ops if the gate is off. **Call it freely** — no try/catch needed at the call site for Honcho-side errors.

**Lower-level alternative if you need finer control:** `recordPerformanceEvent` (same file, line ~680). Same payload shape, takes pre-resolved `tenantCtx` + `topicPseudonymHex`, returns a Promise.

---

## Scrubbing rules (binding — do not skip)

Per the Phase 2 spec, performance result claims must be sanitized before Honcho writes:

1. **Never include raw platform post IDs in claim bodies.** Use a pseudonym. The helper `topicPseudonymHexForPerformanceMemory(jobId, competitorUrl)` from `write-events.ts` gives you a stable per-job pseudonym; for per-post pseudonymization, compute `sha256(ARIES_TENANT_PSEUDONYM_SALT + 'meta-post:' + post_id).slice(0, 16)`.
2. **Use `scrubPlatformIdsFromPerformancePayload(payloadRecord)`** from `write-events.ts` (already shipped, line ~413) before passing the payload in. It removes known Meta ID fields (`fb_post_id`, `ig_media_id`, `permalink`, etc).
3. **Use `extractPerformanceMetricsSourceUrl(payloadRecord)`** if you need to validate the URL is HTTPS before writing it (the curator gates on this).

If you skip the scrubbers, the curator will refuse the write and you'll see warnings in the Honcho dispatch log.

---

## Suggested architecture

**Component:** A new long-lived worker, mirroring the pattern of `scripts/automations/scheduled-posts-worker.mjs`.

**Cadence:** Every 30 minutes. Each tick:

1. Query `scheduled_posts` (or wherever you track published posts — `meta_publish_log` table if it exists) for posts where:
   - `status = 'published'`
   - `published_at` is between 24h and 7 days ago
   - `insights_fetched_at` is NULL (add this column via migration if missing)
2. For each row, call the Meta Graph API:
   - Instagram: `GET https://graph.facebook.com/v23.0/{ig_media_id}/insights?metric=reach,impressions,engagement,saves,video_views`
   - Facebook: `GET https://graph.facebook.com/v23.0/{fb_post_id}/insights?metric=post_impressions,post_engaged_users,post_reactions_by_type_total`
3. Update the row: set `insights_fetched_at = NOW()`, save raw metrics to a `post_insights_snapshots` table (analytics page reads from there).
4. Call `scheduleHermesPublishPerformanceHonchoWrite({ doc, payloadRecord })` with the scrubbed payload. Don't block — fire and forget.
5. Re-poll the same post at 7 days and 30 days for the final-state snapshot (Meta metrics keep climbing for ~30 days post-publish).

**Backoff for rate-limited responses:** Meta Graph API rate-limits at ~200 calls/hour/user-token. Use exponential backoff on 429 / `(#17) User request limit reached`.

**Idempotency:** Already handled on the Honcho side — the existing idempotency key is `sha256(jobId + stage + platform + publishedAtDate)`. Polling the same post twice on the same day will dedupe.

---

## Analytics page integration

The analytics page should read from `post_insights_snapshots` (the table this worker writes to), not from Honcho directly. Honcho is the marketing-pipeline's memory; the analytics page is the operator's view. Different consumers, different stores.

If the analytics page wants to surface "Honcho's interpretation" of a campaign's performance, query Honcho directly via `HonchoHttpTransport` (already exists at `backend/memory/honcho-http-transport.ts`). The relevant Honcho session/peer for performance interpretations is `peer-market-signal-<topicPseudonym>`.

---

## Test plan

1. Mock a published post in `scheduled_posts` with `published_at` = 36 hours ago, `insights_fetched_at` = NULL.
2. Mock Meta Graph API `/insights` response with realistic metric values.
3. Run the worker once.
4. Assert: `insights_fetched_at` is set, `post_insights_snapshots` has a row, and `scheduleHermesPublishPerformanceHonchoWrite` was called once with the scrubbed payload.
5. Assert: no raw `fb_post_id` / `ig_media_id` appears anywhere in the payload sent to Honcho.
6. Run the worker again 10 minutes later — assert no duplicate Honcho write (idempotency).
7. With `HONCHO_WRITE_PUBLISH_ENABLED=false`: assert the metrics snapshot still lands in `post_insights_snapshots`, but no Honcho dispatch fires.

---

## Env vars

No new env vars required. Reuse:
- `META_ACCESS_TOKEN` / `META_PAGE_ID` / `META_APP_ID` / `META_APP_SECRET` (already in docker-compose.yml)
- `HONCHO_WRITE_PUBLISH_ENABLED` (flipped to `true` in v0.1.8.6)
- `ARIES_TENANT_PSEUDONYM_SALT` (used by `topicPseudonymHexForPerformanceMemory`)

---

## Rollback

If the worker misbehaves (excessive Meta API calls, malformed Honcho writes), set `HONCHO_WRITE_PUBLISH_ENABLED=false` in the env. The worker keeps populating `post_insights_snapshots` (the analytics page stays alive), but the Honcho leg is killed. No data migration needed.

---

## Out of scope for this doc

- Building the analytics page UI itself (separate workstream).
- Backfilling insights for posts published before this worker launches (one-off script if desired).
- Multi-platform support beyond Meta (TikTok, YouTube — Phase 4).
- Aggregating Honcho `peer-market-signal-*` claims into actionable strategy hints for the next pipeline run (that's the marketing-pipeline's job once enough signal accumulates).
