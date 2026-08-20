# Requires-infra tests

Most of the Aries test suite is **self-contained**: it mocks `pool.query`, writes fixtures
under a per-test `mkdtemp` `DATA_ROOT`, and opens no socket. Those tests run on every CI
`full-suite` invocation.

A small set of tests are **requires-infra**: they exercise the *real* Postgres schema / SQL
and only pass meaningfully against a reachable database. They self-skip with
`t.skip('database env not configured')` via the shared guard
[`tests/helpers/requires-infra.ts`](./helpers/requires-infra.ts) (`requireDbEnvOrSkip`) when
the DB env is absent — so the `full-suite` CI gate counts them as skipped, never failed.

## Which of these actually run in CI

Self-skipping is what keeps `full-suite` honest, but it is not coverage: a file that only
ever skips is a file nobody is running. Two **dedicated** jobs in
[`.github/workflows/tests.yml`](../.github/workflows/tests.yml) provision Postgres and run a
named subset for real. Everything else in the index below is local-only today.

| Job | Runs | Seed |
|---|---|---|
| `feedback-postgres` | `feedback-reports-store`, `scheduled-dispatch-cutover`, + the two lock-order suites, + `insights-llm-calls-drop` (AA-129) | — (each builds its own schema/rows) |
| `insights-endpoints-postgres` | `insights-endpoints.test.ts` (S8-2/AA-125) | `db:init` + `db:seed-insights` |

`full-suite` itself is deliberately left alone — it sets no `DB_*` env, so every file here
still self-skips there. Adding live-DB env to that gate would turn ~30 files into a hard
database dependency for the whole suite.

A job like this needs one guard to be worth having: **a skipped test is a passing test**, so
a broken service container or a renamed env var would leave the job green having verified
nothing. `insights-endpoints-postgres` therefore runs with `--test-reporter=tap` and fails
when the summary reports `skipped != 0`. That is not belt-and-braces — the first real run of
`insights-endpoints.test.ts` found an assertion (`activeTimes.hasData === false`) that had
been wrong since S2-3 replaced that stub with a real heatmap, undetected for exactly as long
as the file had no CI home.

This file is the human-readable half of the "clearly split requires-infra vs self-contained"
deliverable (public-readiness roadmap area 1a). The machine-readable half is
`npm run test:requires-infra-report`.

## How to run them locally

```bash
# point at a reachable Postgres (init-db migrations applied) and opt in:
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export ARIES_TEST_REQUIRES_INFRA_ENABLED=1
npm run test:requires-infra          # runs only the files below, --test-concurrency=1
```

Without `ARIES_TEST_REQUIRES_INFRA_ENABLED` (or without all five `DB_*`), `npm run
test:requires-infra` does **not** execute these files — it prints the split and exits early.
(It is in a normal `npm test` / `full-suite` run that the files are collected and self-skip
with `t.skip('database env not configured')` — exactly as the CI gate sees them.)

## Index

All files below gate on the **superset** `DB_HOST` + `DB_PORT` + `DB_USER` + `DB_PASSWORD` +
`DB_NAME` (the guard requires all five). Some additionally touch Hermes/media plumbing as noted.

