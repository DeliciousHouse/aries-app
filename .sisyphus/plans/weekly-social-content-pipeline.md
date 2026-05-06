# Weekly Social Content Pipeline — Reliable, Tenant-Safe, Anti-Slop

## TL;DR

> **Quick Summary**: Close the loop on the existing Hermes-backed weekly social content pipeline so an operator can go from sign-up → onboarding → connect Meta/IG → generate weekly plan → review/edit/approve → publish with on-brand, non-generic images that actually render in the dashboard. Most infrastructure exists; this plan fills 21 concrete gaps, hardens 4 security boundaries with tests-first, and ships a single coherent loop.
>
> **Deliverables**:
> - Hard onboarding gate (profile + ≥1 connected platform required to reach `/dashboard`)
> - Meta + Instagram OAuth callback completes long-lived exchange + IG Business Account discovery + Page picker
> - Brand-kit injection into Hermes `social_content_weekly` payload (logo URLs, palette, fonts, voice)
> - Per-channel aspect-ratio matrix (no more hardcoded `4:5`)
> - Vision-model post-generation QA (4 metrics, concrete thresholds, max 3 retries)
> - Frame/template overlay for IG feed + FB feed images
> - Operator regenerate (new scoped run) + upload-replace (with same QA gate) + inline copy edit + reschedule
> - Per-platform preview UI (IG single 4:5, IG carousel 1:1, FB feed link card 1.91:1)
> - Tenant-prefixed asset storage keys + tenant-ownership validation on `media_urls`
> - Per-run callback token (defense in depth on top of bearer auth)
> - `next.config.mjs` `images.remotePatterns` whitelist + naturalWidth-asserting fallback
> - Real OAuth refresh (per-provider; Meta long-lived exchange path; FOR UPDATE locking)
> - Publish dispatcher confirms `platform_post_id` and round-trips a verify GET
> - Stale-run reaper + day-50 reconnect-warning email
> - Notification templates: plan-ready, approval-needed, publish-failed
> - Manual "Generate this week" trigger with idempotency key (no cron in v1)
> - All new operator routes pass cross-tenant tests
>
> **Estimated Effort**: Large (≈28 implementation tasks + 4-task final verification wave)
> **Parallel Execution**: YES — 6 implementation waves
> **Critical Path**: T1 (asset tenant prefix) → T2/T3 (OAuth refresh + Meta callback) → T8/T9 (brand-kit + aspect matrix) → T12 (vision QA) → T13 (frame overlay) → T18-T21 (review UI) → T23 (publish confirm) → F1–F4

---

## Context

### Original Request

> "Ship a reliable, tenant-safe weekly social content pipeline that takes an operator from onboarding → connected platforms → AI-generated weekly plan → review/approve → publish with unique images actually shown in the frontend that do not look like generic ai images."

### Interview Summary

**Locked decisions**:
- **Platform scope v1**: Meta + Instagram only (other 5 stay "connect-only" with no end-to-end publish guarantee).
- **Anti-slop strategy**: Full stack — brand-grounding payload + vision-model post-gen QA + frame overlay + operator escape hatches (regenerate + upload-replace).
- **Weekly trigger**: Manual only ("Generate this week" button). No cron in v1.
- **Onboarding gate**: Hard — operator cannot reach `/dashboard` until `business_profiles.incomplete = false` AND `count(oauth_connections WHERE status='connected' AND provider IN ('facebook','instagram')) ≥ 1`.
- **Review edit scope**: Inline copy edit (autosave, last-write-wins) + per-image regenerate/upload-replace + reschedule per post (date/time + target platforms). No bulk approve, no drag-reorder, no rich text, no version history.
- **Test strategy**: Tests-after for most modules + agent-executed QA mandatory per task. **EXCEPTION**: tests-FIRST for the 4 security boundary modules (callback auth, tenant guard on new routes, OAuth refresh, publish-dispatch tenant-asset validation).

### Research Findings (from 6 explore agents — full distillation in deleted draft)

- Tenant context, NextAuth v5 JWT-bound `tenantId`, 4-scope tenant guard exist.
- Onboarding wizard pattern at `frontend/onboarding/pipeline-intake/` is reusable.
- 7-provider OAuth stack with AES-256-GCM token encryption; `oauth_connections` + `oauth_tokens` schema exists.
- Hermes integration (`HermesMarketingPort`, `social_content_weekly` `2026-05-social-content-weekly-v1`) is wired with bearer-authed callback at `/api/internal/hermes/runs`.
- Marketing orchestrator with file-based approval store (atomic locks, 30s stale sweeper) exists.
- Provider adapters (15-line `meta.ts`); `handlePublishDispatch` delegates to Hermes via `runAriesWorkflow('publish_dispatch')` — **Hermes owns the actual Meta/IG Graph API call**.
- Creative memory + brand-kit extractor (`backend/marketing/brand-kit.ts`) extracts logo/palette/fonts/voice/offer with 7-day TTL + auto-bust on source URL change.
- Review UI exists with decision actions (approve / changes_requested / reject) and `submittingRef` double-submit lock.
- Posts inventory page exists (`app/dashboard/posts/page.tsx`).
- Resend wired but only `sendPasswordResetEmail()` template.
- Native `node:test` via `tsx --test` at `tests/*.test.ts`. NO Vitest/Jest. `npm run test`, `npm run verify`, `npm run validate:*` are the validation entry points.
- Stack: Next 16.2.3 (App Router, Turbopack), React 18.3.1, TS 5.7.3 strict, NextAuth 5 beta, raw `pg` (no ORM), Tailwind 4, `next/image`, Sharp not yet a dep.

### Metis Review — Critical Findings Folded In

Metis read 11 production files and surfaced **9 gaps the interview missed** plus 5 risks:

1. **Brand kit is even more dropped than thought** — `buildSocialContentWeeklyRequest` (workflow-request.ts:206-250) uses `doc.brand_kit?.brand_name` as fallback only; logo URLs, colors, fonts, voice all dropped before payload assembly.
2. **OAuth refresh is a 48-line STUB** at `backend/integrations/refresh.ts` — bumps `token_expires_at` from caller input without ever calling the provider's refresh endpoint. Every connection silently breaks at first expiry.
3. **`aspect_ratio: '4:5'` hardcoded** at workflow-request.ts:124 for ALL images — Facebook feed gets the wrong dimensions.
4. **`token-store.ts` is `Map`-backed in `globalThis`** — lost on restart. Coexists with `oauth_tokens` DB table → canonical-store ambiguity.
5. **Bearer is single-secret-forever** for ALL callbacks across ALL tenants — single leak = full forgery capability.
6. **Asset library uses content-addressed dedup** (SHA) — if storage key is just `{sha}` and not `{tenant_id}/{sha}`, two tenants uploading identical bytes share one file (P0 leak vector).
7. **`handlePublishDispatch` accepts `media_urls` from request body** with NO check that URLs belong to the tenant's `creative_assets` — operator can inject another tenant's image URL or arbitrary internet URL.
8. **No stale-run reaper** → submitted/running runs that never get a callback become permanent zombies.
9. **`next.config.mjs` has no `images.remotePatterns`** → moment Hermes returns an external URL, `next/image` throws and renders nothing — the precise "image not shown in frontend" bug the user is asking us to fix.

**Metis directives folded in**: tests-FIRST for 4 modules; aspect-ratio matrix as concrete table; vision-QA thresholds as concrete numbers; per-run callback token; idempotency key on submission; tenant-prefixed storage keys; tenant-ownership validation on media_urls; stale-run reaper; Meta long-lived exchange + IG Business Account discovery in callback; regenerate = new aries_run (not back-step); inline-edit single-writer assumption; uploaded-image NSFW/brand gate.

---

## Work Objectives

### Core Objective

Deliver a single end-to-end loop where an authenticated operator finishes onboarding (with at least one Meta/IG connection), clicks "Generate this week," reviews and edits posts with images that look on-brand and demonstrably render in the dashboard, approves, and watches them publish to Meta/IG with a confirmed `platform_post_id` and tenant-safe data flow throughout.

### Concrete Deliverables

- 28 implementation tasks across 6 parallel waves, plus 4 final verification reviews.
- Functional verifications (every one runnable by an agent): see "Verification Strategy" below.

### Definition of Done

- [ ] Tenant A operator signs up → completes business profile → connects Meta + IG via OAuth → reaches `/dashboard`.
- [ ] Tenant A cannot reach `/dashboard` if profile incomplete OR zero connections (HTTP 307 to `/onboarding/start`).
- [ ] Tenant A clicks "Generate this week" → Hermes run created with `idempotency_key` + brand kit in payload + per-channel aspect ratios.
- [ ] Plan-ready callback received → `requires_approval` runtime state set → notification email sent.
- [ ] Operator opens review → sees IG-feed, IG-carousel, FB-feed previews matching their actual aspect ratios → can inline-edit copy (autosaves) → can regenerate any image (vision QA enforced) → can upload-replace (vision QA enforced) → can change date/time/target platforms.
- [ ] Operator approves → Hermes resumed → publish dispatched → `platform_post_id` returned → `GET /v1/{id}` confirms post exists → `posts.published_at` set.
- [ ] On `/dashboard/posts`, every post image renders with `naturalWidth > 0` (Playwright-verified).
- [ ] Tenant B cannot view, edit, regenerate, upload-replace, or publish-with tenant A's assets (cross-tenant tests pass).
- [ ] `npm run typecheck && npm run test && npm run verify && npm run validate:repo-boundary && npm run validate:banned-patterns && npm run validate:social-content && npm run validate:execution-provider && npm run validate:marketing-flow` all pass.

### Must Have

- Hard onboarding gate.
- Meta long-lived exchange + IG Business Account discovery in OAuth callback.
- Tenant-prefixed asset storage keys.
- Tenant-ownership validation of `media_urls` in publish dispatch.
- Brand kit injected into Hermes payload.
- Per-channel aspect-ratio matrix.
- Vision QA with 4 concrete thresholds and max 3 regenerate retries.
- Frame overlay for IG feed + FB feed images (link cards excluded).
- Per-run callback token.
- `next.config.mjs` `images.remotePatterns` whitelist.
- Real OAuth refresh per provider with FOR UPDATE locking.
- Publish dispatch confirms `platform_post_id` + verifies via GET.
- Stale-run reaper.
- Notifications: plan-ready, approval-needed, publish-failed.
- Manual "Generate this week" with idempotency key.
- 501 stubs at `/api/tenant/approval-requests/[id]/{approve,reject}` deleted or implemented.
- Public terms: `posts`, `weekly posts`, `social content`. NO `campaign` (except inside Meta Ads API code only).

### Must NOT Have (Guardrails)

- **NO cron / scheduler / queue worker for v1.** Manual trigger only.
- **NO TikTok video, NO video render**. AGENTS.md default says 0 rendered videos until explicit approval.
- **NO LinkedIn / X / YouTube / Reddit publish path** in v1. Connect-only is fine; do not pretend they end-to-end publish.
- **NO generic `IPlatformAdapter` abstraction.** Meta + IG share `'meta'` provider; do not extract until LinkedIn lands in v2.
- **NO bulk approve, NO drag-reorder calendar, NO rich-text editor, NO version history.** Inline copy edit + reschedule drawer + regenerate + upload-replace ONLY.
- **NO new dependency on Lobster or OpenClaw.** AGENTS.md mandate.
- **NO change to Hermes session key default** (`'main'` or `'marketing'`); use what's configured.
- **NO new auth library, NO ORM, NO test framework swap.** NextAuth v5 + raw `pg` + `node:test` stay.
- **NO custom encryption.** Reuse `backend/integrations/oauth-crypto.ts` AES-256-GCM.
- **NO scope-creep templates**: do NOT build a brand-template editor, brand-template marketplace, or copy-prompt customization UI in v1.
- **NO polling Hermes**. Aries reacts to authenticated callbacks only (AGENTS.md mandate).
- **NO push to master.** Branch + PR for everything.
- **NO `campaign` in user-facing strings** (except inside Meta Ads API client code where the API itself uses that noun).
- **NO new files outside the existing folder taxonomy** (`app/`, `backend/`, `frontend/`, `lib/`, `tests/`, `scripts/`, `validators/`, `types/`).

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (native `node:test` via `tsx --test`, 100+ tests already in `/tests/`).
- **Automated tests**: Mixed — **tests-FIRST for 4 security boundary modules**, tests-after for everything else.
- **Framework**: `tsx --test` (no Vitest/Jest). New tests live at `tests/*.test.ts` matching existing patterns.
- **Tests-FIRST modules** (RED → GREEN → REFACTOR):
  1. Hermes callback auth + per-run callback token verification (`lib/internal-callback-auth.ts` extension + `app/api/internal/hermes/runs/route.ts`).
  2. Tenant guard on every new operator route (cross-tenant 403 / unauthenticated 401 / correct tenant 200).
  3. OAuth refresh + Meta long-lived exchange (concurrent refresh single-flight; failure → `reauthorization_required`).
  4. Publish dispatch tenant-ownership validation of `media_urls`.

