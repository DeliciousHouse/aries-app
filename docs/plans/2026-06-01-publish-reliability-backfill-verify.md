# Run + verify the creative_asset_ids backfill on prod (publish-the-right-media)

**Status:** Open. Operational + verification plan (no new feature code). 2026-06-01.
**Roadmap:** Public-readiness area 1(c) — "backfill+verify creative_asset_ids so the right post publishes with the right media." Top-10-to-build-first item 7 (publish reliability).
**Reconciles (NOT re-plans):** `docs/plans/2026-05-30-publishing-reliability.md`. That plan's code legs already shipped in **#519** (`c1ac1d2` — "Meta failure taxonomy + reconnect signal + creative_asset_ids backfill"). This plan executes the one leg #519 left undone: the backfill has **never actually run against prod**, and the manual-schedule path is **unverified against live data**.
**Related (already merged — do not redo):**
- `scripts/backfill-creative-asset-ids.mjs` — the one-shot script (shipped #519, idempotent, dry-run default).
- `tests/backfill-creative-asset-ids.test.ts` — fixture test of the pure `backfillCreativeAssetIds()` function (shipped #519).
- `app/api/internal/publishing/scheduled-dispatch/route.ts:39-61` — resolver doc comment, **already rewritten** in #519 to say "the populated per-post join is the primary path" (the original plan's "stale comment" is gone).

---

## Context

`posts.creative_asset_ids` (`TEXT[] NOT NULL DEFAULT '{}'`, `scripts/init-db.js:432`) is the per-post media link that lets `resolveMediaUrls` (`scheduled-dispatch/route.ts:76-131`) pick the **exact** image for one scheduled post instead of falling back to a job-scoped join that returns **every** image the weekly job generated. A multi-image weekly job dispatched off the fallback can publish the **wrong creative** to a live Meta account — a brand-visible mistake on @sugarandleather.

#519 shipped the entire **code** side of `docs/plans/2026-05-30-publishing-reliability.md`:
- The write paths populate the column on every new row (`synthesize-publish-posts.ts:478,507`; `publish-verification.ts:159-182`; the fb/ig publish handlers).
- The backfill **script exists** (`scripts/backfill-creative-asset-ids.mjs`) and its pure function is fixture-tested.
- The resolver's `resolveMediaUrls` join already prefers populated ids and keeps the job-scope fallback (D2).
- The Meta failure taxonomy (`classifyMetaPublishFailureKind`, `meta-publishing.ts`) + `needs_reconnect` surface shipped too — **out of scope here** (this plan is the media-correctness leg only).

What #519 did **not** do, and what this plan covers:

1. **The backfill has never been run against prod.** Every `posts` row written before the #519 writers landed still has `creative_asset_ids = '{}'` and dispatches off the fallback. `psql` is not installed in this worktree and the DB env is not in the shell, so the row counts are unknown until the script is run with prod env loaded.
2. **The manual social-content schedule path is unverified.** `upsertScheduledPost` (`backend/social-content/scheduled-posts.ts:68-95`) **does not touch `creative_asset_ids`** (verified — the SQL only writes `scheduled_posts`); it inherits whatever the underlying `posts` row already had. `resolveMediaUrls` reads `posts.creative_asset_ids` by `post_id` at **dispatch** time, so the manual path is correct **iff** the `posts` row was populated. After the backfill that becomes true for legacy single-asset rows — but it must be **verified on live data**, not assumed.

This is **not a feature.** It is: run a dry-run, read the report, run for real, verify on the live DB that the right asset resolves, then make the verification durable (a live-DB test + a documented invariant). Per the treat-as-production guardrail, every step is validated against the live DB; per "user-visible completion = rendered UI," done means a multi-image job's scheduled post renders its **own** image in the operator dashboard — not a green script log.

## Who cares

- **Brendan (single-tenant prod operator):** publishing the wrong image to a live Meta account is the exact brand-visible failure this column was added to prevent. Backfill is the difference between "the right image goes out" and "a coin-flip among the week's images."
- **The scheduled-posts worker** (`scripts/automations/scheduled-posts-worker.mjs`, running now as `aries-app-aries-scheduled-posts-worker-1`): it dispatches whatever `resolveMediaUrls` returns. Populated rows make its output deterministic.
- **Future performance/Honcho loop:** attribution back to a specific creative requires the per-post link to be real, not a job-wide bag.

## Decisions (locked — do not re-litigate)

- **D1.** No code changes to the backfill script, the resolver, or the writers. They shipped in #519 and are correct. This plan **runs** and **verifies** them, and adds *only* a live-DB regression test + doc/runbook entries.
- **D2.** The backfill runs **dry-run first**, against prod env, and the report is captured verbatim before any `--write`. Treat-as-production: no `--write` until the dry-run counts are read and sanity-checked by a human.
- **D3.** Run mechanism is **`node scripts/backfill-creative-asset-ids.mjs`** with the prod `DB_*` env loaded from `/home/node/docker-stack/aries-app/.env` (the script uses the `pg` Node driver, not `psql`). Run it **from inside the running app container** (`aries-app-aries-app-1`) or with the prod `.env` sourced, so it hits the same DB the app does. Do **not** invent a new DB connection path.
- **D4.** The script is already idempotent (only touches `array_length(creative_asset_ids,1) IS NULL` rows; never deletes ids; tenant-scoped + sequential per guardrail #1). Re-running is a no-op. We rely on that — we do not add transaction wrapping or batching unless the dry-run shows a row count large enough to matter (it will not at single-tenant scale).
- **D5.** Multi-asset legacy rows with no `post_number` are **left on the fallback** by design (the script counts them as `ambiguousMulti` and does not guess). This plan does **not** attempt to disambiguate them — that is explicitly out of scope (no `post_number` on legacy rows = unknowable mapping). If the dry-run shows a non-trivial `ambiguousMulti` count, file a follow-up; do not expand scope.
- **D6.** "Make the populated path primary" (the original plan's P2) is **already done** in #519's resolver doc. This plan only *verifies* the populated path is taken on live data and adds the durable test — it does not re-edit the resolver.
- **D7.** No feature flag. This is a data backfill + read-time behavior that is already live; there is no user-facing behavior toggle to gate. The closest thing to a "rollout switch" is the script's own `--write` flag (dry-run default), which is the safety gate. See "Feature flag" below for why a `ARIES_*_ENABLED` flag is intentionally not added.

## Current State (VERIFIED this worktree, master @ `3ad77e6`)

- **Schema:** `posts.creative_asset_ids TEXT[] NOT NULL DEFAULT '{}'` — `scripts/init-db.js:432`.
- **Backfill script:** `scripts/backfill-creative-asset-ids.mjs` exists. Exports pure `backfillCreativeAssetIds(db, { write, tenantFilter, log })` returning `{ tenants, total, populated, empty, ambiguousMulti }`. `main()` builds a `pg.Pool` from `DB_*` env and prints a report. Dry-run unless `--write`. `--tenant <id>` limits scope. Only invoked directly (guards `import.meta.url`), so the test imports the pure function cleanly.
- **Backfill test:** `tests/backfill-creative-asset-ids.test.ts` drives `backfillCreativeAssetIds` against an in-memory fake reproducing the SQL semantics (DISTINCT tenants, candidate posts, ordered assets, idempotent UPDATE). Passes today.
- **Resolver:** `resolveMediaUrls` (`scheduled-dispatch/route.ts:76-131`) joins `posts → creative_assets` matching `ca.id::text = ANY(p.creative_asset_ids) OR ca.source_asset_id = ANY(p.creative_asset_ids)` when the array is non-empty (per-post primary, lines 95-100), else the job-scope fallback `ca.source_job_id = p.job_id` (lines 101-106). The doc comment (lines 51-61) **already** states the populated join is primary and the script backfills legacy rows — the "stale comment" the original plan targeted is **gone**.
- **Manual schedule path:** `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:211` → `upsertScheduledPost`. `upsertScheduledPost` (`backend/social-content/scheduled-posts.ts:68-95`) writes **only** `scheduled_posts` columns (`post_id, tenant_id, scheduled_for, target_platforms, campaign_end_date, surface, media_type`). It does **not** read or write `creative_asset_ids` — confirmed by grep (zero references in the file). It inherits the `posts` row's media link; correctness depends entirely on that row being populated.
- **Runtime:** `aries-app-aries-app-1` (healthy) and `aries-app-aries-scheduled-posts-worker-1` are running against the prod DB configured in `/home/node/docker-stack/aries-app/.env` (`DB_HOST`/`DB_PORT=5432`/`DB_USER`/`DB_NAME` all set). `psql` is **not** installed in this worktree; the script's `pg`-driver path is the only DB access route. The deployed image tag (`670699944...`) **does contain** the backfill script (verified `docker exec ... ls`), so the in-container run path is available.
- **Suite membership:** the backfill test and the resolver tests are **not** in `scripts/verify-regression-suite.mjs` (fast suite); they run in the full CI suite. The live-DB test added by this plan follows the existing `tests/marketing/*-live-db.test.ts` skip-when-no-DB precedent.

## Architecture (what runs, in order)

```
 (1) DRY-RUN                         (2) REVIEW                    (3) WRITE
 node backfill-creative-asset-ids    read report:                 node backfill... --write
   (prod DB_* env, no --write)         tenants / total /            (only after human OK)
        │                              populated / empty /              │
        ▼                              ambiguousMulti                    ▼
 SELECT empty-array posts w/ job_id ───────────────────────► UPDATE posts SET creative_asset_ids
 per tenant, sequential (guardrail #1)                        = ARRAY[source_asset_id]  (1-asset rows only)
        │                                                            │
        └── multi-asset rows → counted, LEFT on fallback (D5)        │
                                                                     ▼
 (4) VERIFY on live DB                                        resolveMediaUrls now returns the
   - re-run dry-run → populated count == 0 (idempotent no-op)   per-post asset for backfilled rows
   - pick a real multi-image job's scheduled post, confirm
     resolveMediaUrls returns ONE image == that post's asset
   - confirm manual-schedule path: upsertScheduledPost row →
     dispatch resolves the post's own image (not the job bag)
        │
        ▼
 (5) DURABLE                                                  (6) DASHBOARD (done bar)
   tests/marketing/backfill-creative-asset-ids-live-db.test.ts   operator opens the scheduled post in
   asserts populated rows resolve per-post on real PG            calendar/posts screen → its preview
   (skip-when-no-DB precedent)                                   shows ITS image; worker dispatch log
        │                                                        shows one media_url == that asset
        ▼
   runbook entry in docs/ + CHANGELOG
```

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| P0 | Pre-flight: load prod env, confirm DB reachability + current `'{}'` row count | P1 | S / S | none |
| P1 | Dry-run on prod, capture the report verbatim | P1 | S / S | P0 |
| P2 | Real `--write` run on prod + idempotency re-check | P1 | S / S | P1 (human OK on counts) |
| P3 | Live-DB verification of per-post resolution + manual-schedule path | P1 | M / M | P2 |
| P4 | Durable: live-DB regression test + runbook + CHANGELOG | P1 | S / S | P3 |

---

### P0 — Pre-flight (load prod env, confirm reachability + baseline counts)

**Goal:** before touching anything, establish a baseline so the dry-run report is interpretable and the run is provably scoped to the prod DB the app uses.

**Steps:**
1. Source the prod DB env (do not echo secrets): the canonical values live in `/home/node/docker-stack/aries-app/.env` (`DB_HOST`, `DB_PORT=5432`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`). Run the script **inside the live app container** so it shares the exact DB target the worker dispatches against:
   ```
   docker exec -e NODE_ENV=production aries-app-aries-app-1 \
     node scripts/backfill-creative-asset-ids.mjs --help   # confirms the script is present in the image
   ```
   (The deployed image `670699944...` has been verified to contain `scripts/backfill-creative-asset-ids.mjs` via `docker exec aries-app-aries-app-1 ls scripts/backfill-creative-asset-ids.mjs`, so the in-container path works. If a future redeploy ever ships an image predating #519, fall back to host execution with the prod `.env` sourced: `set -a; . /home/node/docker-stack/aries-app/.env; set +a; node scripts/backfill-creative-asset-ids.mjs` from this worktree, which also has the script.)
2. Baseline count (read-only, via the script's own dry-run, **not** a hand-written `psql` — `psql` is absent). The dry-run report's `total` is the count of empty-array rows with a `job_id` (the candidates). Record it. This is the P1 deliverable's input.

**Acceptance:** the script runs in the chosen environment and connects to the prod DB without error; the candidate-row count is known. No writes yet.

### P1 — Dry-run on prod + capture the report

**Goal:** know exactly what the `--write` run will do before it does it (D2).

**Steps:**
1. Run the dry-run (default, no `--write`):
   ```
   node scripts/backfill-creative-asset-ids.mjs            # dry-run
   ```
2. Capture the full report verbatim into the run record (paste into the PR description / runbook, not a committed log file). The report prints:
   ```
   tenants scanned    : N
   candidate rows      : total
   populated (1 asset) : X (dry-run)
   empty (0 assets)    : Y
   ambiguous (N>1)     : Z (left on fallback)
   ```
3. Sanity-check the counts against expectations: single-tenant prod, so `tenants` is small; `populated` is the number of legacy single-image-job posts that will be fixed; `ambiguousMulti` (`Z`) is the multi-image legacy rows that **stay on the fallback** (D5). If `Z` is non-trivial and represents real multi-image weekly jobs, note it for a follow-up (still out of scope here).

**Acceptance:** the dry-run report is captured verbatim; a human has read `populated` / `empty` / `ambiguousMulti` and confirmed the `--write` is safe (no surprising magnitude, no cross-tenant smell). **Gate:** do not proceed to P2 without this human read (treat-as-production).

### P2 — Real `--write` run + idempotency re-check

**Goal:** populate the legacy single-asset rows; prove the run is idempotent.

**Steps:**
1. Run for real:
   ```
   node scripts/backfill-creative-asset-ids.mjs --write
   ```
   Capture the WRITE report. `populated` should equal the dry-run's `populated`.
2. Re-run dry-run immediately:
   ```
   node scripts/backfill-creative-asset-ids.mjs
   ```
   `populated` must now be **0** (every single-asset candidate was filled; the `array_length IS NULL` predicate no longer matches them). `empty` and `ambiguousMulti` may persist (genuinely zero-asset jobs and multi-asset legacy rows — both correctly left on the fallback). This is the idempotency proof on live data.

**Acceptance:** the WRITE report's `populated` matches the dry-run; the immediate re-run reports `populated: 0`. The data is now populated for every fixable legacy row, and re-running the script is a verified no-op (D4).

### P3 — Live-DB verification of per-post resolution + manual-schedule path

**Goal:** prove on the live DB that a backfilled row now resolves to **its own** image, and that the manual-schedule path inherits the populated link end-to-end. This is the real correctness check — not the script's self-report.

**Steps:**
1. **Per-post resolution (the core invariant).** Pick a real **multi-image** weekly job on prod that has a backfilled `posts` row with a non-empty `creative_asset_ids`. Drive `resolveMediaUrls(postId, tenantId)` against the live pool (a tiny throwaway `tsx` snippet importing the exported `resolveMediaUrls` from `scheduled-dispatch/route.ts:76`, or via the existing `aries-app-aries-app-1` container) and assert it returns **exactly that post's image**, not the whole job's image set. Repeat for a second post of the same job and confirm the two posts resolve to **different** images (the whole point of the per-post link).
2. **Manual-schedule path.** For a job whose post was created/backfilled with a populated row, exercise `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts` (or call `upsertScheduledPost` directly against the live pool) to create a `scheduled_posts` row, then run `resolveMediaUrls` for that `post_id` and confirm it resolves the post's own image. This proves the assertion in the original plan's P1 step 3: the manual path does not write `creative_asset_ids` but correctly inherits the populated `posts` row at dispatch time.
3. **Negative control.** Confirm a deliberately-empty row (`creative_asset_ids = '{}'`) still resolves via the job-scope fallback (D2 safety net intact). Do this against a fixture row or a known empty row — do **not** zero out a real populated row to test this.

**Acceptance (live DB):**
- A backfilled multi-image job's two posts resolve to **two different** images via `resolveMediaUrls`, each matching that post's `creative_asset_ids` asset.
- A `scheduled_posts` row created via the manual path resolves to the underlying post's own image.
- An empty row still resolves via the fallback (regression intact).

### P4 — Durable verification + runbook + CHANGELOG

**Goal:** make the verification repeatable so a future regression is caught, and document the operational procedure so the run is reproducible (e.g. after a DB restore).

**Steps:**
1. **Live-DB regression test** — new `tests/marketing/backfill-creative-asset-ids-live-db.test.ts`, following the `tests/marketing/ingest-production-assets-live-db.test.ts` / `tests/scheduled-posts-worker-live-db.test.ts` skip-when-no-DB precedent (`t.skip('database env not configured')` when `DB_*` unset). It: seeds a tenant-scoped job with 2 generated `creative_assets`, inserts 2 `posts` rows with empty `creative_asset_ids`, runs `backfillCreativeAssetIds(pool, { write:true })` — expecting `ambiguousMulti` for those 2-asset posts (proving the no-guess rule) — then inserts a single-asset job + post, backfills, and asserts `resolveMediaUrls` returns that post's own asset. Asserts a second backfill run is a no-op. This locks in both the script semantics **and** the resolver coupling on real PG.
2. **Runbook** — append a short "creative_asset_ids backfill" section to the operational docs (`docs/DEPLOYMENT.md` or a new `docs/runbooks/` entry if that dir exists — prefer extending an existing doc over a new file): the exact dry-run → review → `--write` → idempotency-recheck sequence, the prod-env source path, and the "review counts before `--write`" gate. Note that the script is **not** in `init-db.js` (D5) and must be re-run after any DB restore that predates a backfill.
3. **CHANGELOG** — record the prod backfill run (date, `populated`/`ambiguousMulti` counts) under the current version. Do **not** bump `VERSION` for a data-only run unless P4's test addition warrants a patch bump per repo convention (it is a test + docs change — a patch bump is appropriate when shipping the test).

**Acceptance:** the live-DB test passes against real PG and `t.skip`s cleanly without DB env (so CI without a DB stays green); the runbook documents the exact sequence; CHANGELOG records the run.

## Feature flag

**Intentionally none.** A `ARIES_<...>_ENABLED` flag is the right tool for new user-facing/behavioral code; this plan ships **no new behavior** — the populated-path-primary read already shipped in #519 and is live. The behavioral safety gate that *does* exist is the script's **dry-run default** (`--write` is opt-in), which is the operational equivalent of a default-OFF switch: nothing is written until a human passes `--write` after reading the report. Adding an env flag here would gate code that is already merged and correct, with no toggle surface to control. The treat-as-production guardrail is satisfied by the dry-run-first + human-count-review gate (D2), not by an env flag.

## User-visible success bar (rendered UI only — DB/script logs do NOT count)

Done means, in **Brendan's operator dashboard**:
1. Open a **multi-image** weekly job's scheduled post in the calendar/posts screen (`frontend/aries-v1/calendar-screen.tsx` carries per-post media via its `imageUrl` field; `posts-screen.tsx` / `post-workspace.tsx` render `previewUrl`/media for scheduled posts). Its preview shows **that post's own image** — and a *different* post of the same job shows a *different* image. Before the backfill, both could resolve to whichever image the fallback's `ORDER BY ca.id DESC LIMIT 4` happened to surface.
2. After the worker dispatches that post (or via the publish-status surface `app/dashboard/publish-status/page.tsx`), the published/scheduled record reflects the correct single image.

A green script report or a populated DB column is **necessary but not sufficient** — the bar is the rendered preview in the dashboard showing the right image per post.

## Testing + CI-exact verify steps

- **Fixture (existing, keep green):** `tests/backfill-creative-asset-ids.test.ts` — pure-function semantics.
- **Resolver (existing, keep green):** `tests/scheduled-dispatch-media-resolution.test.ts`, `tests/publish-creative-asset-ids.test.ts` — per-post-vs-fallback exact-URL assertions.
- **New live-DB:** `tests/marketing/backfill-creative-asset-ids-live-db.test.ts` (P4) — skip-when-no-DB; asserts backfill + per-post resolution + idempotent re-run on real PG.
- **Pre-push gate (CLAUDE.md):**
  ```
  npm run verify
  ```
- **Targeted full run for the touched seam** (routes/backend/worker-adjacent):
  ```
  APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test \
    tests/backfill-creative-asset-ids.test.ts \
    tests/scheduled-dispatch-media-resolution.test.ts \
    tests/publish-creative-asset-ids.test.ts \
    tests/marketing/backfill-creative-asset-ids-live-db.test.ts
  ```
- **Full suite before push** (the `full-suite` REQUIRED CI gate must be green):
  ```
  npm run test:concurrent
  ```
- **Banned patterns** (P4 docs must not reintroduce a banned literal):
  ```
  npm run validate:banned-patterns
  ```
- **Guardrail (parallel-agent):** `npm run guardrails:agent` before opening the PR.

**Resumability / idempotency:** the script only updates `array_length(creative_asset_ids,1) IS NULL` rows and never deletes ids, so an interrupted run resumes safely on re-invocation (already-filled rows are skipped). The live-DB test asserts the second run is a no-op. No partial-state cleanup is needed.

## Rollout

1. Land P4 (test + runbook + CHANGELOG) via normal `/ship` → CI → merge (code/docs only; no prod data touched by the merge).
2. **Then** run the operational sequence on prod (P0→P3): dry-run, human-review counts, `--write`, idempotency re-check, live-DB verification. The run is independent of the deploy — it is `node scripts/...` against the prod DB, not a release artifact.
3. Record the run's counts in the CHANGELOG entry / PR.

## Out of Scope

- **Meta failure taxonomy / `needs_reconnect` surface** — shipped in #519 (`classifyMetaPublishFailureKind`, the fb/ig handler `auth` branch, the worker `kind` surface). This plan is the media-correctness leg only.
- **Multi-asset legacy-row disambiguation** — legacy rows carry no `post_number`, so the post→asset mapping is unknowable; the script counts them (`ambiguousMulti`) and leaves them on the fallback (D5). Recovering them would need a `post_number` heuristic that does not exist; explicitly not attempted.
- **Changing `creative_asset_ids` column type or the dual-id-form join** (D1 of the parent plan) — unchanged.
- **Closing the double-publish window** — no Meta-side idempotency primitive; documented at `scheduled-dispatch/route.ts` and out of scope.
- **Video/Reel/Story media correctness** — `surface`/`media_type` columns exist (#520) but video publish is flag-gated OFF (`ARIES_VIDEO_PUBLISH_ENABLED`); this backfill targets image `posts` rows. Story image composition (#525) writes its own `creative_asset_ids` at synthesis and is not a legacy-row concern.
- **A new env flag** — see "Feature flag"; the dry-run default is the safety gate.

## Risks

- **R1 — Running against the wrong DB.** Mitigation: P0 runs the script from inside the live `aries-app-aries-app-1` container (or with the prod `.env` sourced), the exact DB the worker dispatches against; the dry-run report's tenant/row counts are sanity-checked before any write. No hand-written `psql` (it is absent — removes a foot-gun).
- **R2 — Wrong asset assigned to a single-asset row.** Low: the script only fills rows whose job produced **exactly one** asset, so the mapping is unambiguous (the one asset is the only candidate). Multi-asset rows are never touched. Rollback for a specific tenant: `UPDATE posts SET creative_asset_ids = '{}' WHERE tenant_id = $1 AND <condition>` re-enables the fallback (capture the dry-run report so the affected row set is known).
- **R3 — Manual-schedule path still publishes the job bag.** This is the bug class the plan exists to disprove. Mitigation: P3 explicitly drives `upsertScheduledPost` + `resolveMediaUrls` on live data and asserts a per-post image; the P4 live-DB test locks it in. If a post-creation path is found that leaves `creative_asset_ids` empty *after* the backfill, that is a P1 follow-up (file it; do not expand scope).
- **R4 — `ambiguousMulti` is large.** If the dry-run shows many real multi-image weekly jobs stuck on the fallback, the wrong-image risk persists for those. Mitigation: surface the count in the PR; a `post_number`-recording follow-up is a separate plan (out of scope here per D5).
- **R5 — A future redeploy ships an image predating #519.** The current running tag (`670699944...`) has been verified to contain the script, so the in-container path works today. Mitigation retained as a safety net: P0 step 1 re-checks `ls scripts/backfill-creative-asset-ids.mjs` in the container and falls back to host-with-`.env` execution from this worktree (which has the script) if it is ever absent.
- **R6 — Live-DB test flakiness / DB contention.** Mitigation: the test follows the established skip-when-no-DB pattern and is tenant-scoped + sequential (guardrail #1, no `Promise.all` over the pool); it cleans up its seeded rows.
