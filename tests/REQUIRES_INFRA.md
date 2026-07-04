# Requires-infra tests

Most of the Aries test suite is **self-contained**: it mocks `pool.query`, writes fixtures
under a per-test `mkdtemp` `DATA_ROOT`, and opens no socket. Those tests run on every CI
`full-suite` invocation.

A small set of tests are **requires-infra**: they exercise the *real* Postgres schema / SQL
and only pass meaningfully against a reachable database. They self-skip with
`t.skip('database env not configured')` via the shared guard
[`tests/helpers/requires-infra.ts`](./helpers/requires-infra.ts) (`requireDbEnvOrSkip`) when
the DB env is absent — so the `full-suite` CI gate counts them as skipped, never failed.

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
| `tests/publish-creative-asset-ids.test.ts` | `creative_asset_ids` round-trips through the real `posts` schema + `resolveMediaUrls` SQL (rolled back) | — |
| `tests/scheduled-posts-worker-end-date.test.ts` | the `campaign_end_date` column exists and the claim filter plans correctly | — |
| `tests/scheduled-posts-worker-live-db.test.ts` | the scheduled-posts worker drains/claims rows through the live schema (rolled back) | — |
| `tests/hackathon-register.test.ts` | `hackathon_registrations` accepts insert + upsert against the live schema (rolled back) | — |
| `tests/marketing/synthesize-publish-posts-live-db.test.ts` | publish-post synthesis + `UNSCHEDULED_POSTS_QUERY` against the real `scheduled_posts` schema | — |
| `tests/marketing/dashboard-publish-items-counter.test.ts` | `countPublishedPostsForJob` + dashboard projection against the live publish tables | — |
| `tests/marketing/ingest-production-assets-live-db.test.ts` | production creative-asset ingestion writes rows the dashboard reads | `HERMES_IMAGE_CACHE_MOUNT` for asset resolution |
| `tests/onboarding/taste-profile-requires-infra.test.ts` | `marketing_taste_profile` jsonb upsert merge/decay + `marketing_taste_signal` rating CHECK against the live schema (rolled back) | — |
| `tests/marketing/taste-tenant-scoped.requires-infra.test.ts` | the 20260609 tenant-scope relaxation (PK drop, nullable `user_id`, the two unique indexes) + tenant/per-user row coexistence + both upsert paths merge against the live schema (rolled back) | — |
| `tests/feedback-reports-store.requires-infra.test.ts` | the SC-70 `feedback_reports` store: transactional rate-limit boundary + dedup, the `FOR UPDATE SKIP LOCKED` retry claim (incl. no re-steal via `updated_at`), the attempts→`failed` boundary, and bytes-NULLing on sync (throwaway schema, created + dropped) | — |
| `tests/onboarding/variant-board-requires-infra.test.ts` | `creative_assets` variant_batch_id/variant_index columns + the board grouping query against the live schema (rolled back) | — |
| `tests/insights-endpoints.test.ts` | Insights endpoints Sections 2–9 against live schema + seed data; wires `aries_post_id` via a temp post insert, rolled back after | seed: `npm run db:seed-insights` |
| `tests/draft-expiry-sweep.requires-infra.test.ts` | the draft-expiry sweep's four statements plan against the real `posts`/`scheduled_posts` schema, the `'expired'` value is accepted by the `published_status`/`status` CHECK constraints, and the scheduled-row + too-recent guards hold (rolled back) | — |
| `tests/tenant/membership-backfill.requires-infra.test.ts` | the multi-workspace Phase 0 backfill `INSERT…SELECT` + membership/entitlement DDL from `scripts/init-db.js`: one membership per user-with-org, sentinel `password_hash='invited_pending'`→`status='invited'`, org-less exclusion, idempotent re-run (0 rows), `idx_users_email_lower_unique` rejects a case-variant email, `users.plan` default `'free'` (throwaway schema, created + dropped) | — |
| `tests/tenant/multi-workspace-phase2-concurrency.requires-infra.test.ts` | multi-workspace Phase 2 TRUE-concurrency races (real row locks, each arm on its own `PoolClient` like the routes): accept-vs-signin TOCTOU (no second password / double-activation), concurrent duplicate + cross-org first invite (one users row, coherent memberships, safe aborts not 500s), symmetric admin demotes (never zero admins), free-limit double-accept (exactly one 402), accept-vs-revoke (no torn half-join). Asserts the true SAFE contract (invariant + no silent success, tolerating serialization/deadlock aborts) and documents deadlock-serialization findings for the guard + entitlement locks (throwaway schema, created + dropped) | — |

A file joins this list the moment it calls `requireDbEnvOrSkip(t)`; keep this table in sync
(the report script will show the count drift if you forget).
