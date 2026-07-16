# S3-2 — `insights_posts.content_type` Production Writer (Post-Classification for Analytics)

**Date:** 2026-07-16
**Ticket:** S3-2 (gap C1) from `docs/plans/2026-07-07-analytics-page-roadmap.md`
**Status:** Planned + engineering-reviewed; not yet implemented.
**Method:** Drafted from a read-only code investigation, then engineering-reviewed: every load-bearing claim (vocabulary agreement, template versions, dispatcher seam, absence of theme metadata on the publish path) was re-verified against the code. File:line citations are as of `e967a39`. Review amendments are marked **[review]** inline and collected in §9.

---

## 1. Root cause

`content_type` is never written on any production path:

- The sync upsert at `backend/insights/sync/dispatcher.ts:202-220` inserts 11 columns and omits `content_type`; its `ON CONFLICT … DO UPDATE` refreshes only `title`, `caption`, `platform_data`.
- The column and partial index exist (`scripts/init-db.js:1249`, `:1252-1254`) but nothing populates them outside the demo seed (`scripts/seed-insights-extend.mjs`, round-robin over 6 values).
- The init-db comment at `scripts/init-db.js:1244-1246` claims *"content_type is set by Hermes at generation time on the posts table … propagated to insights_posts on sync."* Both halves are false: the `posts` table has **no** `content_type` column, and no propagation code exists (`grep content_type backend/marketing` → 0 hits).

Downstream, every reader COALESCEs NULL to a "pending" bucket: content-mix donut → `'uncategorized'` + a `pendingClassification` count (`activity-snapshot-builder.ts:146,174`); goal categories → `'other'` (`goal-snapshot-builder.ts:365,375,392`); the Top pattern card tallies everything as `uncategorized` and `buildWhyItWorked` skips its content-type sentence (`top-template-builder.ts:53-67,122-136`).

## 2. Design decision