### QA Policy

- Every task MUST include agent-executed QA scenarios with at least one happy path and one failure/edge case.
- Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.
- Tools by surface:
  - **Frontend / dashboard / review UI**: Playwright (`/playwright` skill).
  - **CLI scripts** (reaper, refresh sweeper, smoke): `interactive_bash` (tmux) for streaming output + `Bash` for one-shot.
  - **API / webhook**: `Bash` with `curl` (assert HTTP status, parse JSON with `jq`, assert specific fields).
  - **DB-state verification**: `Bash` with `psql` against the test DB.
  - **Image-actually-rendered**: Playwright `naturalWidth > 0` assertion (NOT just `src` attribute).
- A task without QA scenarios is INCOMPLETE and will be rejected by F1.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 — Security boundaries + foundation (tests-FIRST where marked) — 7 parallel:
├── T1: Audit + tenant-prefix asset storage keys + migration [tests-first; deep] (P0)
├── T2: Real OAuth refresh per provider + Meta long-lived exchange + FOR UPDATE [tests-first; deep]
├── T3: Meta OAuth callback: long-lived + IG Business Account discovery + Page picker [tests-first; ultrabrain]
├── T4: Per-run callback_token in submission + verification on receipt [tests-first; deep]
├── T5: Publish-dispatch tenant-ownership validation of media_urls [tests-first; quick]
├── T6: next.config.mjs images.remotePatterns whitelist + dev fallback [quick]
└── T7: DB schema migration: posts.platform_post_id/published_at/scheduled_at/published_status, vision_qa_runs, scheduled_posts, oauth_callback_tokens [quick]

Wave 2 — Hermes payload contract (depends T1, T7) — 4 parallel:
├── T8: buildSocialContentWeeklyRequest → inject full brand kit into input.brand [unspecified-high]
├── T9: aspect_ratio per-channel resolver in workflow-request.ts (matrix lookup) [unspecified-high]
├── T10: idempotency_key in Hermes submission payload [quick]
└── T11: Caption length validator per channel + exposed for UI hint [quick]

Wave 3 — Image quality stack (depends T1, T7, T8, T9) — 4 parallel:
├── T12: Vision QA service (4 metrics, max 3 retries, vision_qa_runs persistence) [ultrabrain]
├── T13: Frame overlay service (sharp; aspect matrix; IG feed + FB feed only) [unspecified-high]
├── T14: Image regenerate: new aries_run scoped to single creative [deep]
└── T15: Upload-replace UI + backend: NSFW/brand vision QA gate, orphan retention 24h [unspecified-high]

Wave 4 — Onboarding hard gate + manual trigger (depends T3, T7) — 3 parallel:
├── T16: Onboarding gate middleware (redirect if !profile.complete || !connected_count >= 1) [tests-first; quick]
├── T17: Onboarding step 6: connect Meta/IG (reuse OAuth flow + StepContainer) [visual-engineering]
└── T18: "Generate this week" manual trigger button + handler (uses T10 idempotency_key) [unspecified-high]

Wave 5 — Review/approve/edit + previews (depends T8-T15) — 5 parallel:
├── T19: Inline copy edit autosave (single-writer last-write-wins) [visual-engineering]
├── T20: Per-image regenerate / upload-replace UI drawer (uses T14, T15) [visual-engineering]
├── T21: Reschedule drawer (date/time picker + target platforms; persists to scheduled_posts) [visual-engineering]
├── T22: Per-platform preview UI (IG single 4:5/1:1, IG carousel 1:1, FB feed link card 1.91:1) [visual-engineering]
└── T23: Approval-requests stubs: implement OR delete /api/tenant/approval-requests/[id]/{approve,reject} [quick]

Wave 6 — Publish + reapers + notifications (depends T2, T4, T5, T19-T23) — 5 parallel:
├── T24: Publish dispatcher confirms platform_post_id + GET-verifies + persists [tests-first; deep]
├── T25: Stale-run reaper script (scripts/reap-stale-runs.ts) + run instructions [unspecified-high]
├── T26: OAuth token refresh sweeper script + day-50 reconnect-warning email [unspecified-high]
├── T27: Notification templates: plan-ready / approval-needed / publish-failed via Resend [writing]
└── T28: End-to-end smoke script (scripts/smoke-weekly-pipeline.mjs) [deep]

Wave FINAL — 4 parallel reviews; ALL must APPROVE; user okay required:
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA across full operator flow (unspecified-high + playwright)
└── F4: Scope fidelity check (deep)

Critical Path: T1 → T8 → T12 → T13 → T20 → T24 → F1-F4 → user okay
Max Concurrent: 7 (Wave 1)
Parallel Speedup: ~65% faster than fully sequential
```

### Dependency Matrix (concise)

- **T1**: — / Blocks T8, T12, T13, T15, T20
- **T2**: — / Blocks T24, T26
- **T3**: — / Blocks T16, T17
- **T4**: — / Blocks T24
- **T5**: — / Blocks T24
- **T6**: — / Blocks T22 (image rendering)
- **T7**: — / Blocks T8, T12, T15, T21, T24
- **T8**: T1, T7 / Blocks T12, T20
- **T9**: T7 / Blocks T13, T22
- **T10**: — / Blocks T18
- **T11**: — / Blocks T19, T22
- **T12**: T1, T7, T8 / Blocks T14, T15, T20
- **T13**: T1, T9 / Blocks T20, T22
- **T14**: T8, T12 / Blocks T20
- **T15**: T1, T7, T12 / Blocks T20
- **T16**: T3 / —
- **T17**: T3 / —
- **T18**: T10 / Blocks T28
- **T19**: T11 / Blocks F-wave
- **T20**: T8, T12, T13, T14, T15, T1 / Blocks F-wave
- **T21**: T7 / Blocks F-wave
- **T22**: T6, T9, T11, T13 / Blocks F-wave
- **T23**: — / Blocks T28
- **T24**: T2, T4, T5 / Blocks T28
- **T25**: — / —
- **T26**: T2 / —
- **T27**: — / —
- **T28**: T18-T24 / Blocks F-wave
- **F1-F4**: ALL implementation tasks / Blocks user-okay

### Agent Dispatch Summary

- Wave 1 (7): T1 deep · T2 deep · T3 ultrabrain · T4 deep · T5 quick · T6 quick · T7 quick
- Wave 2 (4): T8 unspecified-high · T9 unspecified-high · T10 quick · T11 quick
- Wave 3 (4): T12 ultrabrain · T13 unspecified-high · T14 deep · T15 unspecified-high
- Wave 4 (3): T16 quick · T17 visual-engineering · T18 unspecified-high
- Wave 5 (5): T19 visual-engineering · T20 visual-engineering · T21 visual-engineering · T22 visual-engineering · T23 quick
- Wave 6 (5): T24 deep · T25 unspecified-high · T26 unspecified-high · T27 writing · T28 deep
- Wave FINAL (4): F1 oracle · F2 unspecified-high · F3 unspecified-high · F4 deep

---

## TODOs

- [x] **T1. Audit + tenant-prefix asset storage keys + migration** (P0 — tests-first)

  **What to do**:
  - Read `backend/marketing/asset-library.ts`, `backend/marketing/asset-ingest.ts`, `backend/marketing/asset-read.ts`. Determine the current storage path scheme (currently `DATA_ROOT/ingested-assets/{sha[0:2]}/{sha}/`).
  - Change scheme to `DATA_ROOT/ingested-assets/{tenant_id}/{sha[0:2]}/{sha}/`. Tenant_id MUST be on path.
  - All read/write/list functions must take `tenantId` and assert it.
  - Write `scripts/migrate-asset-tenant-prefix.ts` that: (a) inventories all existing assets, (b) for each asset, looks up owning tenant via `creative_assets` table, (c) moves file under tenant prefix, (d) updates `creative_assets.storage_path` row, (e) emits dry-run + commit modes.
  - Tests-first: `tests/asset-tenant-isolation.test.ts` with cases — tenant A writes bytes X, tenant B writes same bytes X, both have separate paths; tenant B cannot read tenant A's path; migration is idempotent.

  **Must NOT do**: Do NOT collapse the existing SHA dedup within a tenant — same tenant uploading same bytes twice should still dedup. Do NOT change `creative_assets` schema beyond `storage_path` value rewrite.

  **Recommended Agent Profile**:
  - **Category**: `deep` — Reason: tenant-leak risk, careful migration semantics, requires read-then-act on production data shape.
  - **Skills**: none required.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1 (with T2-T7)
  - Blocks: T8, T12, T13, T15, T20
  - Blocked By: None

  **References**:
  - Pattern: `backend/marketing/approval-store.ts:335-369` — atomic `wx` open + lock pattern (use for migration write-then-rename safety).
  - API: `backend/marketing/asset-library.ts` — current asset functions to refactor (signatures must add `tenantId` param).
  - API: `backend/marketing/asset-ingest.ts` — ingest path; matches `media_request` per Metis grep.
  - Type: `creative_assets` table (init at `scripts/init-db.js`) — has `tenant_id` FK and `storage_path` column.
  - Test pattern: `tests/marketing-job-flow.test.ts` for setup/teardown patterns; `tests/helpers/` for tenant fixtures.
  - WHY: The existing dedup keys-by-SHA cross-tenant. Two tenants with the same logo could share storage — when one updates, both change; when one deletes, both lose access.

  **Acceptance Criteria**:
  - [ ] Test `tests/asset-tenant-isolation.test.ts` passes (3 cases: separate paths, cross-tenant read denial, migration idempotency).
  - [ ] `npm run test -- --test-name-pattern="asset.*tenant"` → green.
  - [ ] Migration script `--dry-run` outputs intended moves; `--commit` performs them.
  - [ ] Post-migration: every row in `creative_assets` has `storage_path` containing its `tenant_id` segment.
  - [ ] No file remains under the legacy un-prefixed location after `--commit`.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Cross-tenant write isolation (happy)
    Tool: Bash
    Preconditions: clean DB; two tenants T_A, T_B exist
    Steps:
      1. ./node_modules/.bin/tsx scripts/seed-asset.ts --tenant T_A --file fixtures/sample.png
      2. ./node_modules/.bin/tsx scripts/seed-asset.ts --tenant T_B --file fixtures/sample.png  # same bytes
      3. psql -c "SELECT tenant_id, storage_path FROM creative_assets WHERE sha = '<known sha>'"
    Expected Result: 2 rows; storage_path values START with the tenant_id and DIFFER between rows.
    Failure Indicators: same storage_path for both rows (tenant leak); 1 row only (improper dedup).
    Evidence: .sisyphus/evidence/task-1-cross-tenant-isolation.txt

  Scenario: Cross-tenant read denial (failure path)
    Tool: Bash
    Preconditions: tenant A has asset_ID 'ca_A1'
    Steps:
      1. curl -s -H "Cookie: <T_B session>" -o /dev/null -w "%{http_code}" "http://localhost:3000/api/assets/ca_A1"
    Expected Result: HTTP 403 (or 404 — either is fine; MUST NOT be 200).
    Failure Indicators: 200 with bytes returned.
    Evidence: .sisyphus/evidence/task-1-cross-tenant-read-denied.txt

  Scenario: Migration idempotency
    Tool: Bash
    Preconditions: pre-migration data
    Steps:
      1. ./node_modules/.bin/tsx scripts/migrate-asset-tenant-prefix.ts --commit
      2. ./node_modules/.bin/tsx scripts/migrate-asset-tenant-prefix.ts --dry-run
    Expected Result: Second run reports zero pending moves.
    Evidence: .sisyphus/evidence/task-1-migration-idempotent.txt
  ```

  **Evidence to Capture**: 3 scenario evidence files above + `tests/asset-tenant-isolation.test.ts` runner output.

  **Commit**: YES (commit T1) — `fix(assets): tenant-prefix storage keys + migration script`
  - Files: `backend/marketing/asset-library.ts`, `backend/marketing/asset-ingest.ts`, `backend/marketing/asset-read.ts`, `scripts/migrate-asset-tenant-prefix.ts`, `tests/asset-tenant-isolation.test.ts`
  - Pre-commit: `npm run test -- --test-name-pattern="asset.*tenant"` && `npm run typecheck`

