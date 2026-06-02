# Curated Public Demo: website URL -> brand draft -> sample weekly plan -> save by signup

> Status: draft plan (2026-06-01). Roadmap area #2 ("rebuild public demo around first useful result"); one of the 10 best-to-build-first. This is the **read-only, no-auth, no-real-tenant** demo path. It deliberately does **not** touch the live marketing pipeline, does **not** publish anything, and **never** sets `MARKETING_STATUS_PUBLIC=1`. New behavior is gated behind `ARIES_PUBLIC_DEMO_ENABLED` (default OFF).

## Context

Today Aries has no public demo flow. The only thing a logged-out visitor can reach beyond the marketing site is the programmatic public-artifact catch-all at `app/[...publicPath]/route.ts`, which serves already-published campaign landing pages by slug (`public-*-campaign` directories) via `resolvePublicMarketingArtifact()` in `backend/marketing/public-pages.ts`. That is a *campaign preview* surface (roadmap #9), not a *try-it-yourself* surface. A prospect cannot type their website and see what Aries would do.

The roadmap's "first useful result" path is a 5-minute loop: **enter website URL -> lightweight brand profile draft -> brand voice summary + suggested weekly themes + sample 5-post calendar + one approval checkpoint + one "what Aries would do next" recommendation -> save by creating an account.** Everything to build it already half-exists for the *authenticated* onboarding wizard — we are assembling existing engines into a logged-out, curated, throwaway experience.

**The hard guardrail (from the roadmap, from CLAUDE.md memory, and load-bearing here):** the obvious way to "make onboarding work without login" is to flip `MARKETING_STATUS_PUBLIC=1`. We must NOT. `isMarketingPublicMode()` (`lib/marketing-public-mode.ts:1`) is consumed by `lib/onboarding-gate-server.ts:12`, which **early-returns and skips the entire auth + tenant gate** when public mode is on, and by `app/api/tenant/profiles/route.ts:15` and `app/api/marketing/jobs/[jobId]/assets/[assetId]/handler.ts:238`, which **relax tenant-context enforcement**. Turning that flag on in prod would expose every authenticated tenant's dashboard and marketing assets unauthenticated. The demo must run as a *separate, self-contained surface* with its own flag — it must not reuse the public-mode switch.

## Who cares

- **Prospects / top of funnel** — "type your URL, see Aries think in 60 seconds" is the single highest-leverage conversion moment; today it does not exist.
- **Brendan / sales** — a shareable `aries.sugarandleather.com/demo` link that produces a believable brand snapshot + weekly plan for *any* business is a live pitch artifact.
- **Eng** — the website->brand-draft engine (`extractEnrichAndSaveTenantBrandKit`) and the pre-auth draft store (`onboarding_drafts`) already exist and are battle-tested in the authenticated wizard. The risk is *not* new engines; it is keeping the demo path read-only and off the auth-bypass flag.

## Decisions (locked — do not re-litigate)

1. **Separate flag, never the public-mode flag.** New `ARIES_PUBLIC_DEMO_ENABLED` (default OFF). The demo route and its APIs check this flag and `isMarketingPublicMode()` is never consulted on the demo path. Reusing `MARKETING_STATUS_PUBLIC` is explicitly forbidden (guardrail). A guard test asserts the demo code does not import `isMarketingPublicMode`. (Note: the demo flag uses the canonical `1|true|yes|on` truthiness set — matching `isVideoPublishEnabled`/`isHonchoWritePublishEnabled` — which is *broader* than `isMarketingPublicMode`'s `1|true` only; this is intentional and a separate code path.)
2. **Curated demo tenant id = `public-demo-tenant`.** It is a *namespace string for demo artifacts*, not an `organizations` row, not a member of any user. No `users.organization_id` ever points at it. Brand drafts and the sample plan are computed on the fly and stored under a demo-scoped draft, never under a real tenant's `DATA_ROOT` directory.
3. **Read-only. No pipeline, no Hermes weekly run, no publish.** The "sample weekly plan + 5-post calendar" is **deterministically synthesized from the brand draft** by a pure function — it does NOT start a marketing job, does NOT call the orchestrator, does NOT touch `scheduled_posts`. The single "approval checkpoint" and "what Aries would do next" are **illustrative UI**, not real approval records. Nothing the visitor does can cause a publish (honors the approval-gated / no-autonomous-publish guardrail trivially: there is no publish path).
4. **Reuse the existing website->brand-draft engine.** `extractEnrichAndSaveTenantBrandKit` (`backend/marketing/brand-kit.ts:1483`) is exactly what `app/api/pipeline/url-preview/route.ts` already calls. The demo calls the same engine under a demo-scoped tenant id so the draft is real (scraped + optionally enriched), not faked. Brand enrichment still respects `ARIES_BRAND_ENRICHMENT_ENABLED`; when off, the demo shows the scraped-only kit.
5. **Reuse the existing pre-auth draft store.** `onboarding_drafts` (`scripts/init-db.js:129`) + `backend/onboarding/draft-store.ts` already persist a website-derived brand preview pre-auth, keyed by an opaque `draftId` token, with a DB->DATA_ROOT fallback. The demo stores its draft there with a new `status` value path. No new table.
6. **"Save by signup" = carry the demo `draftId` into the existing signup flow.** `app/signup/page-client.tsx` already understands a `draftSaved` / `businessName` query convention (it threads them into the `/login?...` href). The demo "Save this and create your account" button routes to `/signup?draft=<id>&...`. After signup, `app/auth/post-login/page.tsx` materializes the draft into the new real tenant (the wizard's existing materialization path), so the brand the prospect saw becomes their starting brand. Materialization into a real tenant is the *one* place a real `organizations` row is created — and that only happens after a real account exists. (See Phase E for the non-trivial detail: post-login does not currently read query params, so the `draft` must be carried through `callbackUrl` to survive next-auth sign-in and post-login must be extended to read it.)
7. **Brand URL guardrail.** The demo's own marketing copy and the example pre-filled URL use `aries.sugarandleather.com` (NEVER bare `sugarandleather.com`). The prospect's typed URL is theirs; our placeholder/example is the Aries URL.
8. **SSRF reuse.** The demo URL fetch reuses the existing validation: `validateUrl` in `app/api/pipeline/url-preview/route.ts` (HTTPS-only / blocklist / IP / IPv6 shape rejection) *plus* the per-hop `ssrfSafeFetch` deep-check that runs inside the brand-kit fetch path (`lib/ssrf-safe-fetch.ts`). No new outbound-fetch surface is invented.

## Current State (VERIFIED — branch @ v0.1.13.18)

**Public surface:**
- `app/[...publicPath]/route.ts` — catch-all, serves `resolvePublicMarketingArtifact()`; branded inline 404. This is *campaign-artifact serving*, not a demo. No `/demo` route exists.
- No `app/demo/*` directory. No sample-plan generator anywhere (`grep` for `sampleWeekly`/`demoPlan`/`weeklyThemes` returns only unrelated runtime-view code). Confirmed: no `ARIES_PUBLIC_DEMO`, `public-demo-tenant`, `synthesizeDemoWeeklyPlan`, or `isPublicDemoEnabled` references exist anywhere in the tree — this is net-new.

**The public-mode guardrail (DO NOT TRIP):**
- `lib/marketing-public-mode.ts:1` — `isMarketingPublicMode()` reads `MARKETING_STATUS_PUBLIC` (`'1'`/`'true'` only). The same file also exports `normalizeMarketingWebsiteUrl` (used by url-preview); importing *that* helper is fine — importing `isMarketingPublicMode` is what the guard test forbids on the demo path.
- `lib/onboarding-gate-server.ts:12` — `if (isMarketingPublicMode()) return;` **bypasses the auth + tenant + onboarding gate entirely.**
- `app/api/tenant/profiles/route.ts:15` and `app/api/marketing/jobs/[jobId]/assets/[assetId]/handler.ts:238` — relax tenant-context enforcement when public mode is on.
- `.env.example:8` — `MARKETING_STATUS_PUBLIC=0` (correct: OFF). This plan keeps it OFF. (`docker-compose.yml:135` defaults it to empty, also OFF.)

**Website -> brand draft engine (REUSE):**
- `app/api/pipeline/url-preview/route.ts` — GET `?url=&draft=`; `validateUrl` rejects non-HTTPS / blocklisted / IP / IPv6 hosts (shape-level, defense-in-depth), then `extractEnrichAndSaveTenantBrandKit({ tenantId: draftTenantId(draftId), brandUrl })` performs the actual scrape where `ssrfSafeFetch` enforces the per-hop deep check; returns `{ title, favicon, domain, description, canonicalUrl, brandKitPreview }`, and persists the preview onto the draft via `updateOnboardingDraft`.
- `backend/marketing/brand-kit.ts:1483` — `extractEnrichAndSaveTenantBrandKit(...)` returns `{ brandKit, filePath, enriched }`. `brandKit` (type `TenantBrandKit`) carries `brand_name`, `canonical_url`, `brand_voice_summary`, `offer_summary`, `positioning`, `audience`, `tone_of_voice`, `style_vibe`, `colors`, `font_families`, `logo_urls`, `external_links`. Enrichment fields are populated only when `ARIES_BRAND_ENRICHMENT_ENABLED` is on (otherwise null — fine for the demo).
- `lib/api/aries-v1.ts:178-209` — `UrlPreviewBrandKitPreview` + `UrlPreviewResponse` types already model the brand snapshot the demo will render.

**Pre-auth draft store (REUSE):**
- `backend/onboarding/draft-store.ts` — `createOnboardingDraft`, `getOnboardingDraft`, `updateOnboardingDraft`, `draftTenantId(draftId) -> "draft_<hex>"` (returns `` `draft_${normalizeDraftId(id).replace(/-/g,'')}` ``), `claimOnboardingDraftMaterialization`. Statuses: `'draft' | 'ready_for_auth' | 'materializing' | 'materialized'`. DB-first with DATA_ROOT + tmpdir fallback (`shouldUseFallbackDraftStore` covers schema-drift `42P01`/`42703` and transient connection codes). Draft id is opaque, validated by `DRAFT_ID_PATTERN = /^[a-f0-9-]{16,}$/i`.
- `scripts/init-db.js:129` — `onboarding_drafts` DDL (`draft_id PK`, `status CHECK`, `preview JSONB`, `provenance JSONB`, `materialized_tenant_id`, `materialized_job_id`).
- `app/api/onboarding/draft/route.ts` — POST (create), GET (`?draft=`), PATCH (`?draft=`). Errors redacted; 404 on `draft_not_found`, 400 on `invalid_draft_token`, 503 on persistence failure.

**Save-by-signup handoff (REUSE):**
- `app/signup/page.tsx` + `app/signup/page-client.tsx` — already read `draftSaved` / `businessName` / `email` query params and thread them through to the `/login?...` href. They do **not** currently propagate a `draft` param — Phase E adds that (minimally).
- `app/actions/auth.ts:28` — `registerUserAction` creates the `users` row (+ optional `organizations` row), sets `onboarding_required=TRUE`.
- `app/auth/post-login/page.tsx` — a 28-line RSC that reads **no** `searchParams`; it resolves the post-login destination purely from session via `resolvePostLoginDestinationForUser` (`lib/auth-user-journey.ts`), whose return type is the strict union `'/onboarding/start' | '/dashboard'`. Today it redirects new users to `/onboarding/start`. This is the hook point for "materialize the demo draft into the new tenant," but it must be **extended** to read the pending `draft` (see Phase E) — it does not consume one today.
- `app/onboarding/start/page.tsx` + `frontend/aries-v1/onboarding-flow.tsx` — the authenticated wizard already consumes a draft preview (same shape) and runs materialization.

**Dashboard render targets (for the eventual authenticated continuation):**
- `frontend/aries-v1/view-models/dashboard-home.ts:25-55` — `DashboardHomeViewModel` has `readiness[]` and `nextAction` already (roadmap #3/#10 overlap). The demo's "what Aries would do next" mirrors this shape so the post-signup dashboard feels continuous.

**Verify/CI:**
- `scripts/verify-regression-suite.mjs` — fast suite allowlist (explicit `tests/...` args, e.g. `['--test', 'tests/runtime-pages.test.ts']`). `.env.example` flag block style at lines 48/53/61/88. `VERSION` = `0.1.13.18`; `CHANGELOG.md` present (top entry v0.1.13.18).

## Architecture (target data flow)

```
Logged-out visitor at aries.sugarandleather.com/demo   (ARIES_PUBLIC_DEMO_ENABLED=1)
  │  types their website URL (placeholder/example = aries.sugarandleather.com)
  ▼
POST /api/demo/start  ──► createOnboardingDraft()                  [REUSE draft-store]
  │  returns { draftId }   (opaque token, no auth)
  ▼
GET /api/demo/brand?draft=<id>&url=<theirs>
  │  validateUrl (shape/HTTPS/blocklist/IP/IPv6)                   [REUSE url-preview guards]
  │  extractEnrichAndSaveTenantBrandKit({ tenantId: draftTenantId(id), brandUrl })
  │      └─ ssrfSafeFetch per-hop deep-check runs INSIDE this scrape [REUSE brand-kit]
  │  updateOnboardingDraft(id, { preview, websiteUrl, provenance })[REUSE draft-store]
  ▼  brand voice summary + offer + palette + suggested-themes inputs
synthesizeDemoWeeklyPlan(brandKit)   ── NEW pure fn (deterministic, no pipeline, no Hermes)
  │  -> { themes[], calendar: 5 posts (day/surface/headline/caption-stub/cta) }
  │  -> CTA always aries.sugarandleather.com on Aries' own example; prospect's brand otherwise
  ▼
GET /api/demo/plan?draft=<id>  ── returns brand snapshot + plan + one illustrative
  │                                approval checkpoint + one "what Aries would do next"
  ▼
app/demo/page.tsx (RSC) + demo-experience.tsx (client)   ── NEW read-only UI
  │  renders snapshot, themes, 5-post calendar, the checkpoint card, the next-step card
  ▼
"Save this & create your account"  ──► /signup?draft=<id>&businessName=<name>&draftSaved=1
  │                                     [REUSE signup draftSaved convention; ADD draft passthru]
  ▼
registerUserAction (real users/organizations row)        [REUSE app/actions/auth.ts]
  ▼
app/auth/post-login/page.tsx  ── EXTENDED to read pending demo draft (carried via callbackUrl),
  │                               materialize it into the new real tenant
  (status ready_for_auth -> materializing -> materialized; brand-kit copied to tenant scope)
  ▼
/dashboard  — the brand the prospect saw is now their starting brand (continuity)
```

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Flag + guard: `ARIES_PUBLIC_DEMO_ENABLED`, demo-mode helper, public-mode-isolation guard test | Critical | 2h / 30m | none |
| B | Demo session + brand-draft APIs (`/api/demo/start`, `/api/demo/brand`) reusing draft-store + brand-kit | High | 4h / 1.5h | A |
| C | `synthesizeDemoWeeklyPlan` pure fn + `/api/demo/plan` (themes, 5-post calendar, checkpoint, next-step) | High | 5h / 2h | A |
| D | `/demo` UI: website input -> brand snapshot -> plan -> checkpoint -> next-step -> save CTA | High | 6h / 2.5h | B, C |
| E | Save-by-signup handoff + post-login draft materialization continuity | Medium | 4h / 1.5h | B, D |
| F | Rollout flag wiring (`.env.example`, `docker-compose.yml`, `CLAUDE.md`), live verify on `/demo`, ship | Medium | 3h / 1h | A–E |

**Sequencing:** A first (flag + the isolation guard gate everything). B and C parallel after A (B = data plumbing, C = pure synthesis + read endpoint; C's synth fn is pure and unit-testable without B). D after B+C (UI consumes both). E after B+D (handoff needs the draft + the CTA). F last.

```
A ─┬─> B ─┬─> D ─┬─> E ──> F
   └─> C ─┘       │
                  └────────┘
```

---

### A — Flag + public-mode isolation guard (Critical, 2h)

**Implementation:**
1. New helper `lib/public-demo-mode.ts` (NEW): `isPublicDemoEnabled()` reading `ARIES_PUBLIC_DEMO_ENABLED` with the repo's standard truthiness (`'1' | 'true' | 'yes' | 'on'`), mirroring `isVideoPublishEnabled` (`backend/marketing/synthesize-publish-posts.ts`) / `isHonchoWritePublishEnabled` (`backend/memory/honcho-env.ts`). Export a single constant `PUBLIC_DEMO_TENANT_KEY = 'public-demo-tenant'` for artifact namespacing.
2. The demo path consults ONLY `isPublicDemoEnabled()`. It MUST NOT import `isMarketingPublicMode`. (It MAY import the unrelated `normalizeMarketingWebsiteUrl` from the same file — the guard test targets the specific symbol `isMarketingPublicMode`, not the whole module.)
3. New guard test `tests/public-demo-isolation.test.ts` (NEW): statically asserts that no file under `app/demo/`, `app/api/demo/`, or `lib/public-demo-mode.ts` imports the `isMarketingPublicMode` symbol, and that flipping `ARIES_PUBLIC_DEMO_ENABLED` does NOT change `isMarketingPublicMode()` output (and vice-versa). This is the load-bearing guardrail check.

**Acceptance:** `isPublicDemoEnabled()` is `false` when unset/`0`; `true` for `1/true/yes/on`. The isolation test fails if any demo file references the `isMarketingPublicMode` symbol. `MARKETING_STATUS_PUBLIC` stays `0` in `.env.example`.

### B — Demo session + brand-draft APIs (High, 4h)

**Implementation:**
1. `app/api/demo/start/route.ts` (NEW) — POST. If `!isPublicDemoEnabled()` return 404 (route invisible when off). Calls `createOnboardingDraft()` (reuse) and returns `{ draftId }`. No auth, no tenant context. (Distinct route namespace from `/api/onboarding/draft` so the demo is auditable and rate-limit-able independently.)
2. `app/api/demo/brand/route.ts` (NEW) — GET `?draft=<id>&url=<theirs>`. Flag-gate -> 404 when off. Reuse the exact validation block from `app/api/pipeline/url-preview/route.ts` (`normalizeMarketingWebsiteUrl` then `validateUrl`: HTTPS-only, blocklist, IP/IPv6 reject). Call `extractEnrichAndSaveTenantBrandKit({ tenantId: draftTenantId(draftId), brandUrl: normalizedUrl })` — the per-hop `ssrfSafeFetch` deep-check executes inside this call — then `updateOnboardingDraft(draftId, { websiteUrl, preview, provenance })`. Return the same `UrlPreviewResponse` shape `lib/api/aries-v1.ts:202` already models. On `brand_kit_*` errors return 422; otherwise 502 (mirror url-preview's mapping).
3. **No pipeline, no Hermes.** The brand draft is the *only* network work; it is the same scrape the authenticated wizard already does.
4. **Idempotency/resumability:** re-calling `/api/demo/brand` with the same `draft` + `url` is a no-op overwrite (draft-store's `applyDraftMutation` already handles source-fingerprint stability). Re-calling with a *changed* url clears the stale preview (existing `sourceChanged` logic).

**Acceptance:** with flag ON, POST `/api/demo/start` returns a `draftId`; GET `/api/demo/brand?draft=<id>&url=https://stripe.com` returns a real brand snapshot (brand_name/voice/offer/colors) and persists it on the draft. With flag OFF, both routes 404. `http://`/IP/`localhost` URLs are rejected 400.

### C — Sample weekly plan synthesizer (High, 5h)

**Implementation:**
1. `backend/demo/sample-weekly-plan.ts` (NEW) — pure, deterministic `synthesizeDemoWeeklyPlan(brandKit: TenantBrandKit): DemoWeeklyPlan`. No DB, no fetch, no randomness (seed off a stable hash of `canonical_url` so the same brand always yields the same plan — important for shareable links and snapshot tests). Output:
   - `brandVoiceSummary` (from `brand_kit.brand_voice_summary`/`tone_of_voice`),
   - `themes: string[]` (3-4 suggested weekly themes derived from offer/positioning/audience),
   - `calendar: Array<{ day; surface: 'feed'|'story'; headline; captionStub; cta }>` — exactly 5 posts, illustrative copy only,
   - `approvalCheckpoint: { title; rationale; whatGetsReviewed: string[] }` — illustrative (NOT a real approval record),
   - `nextAction: { title; summary }` — "what Aries would do next" (mirrors `DashboardHomeViewModel.nextAction` shape so the post-signup dashboard feels continuous).
   - The example CTA for Aries' own demo brand uses `aries.sugarandleather.com`; for a prospect's brand the CTA points at *their* canonical URL.
2. `app/api/demo/plan/route.ts` (NEW) — GET `?draft=<id>`. Flag-gate -> 404. Loads the draft (reuse `getOnboardingDraft`), reconstructs the `TenantBrandKit` from the persisted preview (or `loadTenantBrandKit(draftTenantId(id))`), runs `synthesizeDemoWeeklyPlan`, returns `{ snapshot, plan }`. If no preview yet -> 409 `brand_not_ready`.

**Acceptance:** `synthesizeDemoWeeklyPlan` unit table — a kit with offer+audience yields 3-4 themes + exactly 5 calendar posts + a checkpoint + a next-step; same input twice = byte-identical output (determinism); empty/sparse kit still yields a sane minimal plan (no throw). `/api/demo/plan` returns the assembled object with flag ON, 404 with flag OFF, 409 before a brand draft exists.

### D — Demo UI (High, 6h)

**Implementation:**
1. `app/demo/page.tsx` (NEW, RSC) — server component. If `!isPublicDemoEnabled()` render `notFound()` (returns the branded 404, consistent with the catch-all). No auth. Renders `<DemoExperience />`.
2. `frontend/aries-v1/demo-experience.tsx` (NEW, client) — the 5-step read-only flow:
   - **Step 1 — URL input.** Placeholder/example `aries.sugarandleather.com` (brand-URL guardrail). On submit: POST `/api/demo/start` -> GET `/api/demo/brand`. Loading + error states reuse the wizard's visual language.
   - **Step 2 — Brand snapshot.** Brand name, voice summary, offer, palette swatches, logo — rendered from the `brandKitPreview` (same fields the wizard's `brand` step shows; copy can be lifted from `frontend/aries-v1/onboarding-flow.copy.ts`).
   - **Step 3 — Suggested weekly themes + sample 5-post calendar.** From `/api/demo/plan`. Calendar is a read-only grid (day x post).
   - **Step 4 — One approval checkpoint.** A single illustrative card: "Before anything publishes, you approve it here" — copy reinforces the safety framing ("Nothing goes live without approval, and every publish action is traceable"). Explicitly labeled as a preview, with no working buttons that mutate state.
   - **Step 5 — "What Aries would do next."** One recommendation card mirroring `nextAction`.
   - **Save CTA.** "Save this & create your account" -> `/signup?draft=<id>&businessName=<name>&draftSaved=1` (Phase E consumes it).
3. Copy lives in a sibling `demo-experience.copy.ts` (NEW), following the `onboarding-flow.copy.ts` pattern, so strings are reviewable in isolation (per the aries-v1 view-model copy-layer memory).

**Acceptance (user-visible success bar — see below):** at `/demo` with the flag ON, a human types a URL, sees a real brand snapshot, a 5-theme/5-post plan, the checkpoint card, the next-step card, and a working "create account" CTA — all rendered, no console errors, no auth prompt. With flag OFF, `/demo` is a branded 404.

### E — Save-by-signup + materialization continuity (Medium, 4h)

> **Threading note (verified):** the demo `draft` does NOT flow to post-login for free. `app/signup/page-client.tsx` only propagates `draftSaved`/`businessName`/`email` today (not `draft`), and `app/auth/post-login/page.tsx` reads **no** `searchParams` — it resolves its destination purely from session via `resolvePostLoginDestinationForUser` (strict union `'/onboarding/start' | '/dashboard'`). next-auth sign-in discards arbitrary query params unless they ride inside `callbackUrl`. So Phase E must (a) extend signup to carry `draft` into the `callbackUrl` it points sign-in at, and (b) extend post-login to read the `draft` from its `searchParams` (or add a journey-layer hook) before delegating. Both are small but real edits — they are not pre-existing affordances.

**Implementation:**
1. Demo CTA routes to the existing signup with `?draft=<id>&businessName=<name>&draftSaved=1`. `app/signup/page-client.tsx` already surfaces the `draftSaved` confirmation banner; extend it (minimal) to (i) read the `draft` param and (ii) thread it into the `callbackUrl` it hands to sign-in (e.g. `/auth/post-login?draft=<id>`), so the draft survives the auth round-trip.
2. Before redirecting to signup, the demo PATCHes the draft to `status='ready_for_auth'` (reuse `updateOnboardingDraft`) — the same gate the authenticated wizard uses before materialization.
3. `app/auth/post-login/page.tsx` — extend the RSC to accept `searchParams` and, when the just-signed-in user has a pending demo `draft`, call `claimOnboardingDraftMaterialization(draftId)` and, on a successful claim, copy the demo brand-kit into the new tenant's scope and stamp `materialized_tenant_id`. This reuses the wizard's materialization contract; the demo simply pre-seeds the brand the prospect already saw. If the draft is missing/expired or the claim fails, fall through to the normal destination resolved by `resolvePostLoginDestinationForUser` (no error surfaced to the user).
4. **No demo artifact ever becomes a real tenant by itself.** Materialization is strictly post-account-creation; `public-demo-tenant` and `draft_<hex>` namespaces never get an `organizations` row.

**Acceptance:** a visitor completes the demo, clicks save, creates an account, and lands on `/dashboard` whose brand snapshot matches what they saw in the demo (brand name + voice carried over). A visitor who abandons leaves only an orphan `onboarding_drafts` row (no tenant, no user) — same lifecycle as today's abandoned wizard drafts.

### F — Rollout, docs, live verify, ship (Medium, 3h)

**Implementation:**
1. `.env.example` — add `ARIES_PUBLIC_DEMO_ENABLED=0` near the other `ARIES_*_ENABLED` flags (the block around lines 48/53/61). `MARKETING_STATUS_PUBLIC=0` stays untouched (assert in review).
2. `docker-compose.yml` — add `ARIES_PUBLIC_DEMO_ENABLED: ${ARIES_PUBLIC_DEMO_ENABLED:-0}` to the app service env (default `0`; prod can flip to `1` to expose `/demo` without touching any auth flag), matching the existing `ARIES_VIDEO_PUBLISH_ENABLED` line style.
3. `CLAUDE.md` "Environment Variables" — document the flag in the established style (see Feature Flag section below), explicitly stating it is independent of and never substitutes for `MARKETING_STATUS_PUBLIC`.
4. Allowlist new fast tests in `scripts/verify-regression-suite.mjs` (explicit `tests/...` args, matching the existing allowlist entries).
5. Live verify on `/demo` (flag ON in a non-prod profile first, then prod with flag ON): type `aries.sugarandleather.com`, confirm the full render. Per the "user-visible completion" memory, only the rendered `/demo` page + the post-signup `/dashboard` continuity counts as done.
6. Bump `VERSION` (patch->minor: new public route + new flag), update `CHANGELOG.md`, `/ship-triage-deploy`.

**Acceptance:** flag OFF in prod -> `/demo` 404, zero behavior change, `MARKETING_STATUS_PUBLIC` still 0. Flag ON -> `/demo` renders the full 5-step flow and the save CTA produces a real account whose dashboard shows the demo brand. `full-suite` gate green.

## Feature Flag

```
- `ARIES_PUBLIC_DEMO_ENABLED=1` — exposes the curated public demo at `/demo`: a logged-out,
  read-only "first useful result" flow (enter website URL -> scraped brand draft via
  `extractEnrichAndSaveTenantBrandKit` -> deterministic sample weekly themes + 5-post calendar +
  one illustrative approval checkpoint + one "what Aries would do next" card -> "save by creating
  an account"). Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, `/demo`
  and all `/api/demo/*` routes return 404 and no demo behavior exists. The demo NEVER starts a
  marketing job, calls Hermes, or publishes — the sample plan is synthesized by a pure function and
  the approval checkpoint is illustrative UI, not a real approval record. Demo artifacts live under
  the curated `public-demo-tenant` namespace and per-visitor `onboarding_drafts` rows; no
  `organizations` row is created until a real account signs up. CRITICAL: this flag is independent
  of `MARKETING_STATUS_PUBLIC` and must NOT be conflated with it — `MARKETING_STATUS_PUBLIC=1`
  bypasses the auth/tenant gate (`lib/onboarding-gate-server.ts`) and must remain OFF in prod. The
  demo path never imports `isMarketingPublicMode` (enforced by `tests/public-demo-isolation.test.ts`).
```

## User-visible success bar (rendered UI only)

Done means a human, in Brendan's browser, can:
1. Visit `aries.sugarandleather.com/demo` (flag ON) **without logging in** and see the URL-input step.
2. Type a real website and watch a **brand snapshot render** (name, voice summary, offer, palette).
3. See **3-4 suggested weekly themes** and a **5-post calendar** rendered as a grid.
4. See the **approval-checkpoint card** and the **"what Aries would do next" card** rendered.
5. Click **"Save this & create your account"**, complete signup, and land on `/dashboard` whose **brand matches the demo** (continuity).

DB rows, JSON responses, passing unit tests, or "the API returns a plan" do NOT count. Only the rendered `/demo` page and the rendered post-signup `/dashboard` count (treat-as-production + user-visible-completion memory).

## Testing Plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Guard | `tests/public-demo-isolation.test.ts`: demo files never import `isMarketingPublicMode`; flag isolation both directions | +2 |
| Unit | `isPublicDemoEnabled()` truthiness table (`unset/0/1/true/yes/on`) | +2 |
| Unit | `synthesizeDemoWeeklyPlan`: themes count, exactly-5 calendar, checkpoint+next-step present, **determinism** (same kit twice = identical), sparse-kit no-throw | +5 |
| Unit | demo CTA uses `aries.sugarandleather.com` example, never bare `sugarandleather.com` | +1 |
| Integration (route) | `/api/demo/start` returns draftId (flag ON), 404 (flag OFF) | +2 |
| Integration (route, fake fetch) | `/api/demo/brand`: valid URL -> snapshot + draft persisted; `http://`/IP/`localhost` -> 400; flag OFF -> 404 | +4 |
| Integration (route) | `/api/demo/plan`: assembled object (ON); 409 before brand draft; 404 (OFF) | +3 |
| Integration | save-by-signup: demo CTA -> `/signup?draft=` -> `callbackUrl` carries draft -> post-login materializes draft into new tenant; missing draft falls through to `resolvePostLoginDestinationForUser` | +2 |
| E2E (live, manual) | full `/demo` render + signup continuity on `aries.sugarandleather.com` | manual |

**~21 automated + 1 manual.** New test files allowlisted in `scripts/verify-regression-suite.mjs`. All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify` then `npm run test:concurrent` before ship (touches routes + a new public page). The isolation guard test is the gate that keeps the public-mode flag from being reintroduced.

## Resumability / idempotency

- **Draft creation/brand fetch** reuse the draft-store's existing fingerprint-stable mutation (`applyDraftMutation`): re-fetching the same URL is a no-op; changing the URL clears the stale preview. DB->DATA_ROOT fallback already covers schema-drift and transient DB outages, so the demo survives a Postgres blip the same way the wizard does.
- **Plan synthesis** is pure and deterministic (seeded off `canonical_url`), so a shareable `/demo?draft=<id>` link reproduces the same plan; snapshot tests are stable.
- **Materialization** uses `claimOnboardingDraftMaterialization` (CAS on `status='ready_for_auth'`), so a double-submit at signup cannot double-create a tenant.

## Rollback

- **Flag:** `ARIES_PUBLIC_DEMO_ENABLED=0` instantly hides `/demo` + all `/api/demo/*` (404). No data migration, no schema change to revert. Authenticated flows untouched (they never read this flag). The signup/post-login edits in Phase E are guarded so that with no `draft` param present they behave exactly as today.
- **No schema change.** The demo reuses `onboarding_drafts` as-is. Orphan demo drafts age out the same way abandoned wizard drafts do (no new GC needed for this plan; a TTL sweep is out-of-scope/optional follow-up).
- **Worst case (flag-on regression):** flip OFF; the only artifacts created were `onboarding_drafts` rows and (if someone signed up) real accounts — which are legitimately created accounts, not demo state.

## Out of Scope

- **Any marketing-pipeline execution / Hermes weekly run from the demo.** The sample plan is synthesized, never executed. Real generation happens only after signup, in the normal authenticated onboarding flow.
- **Real approval records, real publishing, real scheduling.** The checkpoint is illustrative. No `scheduled_posts`, no `approval-store`, no Meta calls anywhere on the demo path.
- **Touching `MARKETING_STATUS_PUBLIC` / the public-mode gate.** Explicitly forbidden; this plan adds a *separate* flag and a guard test to keep them apart.
- **Shareable client campaign preview** (roadmap #9 — that is `app/[...publicPath]/route.ts` territory and a different surface).
- **Brand-aligned redesign** (roadmap #5) — the demo uses the current design system; re-skinning is its own plan.
- **Demo-draft TTL/GC sweep, abuse rate-limiting beyond the existing SSRF validation, and per-IP throttling** — note as follow-ups; the route-namespace split (`/api/demo/*`) is deliberately made to enable independent rate-limiting later.
- **Persisting the curated `public-demo-tenant` as a real `organizations` row or seeding example campaigns under it** — the demo computes on the fly; a seeded showcase tenant is a separate roadmap-#12 item.

## Risks

1. **Public-mode flag reintroduction (highest).** The "easy" fix under deadline pressure is to flip `MARKETING_STATUS_PUBLIC=1` so the gate stops blocking. Mitigation: the demo never needs auth (it has no tenant), uses its own flag, and `tests/public-demo-isolation.test.ts` fails the build if any demo file imports `isMarketingPublicMode`. Call this out in the PR description.
2. **SSRF / abuse via the demo URL input (unauthenticated).** Mitigation: reuse the *exact* `validateUrl` (shape/HTTPS/blocklist/IP/IPv6) + the per-hop `ssrfSafeFetch` deep-check inside `extractEnrichAndSaveTenantBrandKit` that the authenticated `url-preview` route already uses. No new fetch surface. Follow-up: per-IP rate limit on `/api/demo/*` (route namespace already isolated for this).
3. **Cost / latency of brand scrape + optional Gemini enrichment on every demo hit.** Mitigation: enrichment already honors `ARIES_BRAND_ENRICHMENT_ENABLED`; the demo works scraped-only when enrichment is off. The draft-store caches the preview per `draftId`, so re-renders don't re-scrape. (Pool guardrail #1: the demo does a single scrape and never fans out parallel DB/gateway calls.)
4. **Believability of a synthesized plan.** A weak sample plan undersells the product. Mitigation: synthesize from the *real* scraped brand kit (voice/offer/audience), not generic templates; keep determinism so the same brand always looks good. This is copy/quality work, validated by the live render bar, not by tests.
5. **Demo->signup continuity breaking.** The `draft` must survive the next-auth round-trip via `callbackUrl` and be read by an extended post-login RSC; if any link in that chain drops it (or materialization silently fails), the new tenant starts blank and the "save" felt pointless. Mitigation: materialization is best-effort with a clean fall-through to `resolvePostLoginDestinationForUser`; an integration test asserts the CTA->callbackUrl->post-login draft passthrough; the dashboard-continuity check is part of the manual E2E success bar.
6. **Orphan draft accumulation.** Unauthenticated visitors create `onboarding_drafts` rows that never materialize. Mitigation: same lifecycle as today's abandoned wizard drafts; a TTL sweep is an explicit follow-up, not a launch blocker.

## Files Reference

| File | Change | Phase |
|------|--------|-------|
| `lib/public-demo-mode.ts` | NEW: `isPublicDemoEnabled()`, `PUBLIC_DEMO_TENANT_KEY='public-demo-tenant'` | A |
| `tests/public-demo-isolation.test.ts` | NEW: forbids `isMarketingPublicMode` import on demo path; flag isolation | A |
| `app/api/demo/start/route.ts` | NEW: POST -> `createOnboardingDraft()`; 404 when flag off | B |
| `app/api/demo/brand/route.ts` | NEW: GET; reuse url-preview guards (`validateUrl`) + `extractEnrichAndSaveTenantBrandKit` (ssrfSafeFetch per-hop inside) + `updateOnboardingDraft` | B |
| `backend/demo/sample-weekly-plan.ts` | NEW: pure `synthesizeDemoWeeklyPlan(brandKit)` (themes, 5-post calendar, checkpoint, next-step) | C |
| `app/api/demo/plan/route.ts` | NEW: GET `?draft=` -> snapshot + plan; 409 before brand, 404 off | C |
| `app/demo/page.tsx` | NEW: RSC, flag-gated `notFound()`, renders demo experience | D |
| `frontend/aries-v1/demo-experience.tsx` | NEW: client 5-step read-only flow + save CTA | D |
| `frontend/aries-v1/demo-experience.copy.ts` | NEW: reviewable copy strings (aries.sugarandleather.com example) | D |
| `app/signup/page-client.tsx` | read `draft` param + thread it into the sign-in `callbackUrl` (e.g. `/auth/post-login?draft=<id>`) so it survives auth (minimal) | E |
| `app/auth/post-login/page.tsx` | EXTEND RSC to accept `searchParams`, read pending demo `draft`, materialize into the new tenant; fall through to `resolvePostLoginDestinationForUser` on miss | E |
| `.env.example`, `docker-compose.yml`, `CLAUDE.md` | document `ARIES_PUBLIC_DEMO_ENABLED=0` (independent of `MARKETING_STATUS_PUBLIC`) | F |
| `scripts/verify-regression-suite.mjs`, `VERSION`, `CHANGELOG.md` | allowlist new tests + bump | F |
| `tests/demo-brand-route.test.ts`, `tests/demo-plan-route.test.ts`, `tests/demo-sample-weekly-plan.test.ts` | NEW route + unit tests | B,C |

## Related

- `app/[...publicPath]/route.ts` / `backend/marketing/public-pages.ts` — the existing *campaign-artifact* public surface (roadmap #9); disjoint from this *try-it-yourself* demo.
- `app/api/pipeline/url-preview/route.ts` + `backend/marketing/brand-kit.ts` — the authenticated wizard's website->brand engine the demo reuses verbatim.
- `backend/onboarding/draft-store.ts` + `onboarding_drafts` — the pre-auth draft persistence the demo reuses.
- `docs/plans/2026-05-30-story-reel-video-publishing.md` — the (disjoint) plan for WRITING video/Story content to Meta; the demo never publishes, so there is no overlap with that surface or its `ARIES_VIDEO_PUBLISH_ENABLED` flag.
- CLAUDE.md guardrails honored: never expose `MARKETING_STATUS_PUBLIC=1` in prod (separate flag + guard test); brand URL `aries.sugarandleather.com` (example/CTA, never bare); approval-gated / no autonomous publish (the demo has no publish path at all); default-OFF flag; Turbopack (no build changes); SSRF reuse; pool guardrail #1 (single scrape, no fan-out).
