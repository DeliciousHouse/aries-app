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

Without `ARIES_TEST_REQUIRES_INFRA_ENABLED` (or without all five `DB_*`), the command is
informational only and these files skip — exactly as the `full-suite` CI gate sees them.

## Index

All files below gate on the **superset** `DB_HOST` + `DB_PORT` + `DB_USER` + `DB_PASSWORD` +
`DB_NAME` (the guard requires all five). Some additionally touch Hermes/media plumbing as noted.

| File | What it proves against real Postgres | Extra env |
|---|---|---|
| `tests/publish-creative-asset-ids.test.ts` | `creative_asset_ids` round-trips through the real `posts` schema + `resolveMediaUrls` SQL (rolled back) | — |
| `tests/scheduled-posts-worker-end-date.test.ts` | the `campaign_end_date` column exists and the claim filter plans correctly | — |
| `tests/scheduled-posts-worker-live-db.test.ts` | the scheduled-posts worker drains/claims rows through the live schema (rolled back) | — |
| `tests/hackathon-register.test.ts` | `hackathon_registrations` accepts insert + upsert against the live schema (rolled back) | — |
| `tests/marketing/synthesize-publish-posts-live-db.test.ts` | publish-post synthesis + `UNSCHEDULED_POSTS_QUERY` against the real `scheduled_posts` schema | — |
| `tests/marketing/dashboard-publish-items-counter.test.ts` | `countPublishedPostsForJob` + dashboard projection against the live publish tables | — |
| `tests/marketing/ingest-production-assets-live-db.test.ts` | production creative-asset ingestion writes rows the dashboard reads | `HERMES_IMAGE_CACHE_MOUNT` for asset resolution |

A file joins this list the moment it calls `requireDbEnvOrSkip(t)`; keep this table in sync
(the report script will show the count drift if you forget).