- [x] **T2. Real OAuth refresh per provider + Meta long-lived exchange + concurrency lock** (tests-first)

  **What to do**:
  - Replace the 48-line stub `backend/integrations/refresh.ts`. Build a real per-provider refresh dispatcher.
  - Add `backend/integrations/refresh-meta.ts` implementing Meta's exchange-not-refresh model: short-lived → long-lived via `oauth/access_token?grant_type=fb_exchange_token`. Long-lived re-exchange BEFORE expiry.
  - Add `backend/integrations/refresh-linkedin.ts`, `refresh-x.ts`, `refresh-google.ts` (YouTube), `refresh-tiktok.ts`, `refresh-reddit.ts` as no-op-but-correct-shape stubs that call provider refresh endpoints. v1 only USES Meta; others are scaffolded so v2 can plug in.
  - Concurrency: every refresh call must `BEGIN` + `SELECT ... FOR UPDATE` on `oauth_connections WHERE id = $1` to single-flight concurrent refresh of the same connection.
  - On refresh failure: mark `oauth_connections.status = 'reauthorization_required'`, persist `last_error_code` + `last_error_message`, write `oauth_audit_events` row.
  - Rotate the encrypted token via existing `oauth-crypto.ts`; persist as new `oauth_tokens` row with `rotated_from_token_id` FK pointing at the old one; revoke the old via `revoked_at`.
  - Tests-first: `tests/oauth-refresh-meta.test.ts` (long-lived exchange happy + 401 + 5xx), `tests/oauth-refresh-concurrency.test.ts` (Promise.all of 5 refresh calls produces exactly 1 new token row), `tests/oauth-refresh-failure.test.ts` (connection moves to `reauthorization_required`).

  **Must NOT do**: Do NOT introduce any new HTTP client library. Use `globalThis.fetch`. Do NOT change `oauth_tokens` schema. Do NOT delete the old token row outright — set `revoked_at` instead.

  **Recommended Agent Profile**:
  - **Category**: `deep` — Reason: race conditions are silent killers; provider-specific gotchas; tests-first required.
  - **Skills**: none required.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1 (with T1, T3-T7)
  - Blocks: T24, T26
  - Blocked By: None

  **References**:
  - Pattern: `backend/integrations/oauth-credentials.ts` — `getDecryptedAccessTokenForTenantProvider` for the read side (must integrate with refresh).
  - Pattern: `backend/integrations/oauth-crypto.ts` — AES-256-GCM `encryptToken`/`decryptToken` (REUSE; do not write new crypto).
  - API: `backend/integrations/oauth-tokens-db.ts` — current persistence functions; add the FOR UPDATE wrapper here.
  - API: `backend/integrations/connection-schema.ts` — `PlatformConnectionSchema` + `resolveTokenHealth` (already returns `expiring_soon` if <24h; refresh sweeper will read this).
  - Type: `oauth_connections.status` enum: `pending|connected|reauthorization_required|disconnected|error` — refresh failure transitions to `reauthorization_required`.
  - External: Meta long-lived exchange https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
  - WHY: The current `refresh.ts` is a 48-line stub that does NOT call provider endpoints. Without real refresh, every token expires silently and publish breaks within 1-60 days depending on provider.

  **Acceptance Criteria**:
  - [ ] `tests/oauth-refresh-meta.test.ts` passes (long-lived exchange returns new token; storage rotates).
  - [ ] `tests/oauth-refresh-concurrency.test.ts`: Promise.all of 5 calls → exactly 1 new `oauth_tokens` row produced; the other 4 callers receive the same new token handle.
  - [ ] `tests/oauth-refresh-failure.test.ts`: provider 401 → `oauth_connections.status` = `reauthorization_required`, `last_error_code` populated, `oauth_audit_events` row written.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Meta long-lived exchange happy path
    Tool: Bash
    Preconditions: oauth_connections row for Meta with short-lived token (expires_at near-now)
    Steps:
      1. ./node_modules/.bin/tsx scripts/refresh-oauth-tokens.ts --connection-id <ID> --dry-run=false
      2. psql -c "SELECT expires_at FROM oauth_tokens WHERE connection_id = <ID> ORDER BY issued_at DESC LIMIT 1"
    Expected Result: New row's expires_at is roughly 60 days from now; old row has revoked_at IS NOT NULL.
    Failure Indicators: expires_at near-now (still short-lived); old row not revoked.
    Evidence: .sisyphus/evidence/task-2-meta-long-lived.txt

  Scenario: Concurrent refresh single-flight (failure-resistance)
    Tool: Bash
    Preconditions: ANY connection with expiring token
    Steps:
      1. ./node_modules/.bin/tsx tests/helpers/concurrent-refresh.ts --connection-id <ID> --parallel 5
    Expected Result: Stdout shows 5 callers, 1 new token issued, 4 returned the same token handle.
    Failure Indicators: 5 new tokens (race not prevented).
    Evidence: .sisyphus/evidence/task-2-concurrent-singleflight.txt

  Scenario: Refresh failure marks reauthorization_required
    Tool: Bash
    Preconditions: connection with deliberately-invalid refresh token
    Steps:
      1. ./node_modules/.bin/tsx scripts/refresh-oauth-tokens.ts --connection-id <ID>
      2. psql -c "SELECT status, last_error_code FROM oauth_connections WHERE id = <ID>"
    Expected Result: status = 'reauthorization_required'; last_error_code populated.
    Evidence: .sisyphus/evidence/task-2-refresh-failure.txt
  ```

  **Commit**: YES (T2) — `feat(oauth): real refresh + Meta long-lived exchange + concurrency lock`
  - Files: `backend/integrations/refresh.ts`, `backend/integrations/refresh-{meta,linkedin,x,google,tiktok,reddit}.ts`, `backend/integrations/oauth-tokens-db.ts`, `tests/oauth-refresh-meta.test.ts`, `tests/oauth-refresh-concurrency.test.ts`, `tests/oauth-refresh-failure.test.ts`
  - Pre-commit: `npm run test -- --test-name-pattern="oauth.*refresh"` && `npm run typecheck`

- [ ] **T3. Meta OAuth callback: long-lived exchange + IG Business Account discovery + Page picker** (tests-first for callback path)

  **What to do**:
  - In `backend/integrations/meta/callback.ts` (or current Meta callback handler under `app/api/oauth/[provider]/callback/route.ts`): after exchanging code for short-lived token, IMMEDIATELY exchange for long-lived (60-day).
  - GET `/me/accounts?access_token=<long_lived>` → list of FB Pages. For each Page, GET `/{page_id}?fields=instagram_business_account,access_token`.
  - If 0 pages: mark connection `error`, surface "no Pages" copy on connect-callback page.
  - If 1 page with IG BA: persist Page Access Token (NOT user token) + `ig_user_id` in `oauth_connections.external_account_id` (for Meta) and add a sibling `oauth_connections` row for `provider='instagram'` referencing the same Page.
  - If multiple pages: redirect to `/onboarding/connect/meta/select-page` with a Page picker (server component reading the in-progress `oauth_pending_states` row).
  - Update `oauth_pending_states` schema usage to carry the `pages_to_pick` payload across the picker round-trip.
  - Tests-first: `tests/oauth-meta-callback.test.ts` covering: short→long exchange, 0/1/N pages branching, IG BA detection, Page-token-vs-User-token persistence (assert what's stored is the Page token via fixture).

  **Must NOT do**: Do NOT call any LinkedIn/X/TikTok/YouTube/Reddit providers in this task. Do NOT change `oauth_connections` schema beyond using existing columns. Do NOT persist the User Access Token — only the Page Access Token.

  **Recommended Agent Profile**:
  - **Category**: `ultrabrain` — Reason: complex multi-step Meta-specific flow; logic-heavy; many edge cases (no pages, multiple pages, page without IG BA, IG BA without page).
  - **Skills**: none required.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1
  - Blocks: T16, T17
  - Blocked By: None

  **References**:
  - Pattern: `backend/integrations/connect.ts`, `callback.ts` — current OAuth state-machine handlers.
  - Pattern: `backend/integrations/oauth-pending-states.ts` (find via grep) — round-trip state token storage.
  - Pattern: `frontend/onboarding/pipeline-intake/components/StepContainer.tsx` — pattern for connect-callback page.
  - API: `backend/integrations/oauth-credentials.ts` — `getDecryptedAccessTokenForTenantProvider` (LinkedIn comment shows it extracts URN; mirror the pattern for Meta/IG BA id).
  - Type: `oauth_connections` columns `external_account_id`, `external_account_name`, `granted_scopes`, `token_expires_at`, `refresh_expires_at`.
  - External: Meta `/me/accounts` https://developers.facebook.com/docs/graph-api/reference/user/accounts ; IG `instagram_business_account` field https://developers.facebook.com/docs/instagram-api/getting-started
  - WHY: Today the connection appears "connected" even when no Page or no IG BA is granted, leading to publish-time 401s with cryptic permission errors. Discovering and persisting the right token + ID up front turns publish errors from "auth" into clear product errors.

  **Acceptance Criteria**:
  - [ ] `tests/oauth-meta-callback.test.ts` passes covering 0/1/N pages branches.
  - [ ] After connect: `oauth_connections.provider='instagram'` row exists with `external_account_id` = IG Business Account id.
  - [ ] After connect: `oauth_tokens` for Meta connection stores Page Access Token (asserted via fixture comparing to known Page-token shape).
  - [ ] Page picker UI lists every FB Page with checkbox; submit creates exactly the connections selected.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Single-page happy path (Playwright)
    Tool: Playwright (/playwright skill)
    Preconditions: Meta sandbox account with 1 FB Page that has IG Business Account
    Steps:
      1. Navigate to /onboarding/connect/meta
      2. Click "Connect Meta"; complete OAuth on test account
      3. Wait for redirect to /onboarding/connect/meta/done
      4. Navigate to /platforms; assert Meta and Instagram cards both show "Connected"
      5. psql query: SELECT provider, external_account_id, status FROM oauth_connections WHERE tenant_id=<T>
    Expected Result: 2 rows (meta + instagram), both status='connected', external_account_id non-null on both.
    Evidence: .sisyphus/evidence/task-3-single-page-happy.png + .txt

  Scenario: Multi-page picker (failure-resistance)
    Tool: Playwright
    Preconditions: Meta sandbox account with 3 Pages, only 2 have IG BAs
    Steps:
      1. Navigate to /onboarding/connect/meta; complete OAuth
      2. Land on /onboarding/connect/meta/select-page
      3. Assert 3 page rows visible; 2 show IG-eligible badge, 1 shows "no IG"
      4. Select 1 IG-eligible page; click "Use this page"
      5. Verify connections persisted only for that selection
    Expected Result: 1 meta + 1 instagram row in oauth_connections.
    Evidence: .sisyphus/evidence/task-3-multi-page-picker.png

  Scenario: Page token persisted (not user token)
    Tool: Bash
    Preconditions: connection completed via Scenario 1
    Steps:
      1. ./node_modules/.bin/tsx tests/helpers/dump-token-claim.ts --connection-id <ID>
    Expected Result: Token claim shape matches Page token (page_id present, no `user_id`).
    Evidence: .sisyphus/evidence/task-3-page-token-asserted.txt
  ```

  **Commit**: YES (T3) — `feat(oauth-meta): long-lived exchange + IG Business Account discovery + page picker`

