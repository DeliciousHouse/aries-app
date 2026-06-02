# ID-based Hermes media addressing (creative_assets.id)

Epic: GitHub issue #508. Risk **L**, investigation confidence **0.62**, load-bearing break on live publishing.

## Context

Generated creative images live in a **flat, non-tenant-namespaced** Hermes image cache, bind-mounted read-only into the Aries container at `HERMES_IMAGE_CACHE_MOUNT` (default `/hermes-media`). The browser-facing media route addresses these images by **basename only** and resolves bytes as `<mount>/<basename>` (`app/api/internal/hermes/media/[...path]/route.ts:64,77`). Basenames are not globally unique: two `creative_assets` rows from different tenants or jobs can share a filename (e.g. `image.png`), and Hermes is not guaranteed to emit collision-free names.

The ownership check, `tenantOwnsHermesMediaBasename` (`backend/marketing/runtime-state.ts:677`), gate-keeps the route with a **basename match** against `served_asset_ref`/`storage_key` (`SELECT 1 ... WHERE tenant_id=$1 AND $2 IN (regexp_replace(served_asset_ref,'^.*/',''), regexp_replace(storage_key,'^.*/',''))`, lines ~698-708). So if tenant A and tenant B both have a row whose ref ends in `image.png`, the check passes for **both**, and the route serves whichever file physically sits at `<mount>/image.png`. That is a cross-tenant content-serve bug, not just a theoretical collision.

Goal: address generated media by its primary key (`creative_assets.id`, a UUID), enforce ownership with the authoritative `WHERE id=$1 AND tenant_id=$2`, and resolve bytes from that row's `storage_key`.

## Who cares

- **Brendan / live tenants** — this is prod (live publishing tenants). A cross-tenant image serve is a data-leak class bug and the dashboard preview path runs through the same route.
- **Publishing pipeline** — FB/IG publishes sign internal media URLs to public proxy URLs; the cutover must not break live Meta fetches (see the load-bearing break below).
- **Security review** — basename-keyed ownership on a shared cache is exactly the kind of finding `/cso` flags.

## Decisions (locked, do not re-litigate)