| File | What it proves against real Postgres | Extra env |
|---|---|---|
| `tests/insights-sync-runs-sweep.requires-infra.test.ts` | the stranded-run sweep predicate flips only stale `'running'` rows, and the dispatcher's terminal-ok UPDATE overrides a mid-flight sweep + clears the abort message (rolled back) | — |
| `tests/insights-summary-current-followers.requires-infra.test.ts` | `summary.currentFollowers` is the SUM of each platform's LATEST follower count (`CURRENT_FOLLOWERS_SUM_SQL`), not MAX across platforms and not SUM across dated snapshots — seeds older+latest FB/IG rows and asserts 16k, not 10k/29k (rolled back) | — |
| `tests/publish-creative-asset-ids.test.ts` | `creative_asset_ids` round-trips through the real `posts` schema + `resolveMediaUrls` SQL (rolled back) | — |
| `tests/scheduled-posts-worker-campaign-sweep.test.ts` | the dead-campaign sweep terminally fails past-`campaign_end_date` rows, expires the never-live posts mirror, and skips live/fresh-in_flight rows (rolled back) | — |
| `tests/scheduled-posts-worker-end-date.test.ts` | the `campaign_end_date` column exists and the claim filter plans correctly | — |
| `tests/scheduled-posts-worker-live-db.test.ts` | the scheduled-posts worker drains/claims rows through the live schema (rolled back) | — |
| `tests/scheduled-dispatch-cutover.requires-infra.test.ts` | the production shared cutover CTE quarantines legacy unknown outcomes against the production `TEXT` dispatch-attempt token type, preserves provider-fenced work, and is idempotent (throwaway schema, created + dropped) | — |
| `tests/hackathon-register.test.ts` | `hackathon_registrations` accepts insert + upsert against the live schema (rolled back) | — |
| `tests/marketing/synthesize-publish-posts-live-db.test.ts` | publish-post synthesis + `UNSCHEDULED_POSTS_QUERY` against the real `scheduled_posts` schema | — |
| `tests/marketing/dashboard-publish-items-counter.test.ts` | `countPublishedPostsForJob` + dashboard projection against the live publish tables | — |
| `tests/marketing/ingest-production-assets-live-db.test.ts` | production creative-asset ingestion writes rows the dashboard reads | `HERMES_IMAGE_CACHE_MOUNT` for asset resolution |
| `tests/onboarding/taste-profile-requires-infra.test.ts` | `marketing_taste_profile` jsonb upsert merge/decay + `marketing_taste_signal` rating CHECK against the live schema (rolled back) | — |
| `tests/marketing/taste-tenant-scoped.requires-infra.test.ts` | the 20260609 tenant-scope relaxation (PK drop, nullable `user_id`, the two unique indexes) + tenant/per-user row coexistence + both upsert paths merge against the live schema (rolled back) | — |
| `tests/feedback-reports-store.requires-infra.test.ts` | the SC-70 `feedback_reports` store: transactional rate-limit boundary + dedup, the `FOR UPDATE SKIP LOCKED` retry claim (incl. no re-steal via `updated_at`), the attempts→`failed` boundary, and bytes-NULLing on sync (throwaway schema, created + dropped) | — |
| `tests/onboarding/variant-board-requires-infra.test.ts` | `creative_assets` variant_batch_id/variant_index columns + the board grouping query against the live schema (rolled back) | — |
| `tests/insights-llm-calls-drop.requires-infra.test.ts` | AA-129 item 12: the guarded drop of the dead `insights_llm_calls` table, EXECUTED — the deployed DO block is extracted from `scripts/init-db.js` (not duplicated, so it cannot drift from what ships) and run against a scratch schema. Proves both branches: an EMPTY table is dropped with its index, and a table WITH ROWS is preserved and warned about rather than destroyed — because "it never held a row" is an inference from the code, not a measurement of prod. Also that the block is a safe no-op when absent, since init-db runs it on every deploy forever. **Runs in CI** (`feedback-postgres`) | — |
| `tests/insights-endpoints.test.ts` | Insights endpoints Sections 2–9 against live schema + seed data; wires `aries_post_id` via a temp post insert, rolled back after. **Runs in CI** (`insights-endpoints-postgres`) — the only behaviour coverage the eight section endpoints have. `activeTimes` is asserted for COHERENCE (`hasData` agrees with whether a grid/peak is present), not for a fixed value: the seed dates comments randomly within 20 days, so how many land in the 7-day window — and therefore whether the heatmap clears its 8-event threshold — is not fixed | seed: `npm run db:seed-insights` |
| `tests/draft-expiry-sweep.requires-infra.test.ts` | the draft-expiry sweep's four statements plan against the real `posts`/`scheduled_posts` schema, the `'expired'` value is accepted by the `published_status`/`status` CHECK constraints, and the scheduled-row + too-recent guards hold (rolled back) | — |
| `tests/tenant/membership-backfill.requires-infra.test.ts` | the multi-workspace Phase 0 backfill `INSERT…SELECT` + membership/entitlement DDL from `scripts/init-db.js`: one membership per user-with-org, sentinel `password_hash='invited_pending'`→`status='invited'`, org-less exclusion, idempotent re-run (0 rows), `idx_users_email_lower_unique` rejects a case-variant email, `users.plan` default `'free'` (throwaway schema, created + dropped) | — |
| `tests/tenant/multi-workspace-phase2-concurrency.requires-infra.test.ts` | multi-workspace Phase 2 TRUE-concurrency races (real row locks, each arm on its own `PoolClient` like the routes): accept-vs-signin TOCTOU (no second password / double-activation), concurrent duplicate + cross-org first invite (one users row, coherent memberships, safe aborts not 500s), symmetric admin demotes (never zero admins), free-limit double-accept (exactly one 402), accept-vs-revoke (no torn half-join). Asserts the true SAFE contract (invariant + no silent success, tolerating serialization/deadlock aborts) and documents deadlock-serialization findings for the guard + entitlement locks (throwaway schema, created + dropped) | — |
| `tests/tenant/second-workspace-create-entitlement.requires-infra.test.ts` | multi-workspace Phase 4 second-workspace CREATE path (Decision 8b/13): replays the onboarding create transaction (entitlement gate → org create → assign, ROLLBACK on denial) against the real schema — a FREE account's second workspace is denied with NOTHING created (no org/membership, pointer unchanged), a PRO account creates it, a zero-membership first workspace is free, and the `tenant_admin` force-set never elevates the role in an existing org (self-escalation guard). Throwaway schema, created + dropped | — |
| `tests/tenant/organization-delete-repair.requires-infra.test.ts` | multi-workspace Phase 4 org-deletion pointer repair (Decision 11): composes `repairPointersForDeletedOrganization` (inside the delete txn) with the real claims resolver to prove a stranded user resolves to COMPLETE claims (MRU repoint) or a clean zero-membership chooser (NULL pointer) — never a dangling-pointer claims-incomplete hard-fail — the users row always survives, flag OFF clears the pointer to NULL only (bare cascade), and a bystander org is untouched. Throwaway schema, created + dropped | — |
| `tests/tenant/set-user-plan-cli.test.ts` | the `scripts/billing/set-user-plan.ts` grant CLI write path (Decision 13): a valid grant flips `users.plan` + stamps `plan_granted_at`/`plan_granted_by`, re-running is idempotent, a case-variant email matches the same row (LOWER(email) unique index), and a no-such-user grant exits nonzero. (The arg-validation exit-code cases run hermetically without a DB.) | — |
| `tests/insights-content-type-writer.requires-infra.test.ts` | S3-2 (gap C1) `insights_posts.content_type` writers against the real schema/planner: the dispatcher's `syncAccountForTenant` upsert stamps `content_type` on first sync; a second sync with a caption that would classify differently PRESERVES the first value via `COALESCE(insights_posts.content_type, EXCLUDED.content_type)` (caption itself still refreshes, proving it's a real preserve, not a stale no-op row); the standalone `runBackfillInsightsContentType` script classifies a pre-existing NULL row and is idempotent on a second run (0 newly classified). Real `organizations`/`insights_accounts`/`insights_posts` rows, explicit `DELETE FROM organizations` cleanup (cascades) | — |
| `tests/insights-account-dailies-upsert.requires-infra.test.ts` | S2-2/AA-93 (part 1/2): a later same-day sync REFRESHES the `insights_account_metrics_daily` row (`DO UPDATE`), instead of the old `DO NOTHING` intraday freeze (rolled back) | — |
| `tests/insights-post-metrics-upsert.requires-infra.test.ts` | S2-2/AA-93 (part 2/2): a later same-day sync REFRESHES the `insights_post_metrics_daily` per-post snapshot (`DO UPDATE`), not first-run-of-day-wins (rolled back) | — |
| `tests/insights-latest-snapshot-metrics.requires-infra.test.ts` | S2-1/AA-92: per-post readers use the LATEST lifetime snapshot per post via the shared `LATEST_POST_METRICS_LATERAL`, not SUM across dated cumulative rows (~N× inflation) (rolled back) | — |
| `tests/perf-insights-due-posts.requires-infra.test.ts` | S4-4/gap B2: `DUE_PERFORMANCE_POSTS_SQL` (the Honcho perf-leg read model) against the real planner — it had been frozen against a PROPOSED schema and named six columns the landed tables never created, so flipping `ARIES_INSIGHTS_513_TABLES_PRESENT=1` errored every tick and no mock could catch it. Proves the query resolves and returns the LATEST snapshot (not an older row or a SUM), that `views` surfaces as `video_views` for video media types only (an image post reports NULL, never its plain view count), that a `posts.platform='meta'` row still joins the `'facebook'` insights row (the normalization the sync dispatcher uses — a plain `LOWER()` compare would drop every Facebook post), and that a `honcho_perf_writes` row keyed on the PUBLISH day keeps excluding the post after a newer sync snapshot lands (the re-drive-forever bug) (rolled back) | — |
| `tests/insights-timezone-bucketing.requires-infra.test.ts` | S2-3/AA-94: SQL day-of-week bucketing derives the weekday in the TENANT's timezone (`EXTRACT(DOW FROM published_at AT TIME ZONE $tz)`), not UTC — boundary post lands on different weekdays per zone (rolled back) | — |
| `tests/insights-top-weakest.requires-infra.test.ts` | AA-229 PR2a review (F1/F2/F3): the Section 6 weakest-post query excludes a never-measured post (published <24h ago, no `insights_post_metrics_daily` row yet) from the ranked set instead of crowning its forced 0 as "weakest"; a tied metric resolves deterministically by `id ASC`, not whichever row Postgres happens to return first; and the weakest card is suppressed (not rendered as a duplicate of the #1 top-performer row) when only one post in the window is actually measured (rolled back) | — |
| `tests/usage-rollup-schema.requires-infra.test.ts` | AA-161: the usage time-series layer against the real schema — an hour aggregates with the right measures and AI runs that reported no usage stay OUT of the token sum while still being counted (`ai_events_with_usage` < `ai_events`), NULL tenant/user land on the 0 sentinel so the PK-based UPSERT matches, re-rolling an overlapping window converges instead of double counting, day/month buckets stay UTC under a `+05:45` session TimeZone, and the retention sweep purges past-window rows below the watermark while daily aggregates survive the raw rows they came from. Also (AA-162) `daily_company_usage` reconciles exactly against the grain it projects, carries the `ai_tasks`/`tasks_with_usage_reported` denominators that qualify a $0 COGS, and has the UNIQUE index without which the sidecar's `REFRESH ... CONCURRENTLY` would fail on every tick (rolled back) | — |

| `tests/billing/plan-rate-cards.requires-infra.test.ts` | AA-163: the four tiers seed and a PM's edited rate **survives a re-seed** (the `ON CONFLICT DO NOTHING` contract — a redeploy must not reset pricing); the subscription join returns the tier's allowance with a per-company override alongside it (the Custom/Enterprise path); the FK rejects a subscription for a company that does not exist; and the consumption statement runs against the real `daily_company_usage` / `usage_rollup_state` objects. Also (AA-164) the credit ledger's **partial** unique index — a redelivered gateway event credits once while two manual grants (NULL event id) both land, expired credits leave the balance without leaving the audit trail — and the `usage_alert_notifications` PK refuses a second claim for the same (company, period, threshold), which is what stops the hourly sweep emailing a customer every tick (rolled back) | — |

| `tests/marketing/auto-publish-gate-live-db.test.ts` | owner-gated auto-publish against a real planner: with `ARIES_AUTO_PUBLISH_GATE_ENABLED` off every tenant is still due, claimable and sweepable (the feature ships dark); with it on only a tenant holding an `enabled` `marketing_auto_publish_settings` row is admitted, while an `enabled=false` and an unseeded tenant are held out of both `DUE_ROWS_SQL` and `CLAIM_ROW_SQL`; and — the one that protects the week — a HELD row past `campaign_end_date` SURVIVES `SWEEP_DEAD_CAMPAIGN_SQL` with `dispatch_status='pending'` and its post still `approved`, instead of being marked failed/expired for want of an owner click (throwaway schema, created + dropped) | — |

A file joins this list the moment it calls `requireDbEnvOrSkip(t)`; keep this table in sync
(the report script will show the count drift if you forget).