- [x] **T4. Per-run callback_token in Hermes submission + verification on receipt** (tests-first)

  **What to do**:
  - In `backend/marketing/ports/hermes.ts` `submissionPayload`: generate a per-run `callback_token` (32-byte random hex). Include in `callback_auth` payload (extend the schema): `{type:'internal_api_secret_bearer', secret_ref:'INTERNAL_API_SECRET', callback_token:'<token>'}`.
  - Persist the `callback_token` in a new `oauth_callback_tokens` table (migrated by T7) with columns `(token_hash CHAR(64) PRIMARY KEY, aries_run_id, tenant_id, issued_at, consumed_at NULLABLE)`. Store SHA-256 hash, NOT plaintext.
  - Extend `lib/internal-callback-auth.ts` `verifyInternalCallbackRequest` to ALSO require the per-run `callback_token` from the body (or a custom header) and verify it matches a row in `oauth_callback_tokens` for the asserted `aries_run_id`. Use timing-safe compare on hashes.
  - Tests-first: `tests/callback-token.test.ts` — missing token (403), wrong token (403), correct token (200), reuse-after-consumed (still allowed, since event_id dedup is the consumption gate), wrong-aries_run_id-with-correct-token (403).

  **Must NOT do**: Do NOT remove the existing bearer auth — this is defense in depth, not replacement. Do NOT log the token plaintext anywhere. Do NOT make this required for non-Hermes internal callbacks (scope this check to the Hermes runs route).

  **Recommended Agent Profile**:
  - **Category**: `deep` — Reason: security boundary; tests-first; defense-in-depth design.
  - **Skills**: none required.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1
  - Blocks: T24
  - Blocked By: None (T7 schema lands in same wave; coordinate via shared init-db.js diff if needed)

  **References**:
  - Pattern: `lib/internal-callback-auth.ts` — `verifyInternalCallbackRequest` w/ `timingSafeEqual`. Extend, do not replace.
  - Pattern: `backend/execution/hermes-callbacks.ts:283-289` — event_id dedup via `hasExecutionRunEvent` + `withExecutionRunLock`. The new token check is ADDITIONAL to event_id dedup.
  - API: `backend/marketing/ports/hermes.ts` `submissionPayload` (line ~269 today) — extend `callback_auth` shape.
  - API: `app/api/internal/hermes/runs/route.ts` — POST handler; add token check to verification path.
  - Type: see Hermes contract doc (or coordinate with Hermes team) to confirm the new field is forward-compatible with `2026-05-social-content-weekly-v1` workflow version.
  - WHY: Today INTERNAL_API_SECRET is one secret across all callbacks. A leak = full forgery against any known `aries_run_id`. Per-run token + bearer = even if bearer leaks, attacker also needs the per-run nonce.

  **Acceptance Criteria**:
  - [ ] `tests/callback-token.test.ts` covers 5 cases above; all pass.
  - [ ] `oauth_callback_tokens` table populated on submission (verify via `psql` after submitting a test run).
  - [ ] `npm run validate:execution-provider` passes (no contract regression).

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Correct token + bearer accepted
    Tool: Bash (curl)
    Preconditions: a real run was just submitted; we know its callback_token from the test fixture (loaded via tests/helpers).
    Steps:
      1. curl -i -X POST http://localhost:3000/api/internal/hermes/runs -H "Authorization: Bearer $INTERNAL_API_SECRET" -H "Content-Type: application/json" -d '{"event_id":"evt_t4_ok","aries_run_id":"<run>","status":"running","callback_token":"<correct>"}'
    Expected Result: HTTP 200; response body includes "applied":true.
    Evidence: .sisyphus/evidence/task-4-correct-token.txt

  Scenario: Missing token (failure)
    Tool: Bash
    Steps:
      1. Same curl WITHOUT callback_token field
    Expected Result: HTTP 403 with reason indicating callback token missing.
    Evidence: .sisyphus/evidence/task-4-missing-token.txt

  Scenario: Wrong token (failure)
    Tool: Bash
    Steps:
      1. Same curl with callback_token: "deadbeef"*8
    Expected Result: HTTP 403; consumed_at remains NULL on the legitimate token row.
    Evidence: .sisyphus/evidence/task-4-wrong-token.txt
  ```

  **Commit**: YES (T4) — `feat(callback): per-run callback token defense in depth`

- [x] **T5. Publish-dispatch tenant-ownership validation of `media_urls`** (tests-first)

  **What to do**:
  - In `app/api/publish/dispatch/handler.ts` `handlePublishDispatch`: before calling `runAriesWorkflow('publish_dispatch')`, validate every URL in `body.media_urls`.
  - Validation rule: each URL must resolve to a `creative_assets` row whose `tenant_id` equals the asserted tenant from `loadTenantContextOrResponse`.
  - If a URL doesn't resolve OR resolves to another tenant's row OR is an arbitrary external URL: return HTTP 403 with `{ error: 'media_url_tenant_mismatch', detail: { url: '<offending>' } }`.
  - Add `backend/integrations/media-url-ownership.ts` exporting `assertMediaUrlsBelongToTenant(tenantId, urls)`.
  - Tests-first: `tests/publish-tenant-isolation.test.ts` — own asset (202), other tenant's asset (403), external URL (403), missing asset (403).

  **Must NOT do**: Do NOT relax the check via "internal admin override" — there is no such thing in v1. Do NOT skip the check on retry endpoint; apply identical guard there.

  **Recommended Agent Profile**:
  - **Category**: `quick` — Reason: focused, single-concern fix; tests-first.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1
  - Blocks: T24
  - Blocked By: None

  **References**:
  - Pattern: `backend/integrations/token-store.ts` — existing `assert(rec.tenant_id === tenantId, 'tenant_scope_mismatch')` line; mirror that style.
  - API: `app/api/publish/dispatch/route.ts`, `handler.ts` — POST handler.
  - API: `app/api/publish/retry/route.ts`, `handler.ts` — apply same guard.
  - Type: `creative_assets` table (id, tenant_id, storage_path); URL → asset_id resolution lives in existing asset-library helpers.
  - WHY: Today an operator with an API key (or any logged-in tenant) could pass `media_urls=['https://otherTenantBucket/...']` or `['https://attacker.example.com/phish.jpg']` to publish.

  **Acceptance Criteria**:
  - [ ] `tests/publish-tenant-isolation.test.ts` passes (4 cases).
  - [ ] Both `dispatch` and `retry` routes apply the guard.
  - [ ] Guard logs to existing audit channel on rejection (correlate with tenant + offending URL).

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Own asset (happy)
    Tool: Bash
    Preconditions: tenant A logged in; asset ca_A1 owned by A
    Steps:
      1. curl -i -X POST http://localhost:3000/api/publish/dispatch -H "Cookie: <A>" -H "Content-Type: application/json" -d '{"provider":"meta","content":"hi","media_urls":["/api/assets/ca_A1"]}'
    Expected Result: HTTP 202; workflow_id in response.
    Evidence: .sisyphus/evidence/task-5-own-asset-202.txt

  Scenario: Other-tenant asset (failure)
    Tool: Bash
    Preconditions: tenant A logged in; asset ca_B1 owned by B
    Steps:
      1. curl -i -X POST <same endpoint> -H "Cookie: <A>" -d '{"provider":"meta","content":"hi","media_urls":["/api/assets/ca_B1"]}'
    Expected Result: HTTP 403 with error="media_url_tenant_mismatch".
    Evidence: .sisyphus/evidence/task-5-other-tenant-403.txt

  Scenario: External URL (failure)
    Tool: Bash
    Steps:
      1. curl -i ... -d '{"provider":"meta","content":"hi","media_urls":["https://example.com/x.jpg"]}'
    Expected Result: HTTP 403.
    Evidence: .sisyphus/evidence/task-5-external-url-403.txt
  ```

  **Commit**: YES (T5) — `fix(publish): validate media_urls tenant ownership`

- [x] **T6. `next.config.mjs` `images.remotePatterns` whitelist + dev fallback**

  **What to do**:
  - Update `next.config.mjs` (currently 8 lines) to add `images.remotePatterns` for: the Hermes media domain (resolved at config load from `process.env.HERMES_MEDIA_HOST` or `HERMES_GATEWAY_URL` host), the `APP_BASE_URL` host (for self-served signed URLs), and any CDN host (env-var `IMAGES_CDN_HOST`, optional).
  - Update `frontend/components/media-preview.tsx` `MediaPreview` to: detect when `next/image` would reject the URL (at runtime via try/catch on render) and fall back to native `<img>` with `data-fallback="true"` attribute. Log a `console.warn` in development when the fallback fires.
  - Add a 1-line dev-only banner: `console.warn('[media-preview] URL host not in next.config remotePatterns: <host>')`.

  **Must NOT do**: Do NOT use `images: { unoptimized: true }`. Do NOT allow `*.example.com` wildcards beyond the explicit Hermes/APP/CDN hosts.

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1
  - Blocks: T22
  - Blocked By: None

  **References**:
  - Pattern: `frontend/components/media-preview.tsx` — `MediaPreview` with native `<img>` and content-type detection. Extend.
  - API: `next.config.mjs` images config: https://nextjs.org/docs/app/api-reference/components/image#remotepatterns
  - WHY: The user's request is "images shown in the frontend." Today next/image silently fails for any external URL because remotePatterns is missing.

  **Acceptance Criteria**:
  - [ ] `next.config.mjs` exports a config with `images.remotePatterns` populated from env.
  - [ ] `npm run dev` boots without warnings about missing image config.
  - [ ] Playwright: load `/dashboard/posts` with a known external Hermes URL post → image renders (`naturalWidth > 0`).

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: External Hermes URL renders (Playwright happy)
    Tool: Playwright
    Preconditions: a post exists with image hosted on Hermes media domain
    Steps:
      1. Navigate to /dashboard/posts
      2. await page.locator('img[data-post-id="<id>"]').waitFor({state:'visible', timeout:10000})
      3. const w = await page.locator('img[data-post-id="<id>"]').evaluate(el => el.naturalWidth)
    Expected Result: w > 0.
    Failure Indicators: w === 0 (next/image rejected URL silently).
    Evidence: .sisyphus/evidence/task-6-image-renders.png

  Scenario: Off-whitelist URL falls back to native img (failure-resistance)
    Tool: Playwright
    Preconditions: dev mode; post fixture with off-whitelist URL
    Steps:
      1. Navigate to /dashboard/posts
      2. const fb = await page.locator('img[data-fallback="true"]').count()
    Expected Result: fb >= 1 (fallback rendered, page is not blank).
    Evidence: .sisyphus/evidence/task-6-fallback-rendered.png
  ```

  **Commit**: YES (T6) — `fix(images): images.remotePatterns whitelist + dev fallback`

- [x] **T7. DB schema migration: posts/vision_qa_runs/scheduled_posts/oauth_callback_tokens**

  **What to do**:
  - Update `scripts/init-db.js` (raw SQL, no ORM) to add:
    - `posts` columns: `platform_post_id TEXT`, `published_at TIMESTAMPTZ`, `scheduled_at TIMESTAMPTZ`, `published_status TEXT CHECK IN ('draft','in_review','approved','scheduled','publishing','published','failed','rolled_back')`. Backfill default `'draft'` on existing rows.
    - New `vision_qa_runs` table: `(id BIGSERIAL PK, tenant_id, post_id FK, creative_id, attempt_number INT, brand_color_match_score NUMERIC, text_legibility_score NUMERIC, forbidden_pattern_hits INT, brand_violation_score NUMERIC, verdict TEXT CHECK IN ('pass','fail','operator_override'), model_version TEXT, raw_model_output JSONB, created_at TIMESTAMPTZ DEFAULT now())`.
    - New `scheduled_posts` table: `(id BIGSERIAL PK, post_id FK UNIQUE, tenant_id, scheduled_for TIMESTAMPTZ, target_platforms TEXT[], updated_at TIMESTAMPTZ DEFAULT now())`.
    - New `oauth_callback_tokens` table: `(token_hash CHAR(64) PRIMARY KEY, aries_run_id TEXT NOT NULL, tenant_id INT NOT NULL, issued_at TIMESTAMPTZ DEFAULT now(), consumed_at TIMESTAMPTZ NULL, INDEX (aries_run_id))`.
  - Add `types/posts.ts`, `types/vision-qa.ts`, `types/scheduled-posts.ts` matching the columns.
  - Migration must be idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).

  **Must NOT do**: Do NOT introduce an ORM. Do NOT add a separate migrations tool — `scripts/init-db.js` is the migration entry today; extend it. Do NOT remove or rename existing columns.

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 1
  - Blocks: T8, T12, T15, T21, T24
  - Blocked By: None

  **References**:
  - Pattern: `scripts/init-db.js` — current schema. Add new tables in same idempotent style.
  - Type: existing `types/` folder for shape conventions.
  - WHY: Vision QA, scheduling, callback tokens, and publish-confirmation all need durable storage. Without these tables, the dependent tasks have nowhere to write.

  **Acceptance Criteria**:
  - [ ] `npm run db:init` succeeds on a clean DB AND on an existing DB (idempotent).
  - [ ] `psql -c "\d posts"` shows new columns.
  - [ ] `psql -c "\dt vision_qa_runs scheduled_posts oauth_callback_tokens"` returns 3 tables.
  - [ ] Type files in `types/` match column shapes; `npm run typecheck` clean.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Schema applies on fresh DB
    Tool: Bash
    Steps:
      1. dropdb aries_test_t7 ; createdb aries_test_t7
      2. DB_NAME=aries_test_t7 npm run db:init
      3. DB_NAME=aries_test_t7 psql -c "\d posts" -c "\d vision_qa_runs" -c "\d scheduled_posts" -c "\d oauth_callback_tokens"
    Expected Result: all 4 commands return non-empty descriptions; new columns visible on posts.
    Evidence: .sisyphus/evidence/task-7-fresh-schema.txt

  Scenario: Idempotency on second run
    Tool: Bash
    Steps:
      1. DB_NAME=aries_test_t7 npm run db:init  # second invocation
    Expected Result: exit 0, no errors about already-existing objects.
    Evidence: .sisyphus/evidence/task-7-idempotent.txt
  ```

  **Commit**: YES (T7) — `feat(db): posts.platform_post_id/published_at/scheduled_at + vision_qa_runs + scheduled_posts + oauth_callback_tokens`