**Pure deterministic heuristic, stamped inline at sync, plus a backfill script. Land UNFLAGGED (additive column stamp — the ticket's pre-approved unflagged branch). The Hermes-LLM classifier is scoped OUT as an optional flagged fast-follow, triggered by the coverage gate in §9.1.**

Rationale:

1. **Format ≠ theme (the core trap).** `media_type` is a *format* axis (`video|short|reel|image|carousel|story|text|live`); the reader vocabulary (educational/testimonial/…) is a *theme* axis — a reel can be any theme. Note `insights_posts` has **no** `surface` column (only `posts` does). The one signal that maps to theme buckets is the caption/title text, present for both Aries-published and external posts — so a caption-keyword heuristic serves both from one code path. **[review]** Verified: nothing on the Aries publish path (`synthesize*.ts`, `hermes-callbacks.ts`) carries pillar/theme metadata to join against today; the higher-fidelity "theme from the content package" path becomes possible only after S3-3 lands `aries_post_id` — deferred, see §9.2.
2. Zero external dependency, cost, or latency; fully deterministic → pinnable in `npm run verify`. The LLM path can't run for real in verify and needs a fake gateway.
3. Additive, unflagged, smallest reviewable diff → fastest to the acceptance bar.
4. The COALESCE-preserve conflict rule (§4) leaves a clean seam for a later LLM leg to fill only NULL rows with no rewrite.

## 3. Canonical vocabulary — PINNED

The exact stored set all readers + the seed agree on is **six values**:

```
educational | lifestyle | testimonial | announcement | promotional | engagement
```

Evidence: seed `scripts/seed-insights-extend.mjs:44`; `CONTENT_TYPE_NOTES` keys `top-template-builder.ts:29-37`; keyed branches in `buildWhyItWorked` `top-template-builder.ts:53-67`; honesty-pass fixture uses `'testimonial'` (`tests/insights-honesty-pass.test.ts:56`).

`NULL` is the "pending" sentinel; readers render it as `'uncategorized'` (activity/top) or `'other'` (goal). **The writer must store one of the six or leave NULL — never the literal strings `'uncategorized'`/`'other'`** (display-only COALESCE defaults; storing them would corrupt the `pendingClassification` count and mis-key the pattern-card note). The set lives in ONE shared module (§5 file 1) so it cannot drift. **[review]** `categoryLabel` (`goal-snapshot-builder.ts:64`) is generic capitalization, so the goal section tolerates any stored value — the drift tripwire protects the Top pattern card's keyed copy specifically.

## 4. Derivation hook + conflict semantics

**Hook:** inline in the existing `fetchPostList` upsert loop at `dispatcher.ts:200-222`. Compute `content_type` in JS from `rp.caption`/`rp.title`/`rp.mediaType` (already in hand — no new query, no fan-out; guardrail #1 untouched), add it as a 12th INSERT column.

**Conflict rule — COALESCE-preserve (first-confident-write-wins; NULL keeps retrying):**

```sql
content_type = COALESCE(insights_posts.content_type, EXCLUDED.content_type)
```

- A non-NULL bucket (heuristic, seed, or future LLM leg) is never clobbered by later syncs — mirrors the frozen-label contract of classify-comments (`ON CONFLICT DO NOTHING`, `dispatcher.ts:438`).
- While NULL, each sync re-attempts, so a post first seen with an empty caption upgrades once the caption matches.
- Follow-up (out of scope, state in the PR): a posts re-classification path, parallel to the comments re-classify ticket (C5/S4-3), if caption edits should re-theme a frozen row.

**Backfill:** the inline stamp only touches posts returned by `fetchPostList` (recent window). A standalone batched script using the same shared classifier handles history: `UPDATE … SET content_type = <classified> WHERE content_type IS NULL` — idempotent, `--tenant N`/`--all`, `--dry-run`, sequential batches (no `Promise.all`).

## 5. Files to touch

| # | File | Change |
|---|------|--------|
| 1 | **NEW** `backend/insights/sync/classify-post.ts` | The ONE vocabulary home: export `CONTENT_TYPES` (6-tuple), `type ContentType`, pure `classifyPostContentType({caption,title,mediaType}): ContentType \| null` (no DB/IO; deterministic keyword precedence; NULL when no confident match). Beside `classify-comments.ts` for discoverability. |
| 2 | `backend/insights/sync/dispatcher.ts:200-222` | Import classifier; compute per `rp`; add INSERT column + bind param; add the COALESCE-preserve line to `DO UPDATE`. This *is* the narrowest seam — the single upsert that writes `insights_posts`; adds no query, no pool pressure, no control-flow branch. |
| 3 | **NEW** `scripts/backfill-insights-content-type.ts` | Batched, idempotent, `WHERE content_type IS NULL`, `--tenant`/`--all`/`--dry-run`; reuses the shared classifier; sequential loop. **[review]** `--dry-run` must print the bucket distribution + % classified — it feeds the §9.1 coverage gate. |
| 4 | `scripts/init-db.js:1244-1246` | Replace the false "set by Hermes … propagated on sync" comment with the truth (derived at sync by the heuristic + one-off backfill). Comment-only; column/index already exist → **no migration needed**. |
| 5 | `backend/insights/activity/handler.ts:30`, `goal/handler.ts:35`, `top/handler.ts:37` | Bump `activity-v5→v6`, `goal-template-v6→v7`, `top-v6→v7`. The `inputHash` hashes only `tenantId\|period\|platform\|TEMPLATE_VERSION` — NOT the data — so without the bump a cached section keeps rendering "pending classification" up to the 1h TTL after backfill. Bump cost is zero (template renders, `cost_cents=0`). Do **not** bump narrative/trends (scope). |
| 6 | Tests | §6. |

## 6. Test strategy

- **NEW `tests/insights-content-type-classify.test.ts`** (in `npm run verify`): each of the 6 buckets reachable from a representative caption; deterministic precedence on overlapping keywords; empty/NULL/whitespace → `null`; **vocabulary-lock** (output ∈ `CONTENT_TYPES ∪ {null}`); **source-guard** asserting `CONTENT_TYPES` equals the seed's array and ⊆ `CONTENT_TYPE_NOTES` keys (drift tripwire, modeled on `tests/insights-honesty-pass.test.ts:41-51`).
- **Dispatcher upsert coverage** via the existing `SyncDeps` fake-pool seam (`dispatcher.ts:41-54`): assert the INSERT binds `content_type` and the `DO UPDATE` carries the COALESCE-preserve clause; re-sync of a classified row does not overwrite.
- **requires-infra (recommended)**: live-DB — sync stamps; caption-edit + re-sync preserves; backfill ×2 idempotent. Gate with `requireDbEnvOrSkip`; index in `tests/REQUIRES_INFRA.md`.
- Focused gate: `npm run test:insights`; the whole change green under `npm run verify`.

## 7. Flag strategy

Heuristic branch lands **unflagged** (ticket-sanctioned: additive column stamp). If/when the Hermes-LLM fast-follow is taken (§9.1): new `backend/insights/sync/classify-post-hermes.ts` (classify-comments clone), a best-effort dispatcher leg filling NULL rows one bounded batch/tick isolated to `legErrors`, behind `ARIES_POST_CONTENT_CLASSIFICATION_ENABLED` (`:-0`) wired into the **`aries-insights-sync-worker`** env block (+ `.env.example` + CLAUDE.md entry) — exactly the flag decision recorded on the ticket.

## 8. Risks & edge cases

- **Format ≠ theme:** never map `media_type → content_type` 1:1; caption is primary, `media_type` at most a weak tiebreaker.
- **caption NULL/empty:** classifier returns `null` → honestly pending (aligned with S3-1's no-fabricated-data bar). No forced catch-all bucket.
- **Platform differences:** FB/IG caption, YT title+description, X/LinkedIn/Reddit copy all land in `caption`/`title`; keying on both keeps it platform-agnostic.
- **Vocabulary drift:** a stray 7th value degrades silently in the pattern card (`CONTENT_TYPE_NOTES[leadType] ?? ''`) — no crash; the source-guard test prevents it.
- **Overwrite semantics:** COALESCE-preserve freezes a caption-edited post's theme (same trade-off as frozen comment labels); re-classify is an explicit follow-up, not folded in.
- **Guardrail #1:** inline stamp adds zero queries; backfill + any LLM leg strictly sequential; worker `DB_POOL_MAX=3` unaffected.
- **Scope guard:** do not touch `aries_post_id` (S3-3), attribution views (S4-1), or reach/saves ingest (S4-2).

## 9. Engineering-review amendments

**9.1 Coverage gate (the review's main addition).** A keyword heuristic can leave most rows NULL, which would fail the acceptance bar ("real buckets on a live tenant") while every unit test passes. Therefore: run the backfill `--dry-run` on the live tenant FIRST and record % classified + bucket distribution in the PR. **Decision rule: ≥60% of the live tenant's window classified → ship heuristic-only; below 60% → the flagged Hermes-LLM fast-follow (§7) is promoted from optional to scheduled next.** This converts a judgment call into a measurable gate.

**9.2 Aries-published high-fidelity path — deferred, on record.** Once S3-3 stamps `aries_post_id`, the theme for Aries-published posts can come from the strategy/content-package source of truth via a join instead of caption inference. Not a blocker; noted so S3-3's review remembers the consumer.

**9.3 TEMPLATE_VERSION bumps ratified** (file #5): without them a same-day live acceptance check can falsely fail on 1h-stale cache rows.

**9.4 Verified-claims log:** six-value vocabulary agreement (seed ↔ notes keys) ✓; template versions v5/v6/v6 current ✓; `SyncDeps` seam exists ✓; no theme metadata on the publish path ✓; `categoryLabel` generic ✓; no migration needed (column + index already shipped) ✓.

## 10. Rollout / live-tenant verification

1. Implement per §5; `npm run verify` green; `guardrails:agent` clean before the PR opens.
2. Suggested commit scope: `feat(insights): derive insights_posts.content_type at sync + backfill` (closes gap C1).
3. On the prod tenant: backfill `--dry-run` → record coverage (§9.1 gate) → commit backfill → confirm on `/insights`: **content-mix donut shows real slices**, **goal categories show named buckets**, **Top pattern card names a leading format**. With the TEMPLATE_VERSION bumps this shows on the next page load.
4. Watch `insights_sync_runs` stays `ok`/`partial` (the inline stamp is pure JS with no throw path). If the LLM leg ships later: verify one batch, and that a classifier outage only downgrades to `partial` via `legErrors`, never zeroes buckets.

**Routing:** `aries-backend` (owner: `backend/insights/**`, `scripts/**`) → `aries-test-author` (focused gate `npm run test:insights`, full `npm run verify`) → `aries-reviewer`. No `aries-integrations` involvement unless the LLM fast-follow is taken (then serialize the `docker-compose.yml` worker-env overlap after the core change).