1. **Address by `creative_assets.id` (UUID PK), not by basename.** Confirmed schema: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `UNIQUE (tenant_id, id)` (`scripts/init-db.js:178,195`).
2. **Ownership is enforced in SQL with `WHERE id=$1 AND tenant_id=$2`.** No more basename `regexp_replace` matching for id-addressed reads.
3. **Use `pool.query` directly, single query per request — no `Promise.all` fan-out** (guardrail #1). The id route is one indexed PK lookup; do not parallelize it with anything.
4. **404, never 403**, on missing row / wrong tenant / unresolvable bytes — preserve the existing no-existence-leak posture (route returns 404 throughout today).
5. **Keep the existing path-traversal guards** (`isWithinRoot` + double `realpath`) when resolving `storage_key` bytes. They stay verbatim.
6. **Tenant-scoping is non-negotiable** — every read resolves tenant context server-side via `loadTenantContextOrResponse()` (already the pattern at route.ts:41).

## Current State (VERIFIED)

- **Internal media route** `app/api/internal/hermes/media/[...path]/route.ts`
  - Session-auth via `loadTenantContextOrResponse()` (`:41`).
  - Accepts exactly one segment, treats it as a basename (`:56-64`), rejects separators/`..` (`:67`).
  - Resolves `path.resolve(mountRoot, basename)` (`:77`), double-realpath guard (`:88-112`).
  - Ownership: `tenantOwnsHermesMediaBasename(tenantId, basename)` (`:124`); 404 if not owned.
  - Streams bytes from the mount (`:134,151`).
- **Ownership fn** `backend/marketing/runtime-state.ts:677` — DB basename match first (`:698-708`), then sequential filesystem scan of tenant runtime JSON (`:716+`). Vulnerable to cross-tenant basename collision.
- **Ingest writer** `backend/marketing/ingest-production-assets.ts`
  - Writes `served_asset_ref = '/api/internal/hermes/media/<basename>'` (`:149`), `storage_kind='runtime_asset'`, `storage_key=readPath` (the in-container mount path) (`:80-93,154-161`).
  - `INSERT ... ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL DO NOTHING` — does **not** currently `RETURNING id`.
- **Public proxy** `app/api/public/media/[token]/[basename]/route.ts` — unauthenticated, gated by HMAC token; resolves bytes by **basename** against the mount (`:67-90`). Serves only `runtime_asset` mount files; cannot serve `ingested_asset` DATA_ROOT files.
- **Signing** `app/api/publish/dispatch/handler.ts:219 toSignedPublicUrl(internalUrl, tenantId, basename)` — token signs `{tenantId, basename, expiresAt}` (`lib/signed-media-token.ts:42`), URL is `/api/public/media/<token>/<basename>`. Callers compute `basename = path.basename(url)` then sign: dispatch handler `:306-308`, `publish-instagram/handler.ts:137`, `publish-facebook/handler.ts:132`, `scheduled-dispatch/route.ts:176`.
- **Workspace views** `backend/marketing/workspace-views.ts:1356` selects `served_asset_ref` and sets `previewUrl/fullPreviewUrl = row.served_asset_ref` (`:1543-1544`).
- **Upload-replace** `backend/marketing/upload-replace.ts:185` — manual uploads INSERT `storage_kind='ingested_asset'`, `storage_key=<DATA_ROOT path>`, and **no `served_asset_ref`** (column omitted → NULL). These uploads are **not servable** via the basename route today (latent bug).
- **Dashboard projection** `backend/social-content/dashboard-projection.ts` — preview URLs come from runtime-doc `artifact_url` / data-URIs (`:741,760`), not from `served_asset_ref`. Lowest blast radius.
- **Existing tests:** `tests/hermes-media-tenant-scope.test.ts`, `tests/marketing/ingest-production-assets.test.ts`, `tests/publish-creative-asset-ids.test.ts` (all present; live-db precedent exists).

## The load-bearing break (publishing)

If the internal URL becomes `/api/internal/hermes/media/<id>`, then `path.basename(url)` at the publish call sites yields the **UUID**. `toSignedPublicUrl` signs `{basename: <uuid>}`, and `/api/public/media/[token]/[basename]` resolves `<mount>/<uuid>` — which does not exist. **Live FB/IG publishes 404 at Meta-fetch time, silently.** This is why this issue is staged and not auto-shipped. Any cutover that changes `served_asset_ref` to id-based MUST fix the signing path in the same change, or publishing breaks.

## Architecture

```
                         BROWSER (operator session)
                              |
                              v
   GET /api/internal/hermes/media/<UUID>         <-- NEW: id branch
   GET /api/internal/hermes/media/<basename>     <-- KEPT: back-compat fallback
        |  session tenant ctx (loadTenantContextOrResponse)
        |
        +-- UUID?  SELECT storage_kind, storage_key, served_asset_ref, media_type
        |          FROM creative_assets WHERE id=$1 AND tenant_id=$2   (pool.query, 1 query)
        |              | no row -> 404
        |              v
        |          resolve bytes from storage_key (isWithinRoot + realpath) -> stream
        |
        +-- basename? tenantOwnsHermesMediaBasename(tenant, basename) -> <mount>/<basename>

                         META (Graph API fetch, no session)
                              ^
                              |
   GET /api/public/media/<token>/<basename-or-id>   <-- per Decision #1 (option A vs B)
        ^
        | toSignedPublicUrl(internalUrl, tenantId, ref)   publish handlers
        |     dispatch :306 / IG :137 / FB :132 / scheduled :176

  WRITERS:  ingest-production-assets.ts  -> served_asset_ref = /media/<id>  (RETURNING id)
            upload-replace.ts            -> served_asset_ref = /media/<id>  (optional, Decision #4)
```

## Open design decisions — recommendations

### Decision 1 — Signing fix: Option A or B? (gates the rollout)

- **Option A (recommended for v1):** Publish handlers resolve `id -> on-disk basename` (look up `creative_assets.storage_key`, take `path.basename`) **before** signing, so the signed public URL and `/api/public/media` stay basename-based and unchanged. Smaller diff, isolates the public proxy from this epic.
- **Option B:** Make `/api/public/media` id-aware (token carries id; route looks up `creative_assets` by id+tenant; can also serve `ingested_asset` DATA_ROOT files). Larger, but removes the public route's basename collision too and unblocks serving manual uploads to Meta.

**Recommendation: A for this epic, file B as a fast-follow.** Rationale: the internal-route fix already closes the cross-tenant *browser* serve (the security bug). The public proxy is token-gated (HMAC, 1h TTL, single approved image) so its basename collision window is far narrower, and it never serves cross-tenant by accident because the token binds `tenantId`. Doing A keeps the publish blast radius to "resolve id->basename before signing" — one helper, four call sites — and ships the security fix without touching the live Meta-fetch contract. Token shape (`signed-media-token.ts`) stays `{tenantId, basename, expiresAt}`, so existing in-flight tokens remain valid.

### Decision 2 — Cutover vs coexistence

**Recommendation: coexistence + keep the basename fallback route.** New ingest/upload rows get id-based `served_asset_ref`; old rows keep their basename refs and continue to resolve through `tenantOwnsHermesMediaBasename`. No backfill migration of historical `served_asset_ref` in v1. Rationale: a backfill is a write against a live prod table for marginal benefit (old rows already passed ownership), and the fallback route is cheap to keep. Revisit a backfill only if/when we delete the basename route.

### Decision 3 — Route shape: separate `[id]` vs fold into `[...path]`

**Recommendation: fold into the existing `[...path]` catch-all, branch on a strict UUID regex.** Next.js 16 route precedence between a single-segment `[id]` and `[...path]` for a UUID-shaped segment is unverified and fragile; one file with an explicit `UUID_RE.test(segments[0])` branch removes the ambiguity and keeps both code paths visible side by side. Single segment, UUID -> id path; single segment, not UUID -> basename path; anything else -> 404.

### Decision 4 — Also make `ingested_asset` (manual uploads) servable?

**Recommendation: yes, in this epic, via the internal id route only.** `upload-replace.ts` already has the row id at INSERT (`RETURNING id`, `:194`); add `served_asset_ref = '/api/internal/hermes/media/<id>'` and let the id route resolve `storage_kind='ingested_asset'` bytes from the DATA_ROOT `storage_key` (with the same realpath guard, rooted at the ingested-assets root, not the Hermes mount). This is a small, contained latent-bug fix. Do **not** expand the public proxy to ingested assets in v1 (that is Option B / fast-follow). Keep dashboard projection (`dashboard-projection.ts`) on its current runtime-doc/data-URI path — out of scope, lowest risk.

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| 1 | Id-aware internal media route (branch in `[...path]`) | P0 | 0.5d / 1 session | none |
| 2 | Ingest writer emits id-based `served_asset_ref` | P0 | 0.5d / 1 session | none (parallel w/ P1) |
| 3 | Publish signing: resolve id->basename before signing (Option A) | P0 | 0.5d / 1 session | P2 |
| 4 | Workspace-views previewUrl uses id-based ref (automatic) + verify | P1 | 0.25d / 1 session | P1, P2 |
| 5 | Manual-upload servability (`ingested_asset` via id route) | P2 | 0.5d / 1 session | P1 |

### Phase 1 — Id-aware internal media route

**Implementation** (`app/api/internal/hermes/media/[...path]/route.ts`):
- Add `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;`.
- After tenant ctx + single-segment validation (`:41-72`), branch: if `UUID_RE.test(segments[0])` run the id path; else fall through to the existing basename path unchanged.
- Id path: `const { rows } = await pool.query('SELECT storage_kind, storage_key, served_asset_ref, media_type FROM creative_assets WHERE id=$1 AND tenant_id=$2 LIMIT 1', [segments[0], Number(tenantId)]);` — one query, no fan-out (guardrail #1). No row -> 404.
- Resolve bytes from `storage_key`: choose the allowed root by `storage_kind` (`runtime_asset` -> Hermes mount root; `ingested_asset` -> ingested-assets DATA_ROOT root). Reuse `isWithinRoot` + double-`realpath`. `external_url`/`none` or null `storage_key` -> 404.
- Stream with `new Uint8Array(buffer)` and content-type from the resolved path (reuse `contentTypeForPath`).

**Acceptance:**
- GET `/media/<idA>` as tenant A serves A's bytes; same path as tenant B -> 404 (no cross-serve, no existence leak).
- Non-UUID single segment still resolves through `tenantOwnsHermesMediaBasename` (back-compat green).
- Null/`external_url`/`none` `storage_key` -> 404. Path traversal in resolved `storage_key` blocked.

### Phase 2 — Ingest writer emits id-based ref

**Implementation** (`backend/marketing/ingest-production-assets.ts`):
- `INSERT_PRODUCTION_ASSET_SQL`: append `RETURNING id`. `served_asset_ref` can no longer be computed pre-insert from the id; either (a) INSERT with `served_asset_ref=NULL`, read `RETURNING id`, then `UPDATE ... SET served_asset_ref='/api/internal/hermes/media/'||id WHERE id=$1 AND tenant_id=$2` (two statements, still sequential — no fan-out), or (b) use a CTE: `WITH ins AS (INSERT ... RETURNING id) UPDATE creative_assets SET served_asset_ref='/api/internal/hermes/media/'||id FROM ins WHERE creative_assets.id=ins.id`. Prefer (b) — single round-trip, atomic.
- Keep `storage_key=readPath` (mount path) and the `ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL` predicate exactly (guards the partial index, per the file's own warning `:74-79`). On conflict (0 rows), no ref rewrite — existing row keeps its ref.

**Acceptance:** new ingest rows have `served_asset_ref='/api/internal/hermes/media/<that row's id>'`; `storage_key` unchanged; replayed callback still idempotent (0 inserted on duplicate checksum).

### Phase 3 — Publish signing (Option A)

**Implementation:** at each sign site, before `toSignedPublicUrl`, if the internal URL's last segment is a UUID, look up the row's on-disk basename (`SELECT storage_key FROM creative_assets WHERE id=$1 AND tenant_id=$2`, `path.basename(storage_key)`) and sign with that basename + an internal URL the public route can resolve. Add one shared helper `resolveSignableBasename(internalUrl, tenantId)` to avoid duplicating the lookup across dispatch handler `:306`, IG `:137`, FB `:132`, scheduled `:176`. Non-UUID URLs keep today's `path.basename(url)` behavior. Single query per URL (guardrail #1) — do not `Promise.all` the lookups across media_urls; map sequentially.

**Acceptance:** a job whose `served_asset_ref` is id-based produces a signed public URL whose `/api/public/media/<token>/<basename>` resolves real bytes (parity test). Legacy basename refs still sign and resolve unchanged.

### Phase 4 — Workspace-views verify

**Implementation:** none required — `workspace-views.ts:1543` already passes `served_asset_ref` straight through to `previewUrl/fullPreviewUrl`, so id-based refs flow automatically. Add a test asserting the `<img src>` is the id URL and that the route serves it under session.

**Acceptance:** operator dashboard preview renders an id-addressed image end-to-end (route serves bytes for the session tenant).

### Phase 5 — Manual-upload servability

**Implementation** (`backend/marketing/upload-replace.ts`): add `served_asset_ref` to `INSERT_REPLACEMENT_SQL` (`:185`) via the same CTE pattern as Phase 2, set to `/api/internal/hermes/media/<id>`. Phase-1 id route resolves `ingested_asset` bytes from the DATA_ROOT `storage_key`.

**Acceptance:** a manual replacement upload becomes servable through the internal id route for the owning tenant; cross-tenant -> 404.

## Testing Plan (fixture-primary)

| Test file | Type | Asserts |
|-----------|------|---------|
| `tests/hermes-media-id-addressing.test.ts` (new) | live-db | two rows, different tenants, same on-disk basename; GET `/media/<idA>` as A -> A's bytes; as B -> 404; `ingested_asset` id serves 200; non-UUID/missing/null `storage_key`/`external_url` -> 404; path traversal blocked |
| `tests/marketing/ingest-production-assets.test.ts` (update) | fixture | `served_asset_ref` is `/media/<id>`; idempotent replay; `storage_key` unchanged |
| `tests/publish-creative-asset-ids.test.ts` (update) | fixture | id->basename resolution before signing; legacy basename path unchanged |
| publishing parity (new or extend dispatch test) | fixture | id-based ref -> signed public URL -> `/api/public/media` resolves real bytes |
| `tests/hermes-media-tenant-scope.test.ts` (keep green) | live-db | basename fallback path still enforces ownership |

Run `npm run verify` (bakes env overrides) then the focused `validate:social-content` / publish tests with `APP_BASE_URL=https://aries.example.com`. Validate against the live DB per project memory (mock-pass does not count as done).

## Rollback

- All changes are additive/back-compat: the basename route + `tenantOwnsHermesMediaBasename` stay. Reverting Phases 1-3 restores basename-only addressing; existing rows (basename refs) keep working because no historical refs are rewritten (Decision 2).
- No schema migration (id, `served_asset_ref`, `storage_key` all already exist). Nothing to down-migrate.
- If publishing regresses post-deploy, revert Phase 2 (stop writing id refs); Phase 3's id-branch becomes inert because no new id refs are produced.

## Out of Scope

- Backfilling historical `served_asset_ref` to id-based (Decision 2).
- Option B (id-aware public proxy + serving `ingested_asset` to Meta) — fast-follow.
- Dashboard projection (`dashboard-projection.ts`) preview source change — stays on runtime-doc/data-URI.
- Tenant-namespacing the physical Hermes cache directory (Hermes-side concern; out of Aries scope).
- Deleting the basename route or `tenantOwnsHermesMediaBasename`.

## Files Reference

| File | Role | Change |
|------|------|--------|
| `app/api/internal/hermes/media/[...path]/route.ts` | internal media GET | P1: UUID branch + id->storage_key resolve |
| `backend/marketing/ingest-production-assets.ts` | ingest writer | P2: `RETURNING id`, id-based `served_asset_ref` (CTE) |
| `app/api/publish/dispatch/handler.ts` | `toSignedPublicUrl` + dispatch | P3: `resolveSignableBasename` helper, id->basename before sign (`:306`) |
| `app/api/marketing/jobs/[jobId]/publish-instagram/handler.ts` | IG publish | P3: use shared resolver (`:137`) |
| `app/api/marketing/jobs/[jobId]/publish-facebook/handler.ts` | FB publish | P3: use shared resolver (`:132`) |
| `app/api/internal/publishing/scheduled-dispatch/route.ts` | scheduled publish | P3: use shared resolver (`:176`) |
| `app/api/public/media/[token]/[basename]/route.ts` | public proxy | unchanged in v1 (Option A); Option B fast-follow |
| `backend/marketing/runtime-state.ts` | `tenantOwnsHermesMediaBasename` | unchanged (back-compat fallback, `:677`) |
| `backend/marketing/workspace-views.ts` | preview URLs | P4: no code change; verify id refs flow (`:1543`) |
| `backend/marketing/upload-replace.ts` | manual upload INSERT | P5: add id-based `served_asset_ref` (`:185`) |
| `lib/signed-media-token.ts` | token shape | unchanged (Option A keeps basename claim) |
| `scripts/init-db.js` | schema | unchanged (id/refs already present, `:178`) |