- [ ] **T8. `buildSocialContentWeeklyRequest` brand-kit injection** (Wave 2)

  **What to do**:
  - In `backend/social-content/workflow-request.ts` `buildSocialContentWeeklyRequest` (around lines 206-250 per Metis): pull the full brand kit from the tenant's `business_profiles` + `backend/marketing/brand-kit.ts` cache, and add `input.brand` to the payload with shape:
    ```ts
    brand: {
      name: string;
      logo_urls: string[];
      colors: { primary?: string; secondary?: string; accent?: string; palette?: string[] };
      font_families: string[];
      voice: string;
      offer: string;
      must_avoid_aesthetics: string[]; // sourced from creative-memory market patterns
    }
    ```
  - When kit is stale (ttl expired OR `business_profiles.website_url` newer than kit), refresh kit BEFORE submission via `extractAndSaveTenantBrandKit`.
  - If kit extraction fails after retry budget: surface `state='needs_brand_kit'` to the runtime doc and abort submission with operator-actionable error.
  - Tests-after: `tests/social-content-brand-kit-injection.test.ts` asserts the actual payload sent to Hermes (mock the port) contains all brand fields; `tests/social-content-brand-kit-stale.test.ts` covers the cache-bust path.

  **Must NOT do**: Do NOT change the workflow version string. Do NOT inline brand-extraction logic — call existing `brand-kit.ts` helpers. Do NOT inject anything that changes the public Hermes contract beyond the documented `input.brand` field; coordinate with Hermes side via README note if shape differs.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — Reason: integration-shaped change; multi-file but mechanical.

  **Parallelization**:
  - Can Run In Parallel: YES
  - Wave: 2 (with T9-T11)
  - Blocks: T12, T20
  - Blocked By: T1 (asset paths must be tenant-prefixed before logo URLs ship in payloads), T7

  **References**:
  - Pattern: `backend/marketing/brand-kit.ts` `extractAndSaveTenantBrandKit({tenantId, brandUrl})` — already extracts logo URLs, primary/secondary/accent palette, font families, voice summary. Returns `{brandKit, filePath}`.
  - Pattern: `backend/marketing/brand-kit.ts:1305` (Metis line ref) — TTL + auto-bust on `source_url` change.
  - API: `backend/social-content/workflow-request.ts` `buildSocialContentWeeklyRequest` — extend.
  - API: `backend/marketing/runtime-state.ts` `MarketingJobRuntimeDocument` — runtime state shape.
  - API: `backend/social-content/defaults.ts` `FORBIDDEN_VISUAL_PATTERNS` — feed into `must_avoid_aesthetics`.
  - WHY: This is the highest-leverage anti-slop fix. Today the payload only carries `brand_name`. With logo + palette + fonts + voice, Hermes can ground generations and the resulting images stop looking like generic AI office art.

  **Acceptance Criteria**:
  - [ ] `tests/social-content-brand-kit-injection.test.ts`: assert `payload.input.brand.logo_urls.length > 0`, `payload.input.brand.colors.primary` matches brand kit, `payload.input.brand.font_families.length >= 1`, `payload.input.brand.voice` is non-empty.
  - [ ] `tests/social-content-brand-kit-stale.test.ts`: when `business_profiles.updated_at > brand_kit.extracted_at`, fresh kit is extracted before submission.
  - [ ] `npm run validate:social-content` passes.

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Submission carries brand kit (happy)
    Tool: Bash
    Preconditions: tenant T with business_profile.website_url=<known brand URL with extractable logo>; brand-kit cached.
    Steps:
      1. ./node_modules/.bin/tsx scripts/dump-hermes-payload.ts --tenant T --workflow social_content_weekly
    Expected Result: Stdout JSON contains payload.input.brand.{logo_urls,colors.primary,font_families,voice} all non-empty.
    Evidence: .sisyphus/evidence/task-8-payload-has-brand.json

  Scenario: Stale kit triggers refresh (failure-resistance)
    Tool: Bash
    Preconditions: brand kit older than business_profile.updated_at by > TTL
    Steps:
      1. ./node_modules/.bin/tsx scripts/dump-hermes-payload.ts --tenant T --workflow social_content_weekly --trace
    Expected Result: trace shows extractAndSaveTenantBrandKit was called; payload.input.brand reflects refreshed values.
    Evidence: .sisyphus/evidence/task-8-stale-bust.txt
  ```

  **Commit**: YES (T8) — `feat(hermes): inject full brand kit into social_content_weekly payload`

- [x] 9. **Per-channel aspect-ratio matrix in media_requests**

  **What**: Replace hardcoded `aspect_ratio: '4:5'` in `backend/social-content/workflow-request.ts:124` with `resolveAspectRatio({ channel, post_type, image_count })`. Build matrix table: instagram_feed/single → '4:5' or '1:1' (operator-pickable, default 4:5); instagram_feed/carousel (image_count>=2) → '1:1'; facebook_feed/single → '1:1'; facebook_feed/link_card → '1.91:1'. Module exports getAspectMatrix() and getDefaultAspectFor(channel, postType).
  **Must NOT**: Build aspect logic for TikTok/YouTube (excluded). No 9:16 vertical for v1.
  **Agent**: `unspecified-high`. **Wave**: 3. **Blocks**: T13 (frame overlay needs the matrix), T22 (preview UI). **Blocked by**: T8.
  **References**: `backend/social-content/workflow-request.ts:120-135` (current `media_requests`); `backend/social-content/defaults.ts` (FORBIDDEN_VISUAL_PATTERNS for sanity); Meta docs: IG single 4:5 or 1:1, IG carousel 1:1 only, FB feed 1.91:1 link card OR 1:1 single.
  **Acceptance**: aspect-matrix.ts exports `resolveAspectRatio`; workflow-request.ts uses it; tests/social-content-aspect-ratio-matrix.test.ts: each (channel,post_type) combo asserts correct ratio; `npm run test -- --test-name-pattern=aspect` passes.
  **QA Scenarios**:
  ```
  Scenario: IG carousel always 1:1
    Tool: Bash (tsx --test)
    Steps: 1. Run tests/social-content-aspect-ratio-matrix.test.ts. 2. Assert resolveAspectRatio({channel:'instagram_feed', post_type:'carousel', image_count:3}) === '1:1'.
    Expected: PASS. Evidence: .sisyphus/evidence/task-9-carousel.txt
  Scenario: FB link card 1.91:1
    Tool: Bash. Steps: assert resolveAspectRatio({channel:'facebook_feed', post_type:'link_card'}) === '1.91:1'.
    Expected: PASS. Evidence: .sisyphus/evidence/task-9-link-card.txt
  ```
  **Commit**: YES (T9) — `feat(hermes): per-channel aspect-ratio matrix in media_requests`

- [x] 10. **Idempotency key in Hermes submission**

  **What**: In `backend/marketing/ports/hermes.ts` `submissionPayload`, add `idempotency_key: hash(aries_run_id + workflow_version + tenant_id)` (sha256 hex). Hermes deduplicates twin submissions on retry. Also add `Idempotency-Key` HTTP header.
  **Must NOT**: Drop or rename existing `aries_run_id` (callback handlers depend on it).
  **Agent**: `quick`. **Wave**: 3. **Blocks**: none directly. **Blocked by**: T7.
  **References**: `backend/marketing/ports/hermes.ts:269` (current submissionPayload); RFC draft-ietf-httpapi-idempotency-key-header.
  **Acceptance**: Two consecutive POSTs with same `aries_run_id` produce identical idempotency_key; tests/hermes-idempotency.test.ts asserts deterministic hash output.
  **QA**:
  ```
  Scenario: Deterministic key
    Tool: Bash. Steps: invoke buildSubmissionPayload twice with identical inputs; compare idempotency_key strings.
    Expected: equal. Evidence: .sisyphus/evidence/task-10-key.txt
  ```
  **Commit**: YES (T10) — `feat(hermes): idempotency_key in submission`

- [x] 11. **Per-platform caption validator**

  **What**: New module `backend/social-content/caption-validator.ts` exports `validateCaption({ channel, text, hashtags? })` returning `{ ok: boolean, errors: string[] }`. Rules: instagram_feed → max 2200 chars, max 30 hashtags; facebook_feed → max 63206 chars, no hashtag limit. Used by review handler (T19) and pre-publish guard (T24).
  **Must NOT**: Validate other platforms (LinkedIn/X/TikTok deferred).
  **Agent**: `quick`. **Wave**: 3. **Blocks**: T19, T24. **Blocked by**: T7.
  **References**: Meta IG Graph API docs (caption length 2200, hashtag 30); FB Graph API docs.
  **Acceptance**: validateCaption('instagram_feed', 'a'.repeat(2201)) returns `{ok:false, errors:['caption_too_long']}`; tests/caption-validator.test.ts covers boundary cases.
  **QA**:
  ```
  Scenario: IG hashtag overflow
    Tool: Bash. Steps: validateCaption({channel:'instagram_feed', text:'#'.repeat(31).split('').map((c,i)=>'#tag'+i).join(' ')}) → expect ok:false, errors include 'too_many_hashtags'.
    Evidence: .sisyphus/evidence/task-11-hashtags.txt
  ```
  **Commit**: YES (T11) — `feat(social-content): per-platform caption validator`

- [x] 12. **Vision-model post-gen QA service**

  **What**: New module `backend/creative-memory/vision-qa.ts` exports `runVisionQA({ assetUrl, brandKit, channel })` returning `{ verdict: 'pass'|'fail', scores: { brand_color_match, text_legibility, brand_violation, forbidden_pattern_hits }, retry_eligible: boolean, reasons: string[] }`. Thresholds: `brand_color_match >= 0.6` (Lab ΔE < 25 vs nearest palette color in dominant region using sharp + delta-e calc), `text_legibility >= 0.8` (vision model: "is any text readable"), `forbidden_pattern_hits == 0` (vision model checks FORBIDDEN_VISUAL_PATTERNS), `brand_violation < 0.3` (vision model: "does this contradict brand voice"). All four must hold for pass. Persist results to `vision_qa_runs` table (T7). Max 3 retries per creative before forcing operator decision.
  **Must NOT**: Self-host or fine-tune vision model. Use Hermes-provided vision endpoint (Hermes calls OpenAI vision per AGENTS.md). No CRDT for scores. No human-loop training set yet.
  **Agent**: `ultrabrain`. **Wave**: 3. **Blocks**: T13 (frame overlay runs after QA pass), T15 (uploads also QA'd). **Blocked by**: T7, T8.
  **References**: `backend/social-content/defaults.ts:FORBIDDEN_VISUAL_PATTERNS`; `backend/marketing/brand-kit.ts` (palette/voice fields); sharp 0.34+ docs for Lab color extraction; Hermes vision-call contract (TBD via Hermes-side, plan assumes `POST /v1/vision/qa`).
  **Acceptance**: vision-qa.ts module exports `runVisionQA`; persistence to vision_qa_runs; tests/vision-qa-thresholds.test.ts feeds known-good fixture (passes all 4) and known-bad-genericAI fixture (fails brand_color_match).
  **QA**:
  ```
  Scenario: Known-good passes
    Tool: Bash. Preconds: tests/fixtures/vision-qa/good-branded.png, brandKit fixture with primary=#FF6B35.
    Steps: runVisionQA({assetUrl, brandKit, channel:'instagram_feed'}). Assert verdict==='pass', scores.brand_color_match>=0.6.
    Evidence: .sisyphus/evidence/task-12-good.json
  Scenario: Generic AI image fails
    Tool: Bash. Preconds: tests/fixtures/vision-qa/generic-ai-office.png.
    Steps: runVisionQA(...). Assert verdict==='fail', reasons includes 'brand_color_mismatch' or 'forbidden_pattern'.
    Evidence: .sisyphus/evidence/task-12-bad.json
  ```
  **Commit**: YES (T12) — `feat(vision-qa): post-gen QA service with 4 thresholds`

- [ ] 13. **Frame/template overlay (sharp-based)**

  **What**: New module `backend/creative-memory/frame-overlay.ts` exports `applyBrandFrame({ assetBuffer, brandKit, channel, postType })` returning Buffer. Uses sharp to composite a corner logo (bottom-right, 8% width) and a thin 2px border in primary brand color. Apply only when `channel in ['instagram_feed','facebook_feed']` AND `post_type === 'static'` (NOT link cards). Called after vision QA passes; output saved as new asset row `source: 'frame_overlaid'`.
  **Must NOT**: Add frames to videos, link cards, or carousel internal slides (carousel uses single frame only on cover). No drop shadows, no watermark text.
  **Agent**: `visual-engineering`. **Wave**: 4. **Blocks**: T22 (preview UI). **Blocked by**: T8, T9, T12.
  **References**: sharp composite docs; brand-kit.ts logo_urls + primary color; aspect-matrix.ts.
  **Acceptance**: Composite preserves aspect ratio; logo readable at preview size; tests/frame-overlay.test.ts loads fixture, applies overlay, asserts output dimensions match input and SHA differs.
  **QA**:
  ```
  Scenario: IG single gets frame
    Tool: Bash. Preconds: input 1080x1350 jpeg, brand logo png, primary #FF6B35.
    Steps: applyBrandFrame -> save out.png; sharp metadata; assert output dims === input dims, mean color near border ≈ #FF6B35.
    Evidence: .sisyphus/evidence/task-13-ig-single.png
  Scenario: Link card skipped
    Tool: Bash. Steps: applyBrandFrame({postType:'link_card'}) → returns input buffer unchanged (sha equal).
    Evidence: .sisyphus/evidence/task-13-link-skip.txt
  ```
  **Commit**: YES (T13) — `feat(creative-memory): brand frame overlay for IG/FB feed static`

- [ ] 14. **Regenerate as new aries_run (NOT back-step)**

  **What**: New endpoint `POST /api/social-content/jobs/[jobId]/creatives/[creativeId]/regenerate` calls `startMarketingJob` with workflow scope `{ regenerate_creative: { source_run_id, source_creative_id } }`. Hermes returns a new run with single image-creative output. Old creative is preserved with `superseded_by` pointer; new becomes default for review. Aries does NOT replay or back-step the original run (callback handler at `backend/marketing/hermes-callbacks.ts:289` rejects regression).
  **Must NOT**: Modify `applyHermesMarketingCallback` to accept stage regression. No reuse of original run_id.
  **Agent**: `deep`. **Wave**: 4. **Blocks**: T20. **Blocked by**: T8, T12.
  **References**: `backend/marketing/orchestrator.ts:startMarketingJob`; `backend/marketing/hermes-callbacks.ts:289`; T7 schema (creative_assets needs `superseded_by` column - add in T7 migration).
  **Acceptance**: New endpoint returns 202 with new run_id; old creative.superseded_by populated after callback completion; tests/regenerate-creative.test.ts asserts new run_id != source_run_id.
  **QA**:
  ```
  Scenario: Regenerate creates new run
    Tool: curl. Steps: POST /api/social-content/jobs/<jobId>/creatives/<creativeId>/regenerate with valid session.
    Expected: 202 Accepted with body.new_run_id !== source_run_id; DB row updated.
    Evidence: .sisyphus/evidence/task-14-regenerate.json
  ```
  **Commit**: YES (T14) — `feat(social-content): regenerate creative as new aries_run`

- [ ] 15. **Upload-replace UI + backend with NSFW QA gate + 24h orphan retention**

  **What**: New endpoint `POST /api/social-content/jobs/[jobId]/creatives/[creativeId]/upload-replace` accepts multipart image (max 8MB jpg/png/webp, IG limit). Pipeline: validate mime/size → run T12 vision QA (NSFW + brand_violation) → if pass, replace creative.asset_url and mark previous as `orphaned_at = now()` → if fail, surface errors to operator with override option (operator-acknowledged ToS click stores `operator_override: true` in vision_qa_runs row). Background sweep `scripts/gc-orphan-uploads.ts` deletes assets where `orphaned_at < now() - 24h`.
  **Must NOT**: Bypass vision QA silently. No cross-tenant orphan visibility. No automatic publish of overridden uploads (still require approval).
  **Agent**: `unspecified-high`. **Wave**: 4. **Blocks**: T20. **Blocked by**: T1 (tenant prefix), T12 (vision QA).
  **References**: `backend/marketing/asset-ingest.ts` (sha-dedup), T1 storage paths, T12 vision QA; multer or formidable for multipart parsing (check package.json — pg-only project, may need to use raw req body parsing via Next.js Route Handler).
  **Acceptance**: Endpoint returns 202; orphan row populated; gc script dry-run shows correct candidates; tests/upload-replace-nsfw-gate.test.ts.
  **QA**:
  ```
  Scenario: Clean upload replaces creative
    Tool: curl. Steps: POST upload-replace with branded.jpg; assert 202 + creative.asset_url updated; original creative.orphaned_at set.
    Evidence: .sisyphus/evidence/task-15-clean.json
  Scenario: NSFW upload blocked
    Tool: curl. Steps: POST with nsfw fixture; assert 422 with errors=['nsfw_detected']; creative unchanged.
    Evidence: .sisyphus/evidence/task-15-nsfw.json
  ```
  **Commit**: YES (T15) — `feat(creatives): upload-replace with vision QA gate + orphan GC`

- [x] 16. **Onboarding hard gate middleware**

  **What**: Update `lib/auth-user-journey.ts:resolvePostLoginDestinationForUser` AND add a server component guard in `app/dashboard/layout.tsx`: if `business_profiles.incomplete === true` OR `oauth_connections WHERE status='connected' COUNT < 1` → redirect to `/onboarding/start`. The middleware/`middleware.ts` should ALSO enforce on /dashboard/*, /posts/*, /calendar/*, /platforms/*, /social-content/* paths. Public pages (/, /features, /documentation, /api-docs, /login, /onboarding/*) unaffected.
  **Must NOT**: Block /onboarding/* itself (operator must reach it). No flash-of-unredirected content.
  **Agent**: `deep` (tests-first per Metis). **Wave**: 5. **Blocks**: T17, T18. **Blocked by**: T2, T3 (need real Meta connection state).
  **References**: `lib/auth-user-journey.ts:resolvePostLoginDestinationForUser`; `backend/tenant/business-profile.ts:getBusinessProfileWithDiagnostics`; `app/dashboard/layout.tsx`; existing `middleware.ts` (read first to understand auth shape).
  **Acceptance**: tests-first: tests/onboarding-gate.test.ts covers (incomplete profile → /onboarding/start), (complete profile + 0 connections → /onboarding/start), (complete + 1 connection → /dashboard). Playwright E2E in F3.
  **QA**:
  ```
  Scenario: Hard gate redirects
    Tool: Playwright. Preconds: signup new user, partial business_profile, 0 connections.
    Steps: navigate(/dashboard) → wait redirect.
    Expected: page.url() ends with /onboarding/start.
    Evidence: .sisyphus/evidence/task-16-redirect.png
  ```
  **Commit**: YES (T16) — `feat(onboarding): hard gate on profile + ≥1 connected platform`

- [ ] 17. **Connect Meta/IG step in onboarding wizard**

  **What**: New step in `frontend/onboarding/pipeline-intake/index.tsx` (or new wizard component if pipeline-intake is wrong wizard — verify in research) titled "Connect your social accounts". Embeds connection cards for Meta (FB) and IG that link to `/oauth/connect/meta`. After return, show connection state (connected/error) inline; allow proceed once ≥1 connected. Wire to T16 gate (operator cannot finish onboarding without connection).
  **Must NOT**: Show all 7 platforms (only Meta + IG in this step; LinkedIn/X/etc deferred to /platforms post-onboarding). No silent retries on connection error.
  **Agent**: `visual-engineering`. **Wave**: 5. **Blocks**: T18. **Blocked by**: T3, T16.
  **References**: `frontend/onboarding/pipeline-intake/components/StepContainer.tsx` (wizard pattern); `app/api/integrations/route.ts` (connection state); `frontend/onboarding/pipeline-intake/index.tsx` (5-step pattern).
  **Acceptance**: New step renders; Meta + IG cards link to OAuth flow; "Continue" disabled until ≥1 connected; tests/onboarding-connect-step.test.ts (component-level).
  **QA**:
  ```
  Scenario: Continue disabled until connect
    Tool: Playwright. Steps: reach connect step; assert button[Continue] is disabled. Mock connect → assert enabled.
    Evidence: .sisyphus/evidence/task-17-gate.png
  ```
  **Commit**: YES (T17) — `feat(onboarding): connect Meta + IG step`

- [ ] 18. **"Generate this week" manual trigger UI + handler**

  **What**: New button on `/dashboard` ("Generate this week's content") that POSTs to existing `/api/social-content/jobs` with default payload from `backend/social-content/defaults.ts` (7d, 3 static, ≤2 images, 1 video script, 0 video render). Disabled when: another run is in progress for tenant (status in submitted/running/requires_approval), OR profile/connection gate not met. Shows live status via existing `/social-content/status` page link.
  **Must NOT**: Add cron / scheduler (out of v1). No bulk generate. No video render trigger.
  **Agent**: `visual-engineering`. **Wave**: 5. **Blocks**: T22 (preview needs real run output). **Blocked by**: T16, T17.
  **References**: `app/api/social-content/jobs/route.ts`; `backend/social-content/defaults.ts:WEEKLY_SOCIAL_CONTENT_DEFAULTS`; `app/dashboard/posts/page.tsx`; existing run-state lookup in `backend/marketing/runtime-state.ts`.
  **Acceptance**: Button visible only on dashboard for tenants past gate; click triggers POST → 202; UI shows "generating…" with status link; disabled state matches active-run check.
  **QA**:
  ```
  Scenario: Trigger creates run
    Tool: Playwright + curl. Steps: click button; intercept POST /api/social-content/jobs; assert 202 with run_id; UI updates.
    Evidence: .sisyphus/evidence/task-18-trigger.png
  Scenario: Disabled during in-progress run
    Tool: Playwright. Preconds: existing run with status=running. Steps: navigate /dashboard; assert button is disabled.
    Evidence: .sisyphus/evidence/task-18-disabled.png
  ```
  **Commit**: YES (T18) — `feat(dashboard): generate-this-week manual trigger`

- [ ] 19. **Inline copy edit with autosave (single-writer)**

  **What**: Replace read-only copy display in `frontend/aries-v1/review-item.tsx` with native textarea (or contenteditable) for `post_copy.text`. Autosave on blur AND debounce-500ms during typing. New endpoint `PATCH /api/social-content/jobs/[jobId]/posts/[postId]` accepts `{ text, hashtags? }`, validates via T11 caption-validator, persists to runtime-state, updates RuntimeReviewItem.currentVersion. Last-write-wins (no optimistic concurrency); stale `previousVersion` archived.
  **Must NOT**: TipTap/rich-text editor. No version history UI. No keystroke-level history. No bulk edit. No multi-user OT/CRDT.
  **Agent**: `visual-engineering`. **Wave**: 5. **Blocks**: F3 (E2E QA edits a caption). **Blocked by**: T11.
  **References**: `frontend/aries-v1/review-item.tsx`; `backend/marketing/runtime-views.ts:recordMarketingReviewDecision`; T11 caption-validator.
  **Acceptance**: Textarea editable; autosave fires on blur and 500ms after last keystroke; PATCH returns updated post; validation errors surface inline; tests/review-inline-edit.test.ts.
  **QA**:
  ```
  Scenario: Edit + autosave
    Tool: Playwright. Steps: open review item; change caption text; blur; intercept PATCH; assert response 200 + DB row updated.
    Evidence: .sisyphus/evidence/task-19-edit.png
  Scenario: Validator blocks too-long IG caption
    Tool: Playwright. Steps: paste 2300-char text into IG post; blur; assert inline error "Caption too long for Instagram (2200 char limit)".
    Evidence: .sisyphus/evidence/task-19-validator.png
  ```
  **Commit**: YES (T19) — `feat(review): inline copy edit with autosave + caption validator`

- [ ] 20. **Regenerate / upload-replace drawer in review UI**

  **What**: New drawer component `frontend/aries-v1/creative-action-drawer.tsx` triggered from each image in review-item. Two actions: "Regenerate this image" → POST T14 endpoint; "Upload your own" → file picker → POST T15 endpoint. Show vision QA results inline (4 score bars + verdict). On regenerate, show progress spinner until callback updates state. On upload, show vision QA result; if fail, allow operator override with explicit ToS click.
  **Must NOT**: Show regenerate/upload for video scripts (out of v1). No regenerate budget UI yet (3-retry limit enforced server-side, T12).
  **Agent**: `visual-engineering`. **Wave**: 5. **Blocks**: F3. **Blocked by**: T14, T15.
  **References**: `frontend/aries-v1/review-item.tsx`; T14, T15 endpoints; T12 vision-qa scores shape.
  **Acceptance**: Drawer opens per image; regenerate triggers new run + spinner clears on completion; upload-replace shows QA result; ToS override visible only on QA fail.
  **QA**:
  ```
  Scenario: Regenerate flow
    Tool: Playwright. Steps: open review-item; click image regenerate; assert spinner; mock callback → assert image url updated.
    Evidence: .sisyphus/evidence/task-20-regen.png
  Scenario: Upload with NSFW fail
    Tool: Playwright. Steps: drag NSFW fixture; assert error UI + override option; click override + ToS checkbox → save proceeds.
    Evidence: .sisyphus/evidence/task-20-upload-fail.png
  ```
  **Commit**: YES (T20) — `feat(review): creative action drawer (regenerate + upload-replace)`

- [ ] 21. **Reschedule per-post drawer**

  **What**: Add reschedule control to review-item: date+time picker per post + per-platform target toggles (FB-only / IG-only / both). Endpoint `PATCH /api/social-content/jobs/[jobId]/posts/[postId]/schedule` accepts `{ scheduled_at: ISO, platforms: string[] }`. Persists to `scheduled_posts` table (T7). Uses `date-fns` (already a dep).
  **Must NOT**: Calendar drag-and-drop. No timezone picker (use tenant-local timezone from business_profiles or default America/New_York).
  **Agent**: `visual-engineering`. **Wave**: 5. **Blocks**: F3, T24. **Blocked by**: T7.
  **References**: `frontend/aries-v1/review-item.tsx`; T7 scheduled_posts schema; date-fns docs.
  **Acceptance**: Drawer opens; date/time picker functional; platform toggles persist; PATCH returns updated record.
  **QA**:
  ```
  Scenario: Reschedule + platform toggle
    Tool: Playwright + curl. Steps: open drawer; pick tomorrow 9am; toggle FB off; submit; assert PATCH 200; DB scheduled_posts row reflects platforms=['instagram'].
    Evidence: .sisyphus/evidence/task-21-reschedule.png
  ```
  **Commit**: YES (T21) — `feat(review): reschedule + platform-target drawer`

- [ ] 22. **Per-platform preview UI (IG single/carousel + FB feed/link card)**

  **What**: New components `frontend/aries-v1/post-preview/{InstagramFeedSingle,InstagramFeedCarousel,FacebookFeedSingle,FacebookFeedLinkCard}.tsx`. Each renders a faithful platform-style preview with correct aspect ratio (T9 matrix), brand-frame applied (T13), caption truncation per platform (IG 125 chars before "...more", FB 480 chars). Uses next/image with whitelisted domains (T6).
  **Must NOT**: Pixel-perfect 1:1 platform skin (looks-like, not is-the-platform). No interactive comments/likes UI.
  **Agent**: `visual-engineering`. **Wave**: 5. **Blocks**: F3. **Blocked by**: T6, T9, T13.
  **References**: `frontend/components/media-preview.tsx`; T9 aspect-matrix; T13 frame-overlay output URLs; IG/FB design language references.
  **Acceptance**: Each preview renders for fixture data; aspect ratios match matrix; <img> has naturalWidth>0 in test; hashtags styled blue/no-underline.
  **QA**:
  ```
  Scenario: IG single 4:5 renders
    Tool: Playwright. Steps: render component with fixture; assert aspect 4:5 (height/width≈1.25); assert img.naturalWidth>0.
    Evidence: .sisyphus/evidence/task-22-ig-single.png
  Scenario: FB link card 1.91:1 renders
    Tool: Playwright. Steps: render with link fixture; assert aspect ≈1.91; link card chrome present.
    Evidence: .sisyphus/evidence/task-22-fb-link.png
  ```
  **Commit**: YES (T22) — `feat(review): per-platform preview components`

- [x] 23. **Implement (or delete) approval-requests 501 stubs**

  **What**: `app/api/tenant/approval-requests/[approvalRequestId]/{approve,reject}/route.ts` currently return 501. Decision: DELETE both routes (and the `/approval-requests` directory if empty after) — they are dead code; the marketing approval pathway is `/api/marketing/jobs/[jobId]/approve` and `/api/marketing/reviews/[reviewId]/decision`. Remove route files; update any references in codebase via grep.
  **Must NOT**: Implement new approval logic here (canonical path is marketing/reviews). No URL redirects from old → new (no callers exist per research).
  **Agent**: `quick`. **Wave**: 1. **Blocks**: F4 (clean diff). **Blocked by**: none — runs immediately.
  **References**: `app/api/tenant/approval-requests/[approvalRequestId]/{approve,reject}/route.ts` (501 stubs); `app/api/marketing/jobs/[jobId]/approve/handler.ts` (real handler); `app/api/marketing/reviews/[reviewId]/decision/route.ts` (real handler).
  **Acceptance**: Files removed; `git grep "tenant/approval-requests"` returns 0 hits; F4 scope-fidelity check passes.
  **QA**:
  ```
  Scenario: Routes return 404
    Tool: curl. Steps: GET /api/tenant/approval-requests/foo/approve → expect 404 not 501.
    Evidence: .sisyphus/evidence/task-23-404.txt
  ```
  **Commit**: YES (T23) — `chore(api): remove dead 501 approval-requests stubs`

- [x] 24. **Publish dispatcher confirms platform_post_id + GET-verifies (tests-first)**

  **What**: Modify `app/api/publish/dispatch/handler.ts` post-Hermes-callback path to: (1) capture `platform_post_id` from publish callback payload, (2) persist to `posts.platform_post_id` + `published_at`, (3) within 30s of publish, fire a verification GET to `https://graph.facebook.com/v21.0/{platform_post_id}?access_token={page_token}` (use stored Page token from T3) and assert 200 + matching id. On 404/error within 30s window: mark `published_status='unverified'` and trigger F3 alert. Publish succeeds only when GET-verified.
  **Must NOT**: Block dispatch on verification (verification is async post-callback). No hard re-publish on unverified (operator decides).
  **Agent**: `deep` (tests-first). **Wave**: 6. **Blocks**: F3. **Blocked by**: T2, T3, T7, T10.
  **References**: `app/api/publish/dispatch/handler.ts`; `backend/marketing/hermes-callbacks.ts`; T7 posts.platform_post_id column; Meta Graph API doc for post lookup.
  **Acceptance**: tests-first: tests/publish-verification.test.ts mocks Graph API 200 + 404 paths; mocked happy-path persists platform_post_id; 404 path marks unverified.
  **QA**:
  ```
  Scenario: Verified publish
    Tool: curl + db query. Steps: trigger publish; observe callback; query posts.platform_post_id; curl https://graph.facebook.com/v21.0/{id}?access_token=... → expect id in response.
    Evidence: .sisyphus/evidence/task-24-verified.json
  Scenario: Unverified marked
    Tool: Bash + db. Steps: mock Graph 404; assert posts.published_status='unverified'.
    Evidence: .sisyphus/evidence/task-24-unverified.txt
  ```
  **Commit**: YES (T24) — `feat(publish): platform_post_id capture + Graph API GET-verification`

- [x] 25. **Stale-run reaper**

  **What**: New script `scripts/reap-stale-runs.ts`. Sweeps marketing-job runtime docs in DATA_ROOT/generated/draft/marketing-jobs; for each with status in (`submitted`,`running`) where `(now() - last_callback_at)` > 2× expected_stage_duration_ms (lookup from workflow defaults; fallback 30min), mark `status='failed_stale'` with `failure_reason='stale_run_reaper'`. Idempotent. Runs as `--dry-run` by default; CI/cron later (out of v1, but script must exist and be testable).
  **Must NOT**: Auto-restart reaped runs (operator decides). No deletion of runtime docs (audit trail).
  **Agent**: `unspecified-high`. **Wave**: 6. **Blocks**: F3. **Blocked by**: T7.
  **References**: `backend/marketing/runtime-state.ts:loadMarketingJobRuntime`; `backend/marketing/orchestrator.ts:marketingWorkflowTimeoutMs`; existing scripts/ folder for shape.
  **Acceptance**: `npx tsx scripts/reap-stale-runs.ts --dry-run` lists candidate ids; `--apply` mutates; tests/reap-stale-runs.test.ts uses mock filesystem.
  **QA**:
  ```
  Scenario: Reaper finds stale run
    Tool: Bash. Preconds: insert runtime doc with status=running, last_callback_at=now-2h.
    Steps: tsx scripts/reap-stale-runs.ts --dry-run.
    Expected: stdout shows 1 candidate; no mutations.
    Evidence: .sisyphus/evidence/task-25-dry.txt
  ```
  **Commit**: YES (T25) — `chore(ops): stale-run reaper script`

- [ ] 26. **OAuth refresh sweeper + day-50 reconnect-warning email**

  **What**: New script `scripts/oauth-refresh-sweep.ts` (idempotent). For each `oauth_connections` row where `token_expires_at < now() + 24h` AND `status='connected'`: trigger T2 refresh path. For Meta long-lived tokens (60d expiry) where `token_expires_at < now() + 10d`: send reconnect-warning email via Resend (T27 template). For refresh failures: mark `status='reauthorization_required'`. Logs to oauth_audit_events.
  **Must NOT**: Run automatic re-auth (security). No SMS / push notifications (Resend only). No background daemon (script invocation model).
  **Agent**: `unspecified-high`. **Wave**: 6. **Blocks**: none. **Blocked by**: T2, T27.
  **References**: `backend/integrations/refresh.ts` (T2); `lib/email.ts` (Resend client); `oauth_audit_events` schema.
  **Acceptance**: tsx scripts/oauth-refresh-sweep.ts --dry-run lists candidates; --apply refreshes them; failed refreshes flip status; warning emails recorded; tests/oauth-refresh-sweep.test.ts.
  **QA**:
  ```
  Scenario: Refresh sweep dry-run
    Tool: Bash. Preconds: 2 connections expiring in <24h.
    Steps: tsx scripts/oauth-refresh-sweep.ts --dry-run; assert stdout lists 2 candidates.
    Evidence: .sisyphus/evidence/task-26-dry.txt
  Scenario: Day-50 warning sent
    Tool: Bash. Preconds: 1 Meta connection expiring in 9d.
    Steps: --apply; assert Resend mock called with template=meta_reconnect_warning.
    Evidence: .sisyphus/evidence/task-26-warn.txt
  ```
  **Commit**: YES (T26) — `chore(oauth): refresh sweeper + day-50 warning email`

- [x] 27. **Notification email templates (plan-ready, approval-needed, publish-failed, reconnect-warning)**

  **What**: Add 4 templates to `lib/email.ts`: `sendPlanReadyEmail({to, tenantSlug, jobId})`, `sendApprovalNeededEmail({to, tenantSlug, approvalId, step})`, `sendPublishFailedEmail({to, tenantSlug, postId, errorReason})`, `sendMetaReconnectWarningEmail({to, tenantSlug, daysUntilExpiry})`. Plain text + HTML body via Resend. Wire into Hermes callback handler (plan-ready when stage moves to plan_review; approval-needed when requires_approval), publish handler (failure path), and T26 sweeper.
  **Must NOT**: Templating engine (use template literals); no localization (English only); no operator preferences UI yet (always send if email known).
  **Agent**: `writing` for copy + `unspecified-high` for wiring. **Wave**: 6. **Blocks**: F3 (verifies emails fire). **Blocked by**: T7.
  **References**: `lib/email.ts:sendPasswordResetEmail` (existing pattern); Resend docs for `react.email` if used; tenant email lookup via `users.email` joined to `organizations`.
  **Acceptance**: 4 functions exported; each returns Resend message_id on success; tests/email-templates.test.ts mocks Resend client and asserts call shape.
  **QA**:
  ```
  Scenario: Plan-ready fires on stage transition
    Tool: Bash. Steps: simulate Hermes callback to plan_review stage; assert sendPlanReadyEmail mock called once with correct {to, jobId}.
    Evidence: .sisyphus/evidence/task-27-plan-ready.txt
  ```
  **Commit**: YES (T27) — `feat(notifications): plan-ready, approval-needed, publish-failed, reconnect-warning emails`

- [ ] 28. **End-to-end smoke script**

  **What**: New `scripts/smoke-weekly-pipeline.mjs`. Argv: `--tenant <id> --website <url> --auto-approve`. Steps (each asserts inside): (1) signup new test tenant; (2) submit business profile via /api/onboarding; (3) connect Meta (uses test app token from .env.test); (4) trigger /api/social-content/jobs; (5) poll runtime state until plan_review (60s timeout); (6) auto-approve plan; (7) wait for creative_review; (8) auto-approve creatives; (9) wait for publish_review; (10) auto-approve publish; (11) wait for completed (180s timeout); (12) assert posts.platform_post_id captured for each post; (13) GET https://graph.facebook.com/v21.0/{id} returns 200; (14) Playwright navigate /dashboard/posts and assert <img> has naturalWidth>0 for each post. Exit 0 on full green; non-zero on any assertion failure.
  **Must NOT**: Use production Meta credentials. No skip-flags. No "soft fail" mode.
  **Agent**: `deep`. **Wave**: 6. **Blocks**: F3. **Blocked by**: T1-T27 (this is the integration capstone).
  **References**: `tests/marketing-job-flow.test.ts` (integration test pattern); `tests/social-content-execution-contract.test.ts`; existing `scripts/` folder.
  **Acceptance**: Running `tsx scripts/smoke-weekly-pipeline.mjs --tenant test_xyz --website https://test-brand.example.com --auto-approve` exits 0 with all 14 step-assertions logged.
  **QA**:
  ```
  Scenario: Full smoke green
    Tool: Bash + Playwright. Preconds: clean DB, .env.test with test Meta credentials, test tenant slug unused.
    Steps: tsx scripts/smoke-weekly-pipeline.mjs --tenant smoke_$(date +%s) --website https://test-brand.example.com --auto-approve.
    Expected: exit 0; stdout shows 14 PASS lines; .sisyphus/evidence/final-qa/ has screenshots.
    Evidence: .sisyphus/evidence/task-28-smoke-green.txt + .sisyphus/evidence/final-qa/*.png
  ```
  **Commit**: YES (T28) — `test(smoke): end-to-end weekly pipeline integration script`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [ ] **F1. Plan Compliance Audit** — `oracle`

  Read this plan end-to-end. For each "Must Have" item: verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": grep for forbidden patterns and reject with file:line if found. Confirm evidence files exist in `.sisyphus/evidence/`. Compare deliverables vs plan.

  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] **F2. Code Quality Review** — `unspecified-high`

  Run `npm run typecheck`, `npm run test`, `npm run verify`, `npm run validate:repo-boundary`, `npm run validate:banned-patterns`, `npm run validate:social-content`, `npm run validate:execution-provider`, `npm run validate:marketing-flow`. Review every changed file for: `as any` / `@ts-ignore` / `@ts-expect-error`, empty catches, `console.log` in production code, commented-out blocks, unused imports. Audit for AI slop: excessive comments, premature abstractions, generic names (`data`, `result`, `item`, `temp`).

  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass / N fail] | Files [N clean / N issues] | VERDICT`

- [ ] **F3. Real Manual QA** — `unspecified-high` + `playwright` skill

  Boot a clean local instance. As a NEW user: sign up → fill business profile → try to reach `/dashboard` (expect redirect) → connect Meta → connect IG (Page picker, Business Account discovery) → reach `/dashboard` → click "Generate this week" → wait for plan ready → review (regenerate one image, upload-replace another, inline-edit one caption, reschedule one post) → approve → confirm publish → confirm `platform_post_id` shows on `/dashboard/posts` → confirm image renders (`naturalWidth > 0`). Save screenshots + curl outputs to `.sisyphus/evidence/final-qa/`. Test cross-tenant: tenant B cannot see tenant A's assets / posts / runs.

  Output: `E2E happy path [PASS/FAIL] | Cross-tenant [N/N isolated] | Image render [N/N rendered] | VERDICT`

- [ ] **F4. Scope Fidelity Check** — `deep`

  For each task: read "What to do", read actual diff via `git log -p`. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Audit "Must NOT Have" compliance. Detect cross-task contamination (Task N touching Task M's files). Flag unaccounted file changes. Ensure no banned patterns: `as any`, `console.log`, `campaign` in user-facing strings outside Meta Ads API client, Lobster/OpenClaw imports.

  Output: `Tasks [N/N compliant] | Contamination [CLEAN / N issues] | Unaccounted [CLEAN / N files] | Banned patterns [CLEAN / N] | VERDICT`

---

## Commit Strategy

> One task = one commit. Commit messages follow conventional commits: `type(scope): description`.

- T1: `fix(assets): tenant-prefix storage keys + migration script` — backend/marketing/asset-library.ts, asset-ingest.ts, scripts/migrate-asset-tenant-prefix.ts, tests/asset-tenant-isolation.test.ts; verify `npm run test -- --test-name-pattern="asset.*tenant"`
- T2: `feat(oauth): real refresh + Meta long-lived exchange + concurrency lock` — backend/integrations/refresh.ts, refresh-meta.ts, refresh-{provider}.ts (per-provider), tests/oauth-refresh-*.test.ts; verify `npm run test -- --test-name-pattern="oauth.*refresh"`
- T3: `feat(oauth-meta): long-lived exchange + IG Business Account discovery + page picker` — backend/integrations/meta/callback.ts, lib/meta-page-picker.tsx, app/onboarding/connect/meta/page.tsx, tests/oauth-meta-callback.test.ts; verify `npm run test -- --test-name-pattern="meta.*callback"`
- T4: `feat(callback): per-run callback token defense in depth` — backend/marketing/ports/hermes.ts, lib/internal-callback-auth.ts, app/api/internal/hermes/runs/route.ts, scripts/init-db.js (oauth_callback_tokens table), tests/callback-token.test.ts
- T5: `fix(publish): validate media_urls tenant ownership` — app/api/publish/dispatch/handler.ts, backend/integrations/workflow-orchestrator.ts, tests/publish-tenant-isolation.test.ts
- T6: `fix(images): images.remotePatterns whitelist + dev fallback` — next.config.mjs, frontend/components/media-preview.tsx
- T7: `feat(db): posts.platform_post_id/published_at/scheduled_at + vision_qa_runs + scheduled_posts + oauth_callback_tokens` — scripts/init-db.js, types/posts.ts, types/vision-qa.ts
- T8: `feat(hermes): inject full brand kit into social_content_weekly payload` — backend/social-content/workflow-request.ts, tests/social-content-brand-kit-injection.test.ts
- T9: `feat(hermes): per-channel aspect-ratio matrix in media_requests` — backend/social-content/workflow-request.ts, backend/social-content/aspect-matrix.ts, tests/social-content-aspect-ratio-matrix.test.ts
- T10: `feat(hermes): idempotency_key in submission` — backend/marketing/ports/hermes.ts, tests/hermes-idempotency.test.ts
- T11: `feat(content): caption length validator per channel` — backend/social-content/caption-validator.ts, tests/caption-validator.test.ts
- T12: `feat(images): vision QA service with 4-metric thresholds + retry budget` — backend/social-content/vision-qa.ts, backend/social-content/vision-qa-thresholds.ts, tests/vision-qa-thresholds.test.ts
- T13: `feat(images): frame overlay service for IG/FB feed` — backend/social-content/frame-overlay.ts (uses sharp), backend/social-content/frame-templates/, tests/frame-overlay.test.ts
- T14: `feat(images): regenerate creates scoped aries_run` — backend/marketing/regenerate-creative.ts, app/api/social-content/jobs/[jobId]/creatives/[creativeId]/regenerate/route.ts, tests/regenerate-creative.test.ts
- T15: `feat(images): upload-replace UI + backend with QA gate + 24h orphan retention` — app/api/social-content/jobs/[jobId]/creatives/[creativeId]/upload/route.ts, frontend/components/upload-replace.tsx, backend/marketing/orphan-gc.ts, tests/upload-replace.test.ts
- T16: `feat(onboarding): hard gate middleware (profile + ≥1 connection)` — middleware.ts (or app/dashboard/layout.tsx), lib/onboarding-gate.ts, tests/onboarding-gate.test.ts
- T17: `feat(onboarding): connect Meta/IG step` — frontend/onboarding/pipeline-intake/steps/ConnectPlatforms.tsx, app/onboarding/connect/page.tsx
- T18: `feat(social-content): manual "Generate this week" trigger` — app/dashboard/page.tsx, app/api/social-content/jobs/route.ts (extend), tests/manual-trigger.test.ts
- T19: `feat(review): inline copy edit autosave` — frontend/aries-v1/review-item.tsx, app/api/marketing/reviews/[reviewId]/copy/route.ts, tests/review-copy-autosave.test.ts
- T20: `feat(review): regenerate + upload-replace drawer per image` — frontend/aries-v1/image-actions-drawer.tsx, frontend/aries-v1/review-item.tsx
- T21: `feat(review): reschedule drawer (date/time + platforms)` — frontend/aries-v1/reschedule-drawer.tsx, app/api/marketing/reviews/[reviewId]/schedule/route.ts, tests/review-reschedule.test.ts
- T22: `feat(review): per-platform preview (IG single/carousel, FB link card)` — frontend/aries-v1/post-preview-{ig-single,ig-carousel,fb-feed,fb-link-card}.tsx
- T23: `fix(approvals): implement (or delete) approval-requests endpoints` — app/api/tenant/approval-requests/[approvalRequestId]/{approve,reject}/route.ts (DELETE the 501 stubs OR wire to approval-store)
- T24: `feat(publish): confirm platform_post_id + GET-verify` — app/api/publish/dispatch/handler.ts, backend/integrations/publish-confirm.ts, tests/publish-confirm.test.ts
- T25: `feat(reaper): stale-run reaper script` — scripts/reap-stale-runs.ts, tests/reap-stale-runs.test.ts
- T26: `feat(oauth): token refresh sweeper + day-50 warning email` — scripts/refresh-oauth-tokens.ts, lib/email-templates/reconnect-warning.tsx
- T27: `feat(notifications): plan-ready / approval-needed / publish-failed templates` — lib/email.ts, lib/email-templates/{plan-ready,approval-needed,publish-failed}.tsx
- T28: `test(smoke): end-to-end weekly pipeline smoke script` — scripts/smoke-weekly-pipeline.mjs

---

## Success Criteria

### Verification Commands (all run by F1/F2 agents; all must pass)

```bash
# Build & type
npm run typecheck                              # Expected: 0 errors
npm run dev &                                  # Expected: serves on :3000 (Turbopack required)

# Repo boundary + naming
npm run validate:repo-boundary                 # Expected: PASS
npm run validate:banned-patterns               # Expected: PASS
npm run verify                                 # Expected: PASS

# Domain validators
npm run validate:social-content                # Expected: PASS
npm run validate:execution-provider            # Expected: PASS
npm run validate:marketing-flow                # Expected: PASS

# Tests
npm run test                                   # Expected: 100% pass
./node_modules/.bin/tsx --test tests/asset-tenant-isolation.test.ts          # tenant prefix
./node_modules/.bin/tsx --test tests/oauth-refresh-*.test.ts                 # refresh
./node_modules/.bin/tsx --test tests/oauth-meta-callback.test.ts             # Meta long-lived + IG BA
./node_modules/.bin/tsx --test tests/callback-token.test.ts                  # per-run token
./node_modules/.bin/tsx --test tests/publish-tenant-isolation.test.ts        # media_url ownership
./node_modules/.bin/tsx --test tests/social-content-brand-kit-injection.test.ts
./node_modules/.bin/tsx --test tests/social-content-aspect-ratio-matrix.test.ts
./node_modules/.bin/tsx --test tests/vision-qa-thresholds.test.ts
./node_modules/.bin/tsx --test tests/onboarding-gate.test.ts
./node_modules/.bin/tsx --test tests/publish-confirm.test.ts

# Smoke
./node_modules/.bin/tsx scripts/smoke-weekly-pipeline.mjs --tenant test_tenant_xyz --auto-approve
# Expected exit 0, with assertions: onboarding done, connection 'connected', run created, plan-ready callback,
# approval resolved, publish dispatched with platform_post_id, GET round-trip 200, naturalWidth > 0 in dashboard.
```

### Final Checklist

- [ ] All 28 implementation tasks committed with task-scoped commit messages.
- [ ] All 4 final verification reviews APPROVED.
- [ ] User has explicitly said "okay" after seeing F1-F4 results.
- [ ] All "Must Have" items present and verified by F1.
- [ ] All "Must NOT Have" items absent and verified by F4.
- [ ] All evidence files in `.sisyphus/evidence/` per task.
- [ ] PR created against base branch (NEVER pushed to master).
- [ ] `npm run workspace:verify` passes.
