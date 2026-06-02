# Shareable Client Campaign Preview — comments + approval gate + expiry + password

> Status: draft plan (2026-06-01). Roadmap area [9], priority 6 ("9th best to build first"). This turns the **read-only public artifact resolver** that already exists (`backend/marketing/public-pages.ts`) into a real **client-facing share SYSTEM**: an operator mints a tokenized, optionally password-protected, expiring link that renders a campaign's approved/unapproved sections (landing-page preview, ad-creative drafts, scheduled posts), collects client comments, and gates publishing behind a client "approve" action. Default OFF behind `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED`.

## Context

The catch-all `app/[...publicPath]/route.ts` → `resolvePublicMarketingArtifact()` already serves generated landing pages for any path whose first segment starts with `public-` (`backend/marketing/public-pages.ts:334`). That is a **static, unauthenticated, un-scoped, never-expiring** artifact server: anyone who guesses `public-<slug>/campaign` sees the page, there is no comment collection, no notion of "approved vs draft," no expiry, no password, and it is decoupled from the approval pipeline. It serves marketing *landing pages*, not a *client review of the whole campaign*.

Roadmap area [9] asks for the opposite of "static public page": a **deliberately minted, revocable, time-boxed, access-controlled client review surface** that shows the full campaign (plan + creative drafts + scheduled posts), sections the artifacts by approval state, collects client comments per-artifact, and wires a client "Approve campaign" action into the existing approval gate so **nothing publishes until the client signs off**. Grep confirms none of expiry / password / share-token / comment / client-approval exists today (`campaign_share`, `share_link`, `preview_token`, `client_preview`, `campaign_preview_shares` → zero matches across `backend/`, `app/`, `migrations/`, `scripts/init-db.js`).

This is the safety story Aries leads with: "Nothing goes live without approval, and every publish action is traceable." A client-facing approval gate is the most literal expression of that. It is also the natural client-facing complement to the operator Review Queue (`app/api/marketing/reviews/*`).

## Who cares

- **Operators / the @sugarandleather tenant** — today they screenshot the dashboard and paste into email/Slack to get client sign-off. A real share link replaces that with a branded, traceable, link.
- **The client (campaign approver outside Aries)** — gets a single URL, sees exactly what will run, comments inline, and clicks one button to authorize publishing. No Aries login.
- **Product** — "safety-first, approval-gated" is the headline differentiator; a client-approval gate makes it concrete and demoable.
- **Eng** — reuses the static public resolver, the HMAC token precedent (`lib/signed-media-token.ts`), the approval store, and the marketing review-decision path — small new surface, large product payoff, no new infra.

## Decisions (locked — do not re-litigate)

1. **Brand URL is `https://aries.sugarandleather.com`, NEVER bare `sugarandleather.com`.** Share URLs are minted from `metadataSiteOrigin()` (`lib/metadata-site-url.ts`, which already falls back to `https://aries.sugarandleather.com`). No new origin constant; do not hardcode a host.
2. **Tokenized, not slug-guessable.** Share access is a signed, high-entropy token, NOT the `public-<slug>` path. The existing `public-<slug>/campaign` static path is left exactly as-is (it is a *published* landing page, a different concept). The new preview lives under a distinct route prefix `/preview/[shareToken]` so the two never collide — in the App Router the specific `app/preview/[shareToken]/route.ts` segment takes precedence over the `app/[...publicPath]/route.ts` catch-all, so the catch-all never sees `/preview/*`.
3. **DB-backed share records, not file-only.** A new `campaign_preview_shares` table is the source of truth for `share_token` (hashed), `expires_at`, `password_hash`, `revoked_at`, `tenant_id`, `marketing_job_id`. Comments and the client approval decision are DB rows. This keeps tenant-scoping, expiry, and revocation server-validated (CLAUDE.md: "All authenticated API routes resolve tenant context server-side"; public routes validate the token server-side).
4. **Password is optional and stored hashed (scrypt), compared timing-safe.** Reuse the `timingSafeEqual` precedent (`backend/integrations/slack/events/verify.ts:86`, `lib/internal-callback-auth.ts:23`). The plaintext password is shown to the operator once at mint time and never persisted in plaintext.
5. **Read-only for the public.** The share surface can do exactly three writes, all token-scoped and rate-limited: unlock (password), add a comment, and record the single client approval decision. It can NEVER trigger a publish directly, see other tenants' data, or mutate the campaign artifacts.
6. **Client approval is a GATE, not an auto-publish.** A client "Approve" sets `client_approval_state='approved'` on the share and surfaces it in the operator Review Queue as a precondition. The operator still performs the actual publish via the existing approval path. We never publish autonomously from a public action (guardrail: nothing publishes without human approval; never expose `MARKETING_STATUS_PUBLIC=1`).
7. **Default OFF behind `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED`.** When OFF: the mint endpoint 404s, the `/preview/*` route 404s (branded), and operator UI hides the "Share with client" affordance. Schema + token plumbing ship inert.
8. **Resumability / idempotency.** Mint is idempotent per `(tenant_id, marketing_job_id)` active share (reuse existing unexpired token rather than minting duplicates unless `rotate=true`). Comment inserts carry a client-supplied idempotency key. The client approval decision is single-shot and write-once.

## Current State (VERIFIED — branch `fix/story-composer-serving`)

**Public resolver — `backend/marketing/public-pages.ts`:**
- `resolvePublicMarketingArtifact(pathname)` (line 407): tries a direct file under `artifactOutputRoots()`, then a `public-<slug>/campaign` campaign file, then a landing-page contract match.
- `findLandingContractBySlug()` (line 307) requires the first path segment to start with `public-` (line 334) — this is the ONLY access control. No token, no expiry, no password, no tenant check.
- Renders `landing-pages/index.html` with injected design-system CSS + `<base href>`, or a `buildFallbackLandingHtml()` (line 270). Serves images/video bytes with content sniffing. `escapeHtml()` (line 219) is the HTML-escape helper the new view-model reuses.
- **No comment, approval, sectioning, expiry, or password code anywhere in this file.**

**Catch-all route — `app/[...publicPath]/route.ts`:**
- `force-dynamic` (line 3); `GET`/`HEAD` only (lines 113/117); 404s with branded inline HTML (`NOT_FOUND_HTML`, line 11) to avoid a redirect loop. This is the pattern the new `/preview` route follows for its own branded states (locked / expired / not-found).

**Approval pipeline — `backend/marketing/approval-store.ts` + `backend/marketing/runtime-views.ts` + `app/api/marketing/reviews/[reviewId]/decision/route.ts`:**
- `MarketingApprovalRecord` (`approval-store.ts:24`) is the operator-side approval (file-backed under `generated/draft/marketing-approvals`, `approval-store.ts:95`). `recordMarketingReviewDecision()` is **exported from `backend/marketing/runtime-views.ts`** and imported by `decision/route.ts:5`; the route resolves tenant via `loadTenantContextOrResponse()` (`decision/route.ts:22`) and resolves an operator review with `approve | changes_requested | reject` (`decision/route.ts:45`, called at line 53).
- The client-approval gate **reads into** this flow (it adds a precondition surfaced in the review queue); it does not replace it.

**Review queue — `backend/marketing/runtime-views.ts`:**
- `pendingApprovals` is denormalized O(1): read from `record.pending_approval_count` (lines 1731-1733, per #521), with a self-heal/persist fallback. The client-approval state is an additional, independent field surfaced alongside — do NOT couple it to the `pendingApprovals` count compute (CLAUDE.md memory: that count is inseparable from the heavy per-job hydration; don't touch it).

**Campaign artifact assembly — `backend/marketing/dashboard-content.ts` + `backend/social-content/dashboard-projection.ts`:**
- `dashboard-content.ts` already enumerates landing-page contracts (lines 1808-1868), creative assets per platform (lines 1830-1943), and scheduled/publish items. `dashboard-projection.ts` projects a job's `posts`, `image_creatives`, `video_scripts` (lines 344-391). **The preview view-model reuses these projections** rather than re-querying — it adds an "approval state" sectioning on top.

**Schema — `scripts/init-db.js`:**
- `posts` (line 396) carries `published_status` (`draft|in_review|approved|scheduled|publishing|published|failed|rolled_back|unverified`, active constraint at line 420) and `surface` (line 440). `scheduled_posts` (line 462) carries `scheduled_for`, `surface`, `media_type`. These give the "approved vs unapproved" + "scheduled posts" sections their data. `organizations` (line 18) is the tenant table that all `tenant_id` FKs reference (`REFERENCES organizations(id) ON DELETE CASCADE`). Latest migration: `migrations/20260531120000_posts_surface.sql`. Precedent for a hashed-token table already exists: `oauth_callback_tokens` uses `token_hash CHAR(64) PRIMARY KEY`.
- **No share / comment / client-approval table.**

**Token precedent — `lib/signed-media-token.ts`:**
- `signMediaToken` / `verifyMediaToken` with URL-safe base64 (`urlSafeB64Encode`, line 7), HMAC-SHA256, `expiresAt` (Unix ms), and "Returns null on any failure — callers must not learn why" (lines 58-60). The share token reuses these primitives (`urlSafeB64Encode`, `timingSafeEqual`) but persists the record in DB for revocation + comments.

**Base URL — `lib/metadata-site-url.ts`:** `metadataSiteOrigin()` (line 1) returns the canonical origin, defaulting to `https://aries.sugarandleather.com` (line 6). Share-link minting uses this. No bare-domain risk.

**DB access — `lib/db.ts`:** exports `pool`. Queries are parameterized (`pool.query(sql, params)`); tenant-scoped writes resolve tenant via `getTenantContext()` (`lib/tenant-context.ts:141`) / `loadTenantContextOrResponse()` (`lib/tenant-context-http.ts:13`).

## Architecture (target data flow)

```
OPERATOR (authenticated)
  app/dashboard/.../[job] → "Share with client" → POST /api/marketing/jobs/[jobId]/preview-share
        │  mints (or reuses) a share: random token → token_hash, optional password → scrypt hash,
        │  expires_at (default +7d), tenant_id, marketing_job_id
        ▼
  campaign_preview_shares (DB)  ──>  returns ONE-TIME plaintext token + password to operator
        │                            URL = `${metadataSiteOrigin()}/preview/<token>`  (aries.sugarandleather.com)
        ▼
CLIENT (no Aries login, opens the link)
  app/preview/[shareToken]/route.ts  (force-dynamic, ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED gate)
   ├─ verifyShareToken(token) → look up by token_hash → check revoked_at / expires_at
   ├─ if password_hash set and no valid unlock cookie → render branded PASSWORD prompt
   ├─ else → buildClientPreviewViewModel(tenantId, jobId):
   │        SECTION 1  Campaign plan (weekly themes / calendar)        [approved | draft badges]
   │        SECTION 2  Landing-page preview (reuse public-pages render, read-only iframe/section)
   │        SECTION 3  Ad-creative drafts (image_creatives, per-platform)
   │        SECTION 4  Scheduled posts (scheduled_posts: date/time/platform/surface)
   │        SECTION 5  Comments (read existing) + add-comment box
   │        SECTION 6  "Approve this campaign for publishing" button (single-shot)
   ▼
CLIENT WRITES (token-scoped, rate-limited, read-only otherwise)
   POST /api/preview/[shareToken]/unlock     → set short-lived signed unlock cookie
   POST /api/preview/[shareToken]/comments   → insert campaign_preview_comments row
   POST /api/preview/[shareToken]/decision   → set client_approval_state=approved|changes_requested
        │
        ▼
OPERATOR Review Queue
  runtime-views surfaces share.client_approval_state + comment count as a publish PRECONDITION
  operator still performs the real publish via app/api/marketing/reviews/[reviewId]/decision
        │
        ▼
  Existing approval-gated publish path (unchanged). NO autonomous publish from the public action.
```

## Child phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Schema + share-token core (`campaign_preview_shares`, `_comments`; sign/verify/scrypt) | Critical | 3h / 1h | none |
| B | Operator mint/list/revoke endpoints (`/api/marketing/jobs/[jobId]/preview-share`) | High | 3h / 1h | A |
| C | Public preview route + view-model (sectioned read-only render, password prompt, expiry/404 states) | High | 6h / 2.5h | A, B |
| D | Public write endpoints (unlock / comments / decision) + rate limiting + idempotency | High | 4h / 1.5h | A, C |
| E | Operator UI: "Share with client" panel + comments + client-approval precondition in Review Queue | High | 5h / 2h | B, C, D |
| F | Flag, docs, ROUTE_MANIFEST, live E2E on tenant 15, ship | Medium | 3h / 1h | A–E |

**Sequencing:** A first (everything reads the share record). B + C parallel after A (C can render against a hand-seeded share row while B's mint endpoint lands). D after C (writes need the resolved share context the route establishes). E after B/C/D (UI wires all three). F last (needs the full loop to verify live).

```
A ─┬─> B ──┐
   └─> C ──┼─> D ──> E ──> F
```

---

### A — Schema + share-token core (Critical, 3h)

**Implementation:**
1. New migration `migrations/20260601120000_campaign_preview_shares.sql` (additive, idempotent):
   ```sql
   CREATE TABLE IF NOT EXISTS campaign_preview_shares (
     id BIGSERIAL PRIMARY KEY,
     tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     marketing_job_id TEXT NOT NULL,
     token_hash CHAR(64) NOT NULL UNIQUE,          -- sha256 of the raw token; raw token never stored
     password_hash TEXT,                            -- scrypt(salt$hash); NULL = no password
     expires_at TIMESTAMPTZ NOT NULL,
     client_approval_state TEXT NOT NULL DEFAULT 'pending'
       CHECK (client_approval_state IN ('pending','approved','changes_requested')),
     client_decided_at TIMESTAMPTZ,
     created_by TEXT NOT NULL,
     revoked_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS idx_preview_shares_tenant_job
     ON campaign_preview_shares (tenant_id, marketing_job_id);

   CREATE TABLE IF NOT EXISTS campaign_preview_comments (
     id BIGSERIAL PRIMARY KEY,
     share_id BIGINT NOT NULL REFERENCES campaign_preview_shares(id) ON DELETE CASCADE,
     tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     section_key TEXT NOT NULL,                     -- 'plan'|'landing'|'creative:<id>'|'scheduled'|'general'
     author_label TEXT,                             -- client-supplied display name, sanitized
     body TEXT NOT NULL,
     idempotency_key TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (share_id, idempotency_key)
   );
   CREATE INDEX IF NOT EXISTS idx_preview_comments_share ON campaign_preview_comments (share_id, created_at);
   ```
   Mirror both `CREATE TABLE`s into `scripts/init-db.js` so fresh installs match prod. Add them alongside the other `CREATE TABLE IF NOT EXISTS` blocks that follow the `scheduled_posts` cluster — e.g. next to `marketing_operator_creative_preferences` / `honcho_write_idempotency_keys` (~line 535+). The hashed-token shape mirrors the existing `oauth_callback_tokens (token_hash CHAR(64) ...)` precedent already in this file.
2. New `backend/marketing/preview-share-store.ts`:
   - `generateShareToken()` → 32 random bytes, `urlSafeB64Encode` (reuse `lib/signed-media-token.ts`).
   - `hashShareToken(raw)` → `createHash('sha256')` hex (matches `token_hash CHAR(64)`; precedent `oauth_callback_tokens`).
   - `hashPreviewPassword(plain)` / `verifyPreviewPassword(plain, stored)` → `scryptSync` with random salt, compared via `timingSafeEqual` (precedent: `backend/integrations/slack/events/verify.ts:86`).
   - `createShare()`, `findActiveShareForJob()`, `resolveShareByToken(rawToken)` (returns `null` on miss/expired/revoked — never leak why), `revokeShare()`, `recordClientDecision()`, `addComment()`, `listComments()`. All parameterized, all tenant-scoped on writes.
   - Unlock cookie: short-lived HMAC token scoped to `share_id` (reuse `createHmac` + `timingSafeEqual`); NOT the password.

**Acceptance (Phase A is non-UI plumbing — not "done" by guardrail; counts only at F):** unit tests for token round-trip, password hash/verify (correct + wrong + absent), expiry boundary, revocation, and `resolveShareByToken` returning null for expired/revoked/unknown.

### B — Operator mint / list / revoke endpoints (High, 3h)

**Implementation:** New route handlers under `app/api/marketing/jobs/[jobId]/preview-share/` (sibling to the existing `approve/`, `assets/`, `publish-facebook/` handlers under `app/api/marketing/jobs/[jobId]/`):
1. `POST` → mint: resolves tenant via `loadTenantContextOrResponse()` (precedent: `app/api/marketing/reviews/[reviewId]/decision/route.ts:22`), confirms the job belongs to the tenant, then idempotently reuses `findActiveShareForJob()` unless `body.rotate === true`. Accepts `{ expiresInDays?: number (default 7, max 30), password?: string }`. Returns `{ shareUrl, token (one-time), password (one-time, only if set), expiresAt }`. `shareUrl = \`${metadataSiteOrigin()}/preview/${token}\`` — canonical `aries.sugarandleather.com` origin.
2. `GET` → list active shares for the job (token NOT returned again — only `shareUrlMasked`, `expiresAt`, `revoked`, `commentCount`, `clientApprovalState`).
3. `DELETE` (or `POST {action:'revoke'}`) → set `revoked_at`.
4. **Flag gate:** when `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED` is off, all three 404 (consistent with the public route).

**Acceptance:** an authenticated operator request mints a share; a second mint without `rotate` returns the same token-less metadata (idempotent); a cross-tenant job id 404s; revoke flips `revoked_at`; flag OFF ⇒ 404.

### C — Public preview route + view-model (High, 6h)

**Implementation:**
1. New `app/preview/[shareToken]/route.ts` (`force-dynamic`, `GET`/`HEAD`), mirroring the branded-state pattern of `app/[...publicPath]/route.ts` (the specific segment wins over the catch-all, so this handler — not the catch-all — serves `/preview/*`):
   - Flag OFF ⇒ branded 404.
   - `resolveShareByToken(token)` null ⇒ branded **"Link expired or unavailable"** 404 (no distinction between expired/revoked/unknown — token verify never leaks why, per `lib/signed-media-token.ts:58-60`).
   - `password_hash` set and no valid unlock cookie ⇒ render branded **password prompt** HTML (posts to `/api/preview/[shareToken]/unlock`).
   - Else ⇒ render the sectioned preview from the view-model.
2. New `backend/marketing/preview-view-model.ts`: `buildClientPreviewViewModel(tenantId, marketingJobId)` composes:
   - **Plan / themes / calendar** — from the same projection `backend/social-content/dashboard-projection.ts` produces (reuse, do not re-query).
   - **Landing-page preview** — reuse `resolvePublicMarketingArtifact()` output for the job's `public-<slug>/campaign` landing HTML, embedded read-only (sandboxed iframe or inlined section). Asset URLs resolve through the existing media path.
   - **Ad-creative drafts** — `image_creatives` per platform from the projection; each tagged `approved` (post `published_status IN ('approved','scheduled','published')`) vs `draft`.
   - **Scheduled posts** — `scheduled_posts` rows (date / local time / platform / surface), tenant-scoped.
   - **Comments** — `listComments(shareId)`.
   - **Client approval state** — from the share record; controls whether the approve button is enabled or shows "Already approved on <date>".
   - All client-visible strings escaped (reuse `escapeHtml` from `public-pages.ts:219`); author labels sanitized.
3. Render server-side HTML (no auth client bundle); brand it with the design-system CSS the public resolver already inlines. Every CTA/footer link uses `metadataSiteOrigin()` — never a bare domain.

**Acceptance:** opening a valid no-password token renders all 5 sections with correct approved/draft badges; a password-protected token shows the prompt first; an expired token shows the branded expired page; sections show real job data (rendered HTML, not JSON).

### D — Public write endpoints (unlock / comments / decision) (High, 4h)

**Implementation:** New handlers under `app/api/preview/[shareToken]/` (this `app/api/preview/` namespace does not exist today — clear to create):
1. `unlock` (`POST`): verify `verifyPreviewPassword(body.password, share.password_hash)` timing-safe; on success set the short-lived `share_id`-scoped HMAC unlock cookie; on failure return a generic 401 (no "wrong password vs no password" distinction beyond the literal prompt). Rate-limit per token_hash (in-memory token bucket; reuse the existing approach if one exists, else a simple per-process map keyed by token_hash — acceptable for single-tenant prod).
2. `comments` (`POST`): require a valid share (and unlock cookie if password-protected); insert via `addComment()` with the client `idempotency_key` (UNIQUE `(share_id, idempotency_key)` makes replay a no-op). Sanitize `author_label`/`body`; cap length. Returns the created comment.
3. `decision` (`POST`): require valid share; set `client_approval_state` to `approved` or `changes_requested` via `recordClientDecision()` (write-once: if already decided, return the existing decision idempotently). Persist `client_decided_at`. **This never publishes** — it only flips the gate state.
4. All three: flag-gated, token-scoped, never accept or trust a `tenant_id`/`job_id` from the body (derive from the resolved share).

**Resumability / idempotency:** comment inserts dedupe on `(share_id, idempotency_key)`; the decision is write-once and re-returns the prior outcome on replay; unlock is stateless (cookie). A duplicate client submit never double-writes.

**Acceptance:** wrong password ⇒ 401 + no cookie; correct ⇒ cookie + sections; a comment persists and re-appears on reload; replaying the same comment idempotency key is a no-op; clicking approve flips `client_approval_state` and a second click is idempotent; no public action can publish.

### E — Operator UI + Review Queue precondition (High, 5h)

**Implementation:**
1. **Share panel** in the job/campaign operator view (the screen that already shows a job's posts/creative — `frontend/aries-v1/results-screen.tsx` / `review-item.tsx` / `review-queue.tsx`): a "Share with client" button → calls `POST /api/marketing/jobs/[jobId]/preview-share` → shows the one-time URL + password in a copy-once modal, plus the active-shares list (expiry, comment count, client state, Revoke).
2. **Comments surface**: render the client's comments (read-only for the operator in v1) inside the job review view, grouped by `section_key`.
3. **Review Queue precondition**: surface `client_approval_state` + comment count on the relevant review item (`frontend/aries-v1/review-item.tsx`). When a tenant policy says "client must approve before publish," the operator publish action shows a **blocking banner** ("Awaiting client approval — shared 2026-06-01, expires 2026-06-08") until `client_approval_state='approved'`. This reads the share record; it does NOT change `pendingApprovals` compute (CLAUDE.md memory — keep that O(1) path at `runtime-views.ts:1731-1733` untouched).
4. The publish itself remains the existing operator approval action — the client gate is a precondition surfaced in the UI, enforced server-side in the publish handler only when the (default-OFF) flag is on AND a policy opts in. Default behavior unchanged.

**Acceptance (this is the user-visible success bar):** in Brendan's operator dashboard, the operator can click "Share with client," see and copy a `https://aries.sugarandleather.com/preview/<token>` link, watch a client comment + "Approved" state appear in the job view, and see the publish action gated by the client-approval banner — all rendered in the dashboard UI (not DB/state/mock).

### F — Flag + docs + ROUTE_MANIFEST + live E2E + ship (Medium, 3h)

**Implementation:**
1. `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED` (default OFF). Accept `1|true|yes|on` (match `isVideoPublishEnabled` precedent, `backend/marketing/synthesize-publish-posts.ts:115`). Document in `CLAUDE.md` "Environment Variables", add `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED=0` to `.env.example` (matching the `ARIES_VIDEO_PUBLISH_ENABLED=0` style), and add it to `docker-compose.yml` using the existing interpolation convention: `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED: ${ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED:-0}` (matches `ARIES_VIDEO_PUBLISH_ENABLED: ${ARIES_VIDEO_PUBLISH_ENABLED:-0}` at `docker-compose.yml:74`).
2. `ROUTE_MANIFEST.md`: add `/preview/:shareToken` (public, tokenized client campaign preview) and the three `/api/preview/:shareToken/*` write endpoints + `/api/marketing/jobs/:jobId/preview-share`, matching the existing table layout (`/public-:brandSlug/campaign` row + the `/api/marketing/jobs/:jobId/*` rows).
3. Live E2E on tenant 15: mint a share, open it in an incognito/headless browser (`/browse`), enter the password, add a comment, click approve, confirm the operator dashboard reflects the comment + approved state and the publish banner gates. Verify the URL is `aries.sugarandleather.com`, never bare.
4. `/ship-triage-deploy`; bump `VERSION` (minor — new tables + routes) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ `/preview/*` and mint endpoint 404, operator share button hidden, zero behavior change; flag ON ⇒ full client loop renders end-to-end in the dashboard + public surface; `full-suite` gate green.

## Feature flag

`ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED=1` — rollout switch for the shareable client campaign preview system. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF: the operator mint endpoint (`/api/marketing/jobs/:jobId/preview-share`), the public `/preview/:shareToken` route, and the three public write endpoints all return a branded 404; the operator "Share with client" affordance is hidden; the client-approval publish precondition is not enforced. Schema (`campaign_preview_shares`, `campaign_preview_comments`) and token plumbing ship inert. When ON, operators can mint expiring, optionally password-protected, revocable read-only client preview links; clients comment and record a single approval decision; **the public surface can never trigger a publish** — the client decision is a gate surfaced to the operator, who still performs the approval-gated publish. Process-wide (affects all tenants in this container). Leave OFF until the operator UI (Phase E) and live E2E (Phase F) are verified on tenant 15.

## Data / contract changes

- **New tables:** `campaign_preview_shares`, `campaign_preview_comments` (migration `20260601120000_campaign_preview_shares.sql` + mirrored in `scripts/init-db.js`). Additive + idempotent (`CREATE TABLE IF NOT EXISTS`).
- **No changes** to `posts`, `scheduled_posts`, `creative_assets`, `MarketingApprovalRecord`, or the `pendingApprovals` denormalized count. The client gate reads existing artifacts; it does not mutate them.
- **New token contract:** raw share token (URL-safe base64, 32 random bytes) is shown to the operator once and never persisted; only `sha256(token)` is stored (mirrors the `oauth_callback_tokens.token_hash CHAR(64)` precedent). Password stored as `scrypt(salt$hash)`, compared timing-safe.
- **Share URL contract:** always `\`${metadataSiteOrigin()}/preview/<token>\``, defaulting to `https://aries.sugarandleather.com`.

## Testing + verify

| Layer | What | Count |
|-------|------|-------|
| Unit | token gen/hash round-trip; `resolveShareByToken` null on expired/revoked/unknown | +3 |
| Unit | scrypt password hash/verify: correct / wrong / absent; timing-safe path | +3 |
| Unit | mint idempotency (reuse active share unless `rotate`); expiry clamp (default 7, max 30) | +2 |
| Unit | view-model sectioning: approved-vs-draft badge derivation from `published_status` | +2 |
| Integration (route) | mint requires auth + correct tenant; cross-tenant job 404; flag OFF ⇒ 404 | +3 |
| Integration (route) | `/preview/<token>` valid/expired/revoked/unknown branded states; password prompt path | +4 |
| Integration (route) | unlock wrong/right; comment insert + idempotency replay no-op; decision write-once | +4 |
| Integration | public action never publishes (decision flips gate only; no publish side-effect) | +1 |
| Live-DB | tenant-scoped share + comment insert against real DB (precedent: `tests/marketing/ingest-production-assets-live-db.test.ts`) | +1 |
| E2E (live, manual) | tenant 15: mint → open incognito → password → comment → approve → operator dashboard reflects state + publish banner gates; URL is `aries.sugarandleather.com` | manual |

**~23 automated + 1 manual.** New test files allowlisted in `scripts/verify-regression-suite.mjs` (explicit per-file `args: ['--test', 'tests/...']` entries). All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify`, then `npm run test:concurrent` before ship (touches new routes + backend + schema). Run `npm run guardrails:agent` before opening the PR (parallel-worktree guard). Full CI-exact `full-suite` must be green before push.

## Rollout

- **Schema:** additive + idempotent; reverse with `DROP TABLE campaign_preview_comments; DROP TABLE campaign_preview_shares;` — no impact on existing campaign data.
- **Flag:** `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED=0` is the instant kill switch — public route + mint endpoint 404, operator affordance hidden.
- **Revocation:** an operator can revoke any individual share (`revoked_at`) without a deploy; expired shares are dead automatically (`expires_at`).
- **Sequence:** land A–D dark (flag OFF, schema live, routes 404). Land E (UI behind the same flag). Flip `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED=1` on tenant-15 container only after F's live E2E passes. Confirm with Brendan before flipping in prod.

## Out of scope

- **Replacing the existing `public-<slug>/campaign` static landing-page server** (`backend/marketing/public-pages.ts`) — left exactly as-is; the preview is a separate tokenized surface.
- **Multi-recipient / per-recipient links, named client accounts, or client login** — v1 is a single shared token (optionally password-gated). Per-recipient tracking is a follow-up.
- **Threaded comment replies, operator-from-public replies, comment resolution workflow** — v1 collects flat comments; operator reads them.
- **Email delivery of the share link** (`RESEND_API_KEY` path) — operator copies the URL manually in v1.
- **Team-roles / approval-policy modeling** (roadmap [14]) — the client gate is surfaced as a precondition; formal "client must approve" policy config is its own epic. v1 enforces the gate only when the flag is on and a coarse policy opts in.
- **Autonomous publish on client approval** — explicitly never; client approval is a gate, the operator publishes.
- **Analytics on link opens / view counts** — no tracking pixel in v1.

## Risks

1. **Token leakage / brute force.** Mitigated by 32-byte tokens (un-guessable), DB lookup by `sha256(token)`, generic 404 on any miss (`lib/signed-media-token.ts:58-60` "never learn why" precedent), optional password, expiry, and revocation. Rate-limit unlock + comment per token_hash. **Never** use the guessable `public-<slug>` path for the preview.
2. **Cross-tenant leakage** (CLAUDE.md #1 / tenant isolation). All share writes derive `tenant_id` from the resolved share record, never from the request body; the view-model queries are tenant-scoped. Add a test asserting a share for tenant A cannot read tenant B's posts.
3. **Accidental autonomous publish.** The decision endpoint only flips `client_approval_state`; it has no path to `publishToMetaGraph`. Assert this in a test. Guardrail: nothing publishes without operator action; `MARKETING_STATUS_PUBLIC=1` is never exposed in `docker-compose.yml` (confirmed: it appears only in SETUP.md/docs/tests today).
4. **Bare brand URL regression.** All link construction routes through `metadataSiteOrigin()`. Add a test asserting the minted `shareUrl` host is the configured origin and never bare `sugarandleather.com` (CLAUDE.md memory: the leather-goods site is the wrong site).
5. **Coupling to the fragile `pendingApprovals` compute.** The client-approval precondition reads the share record independently; it must NOT be folded into `loadStagePayloadBundle` / the O(1) count path at `runtime-views.ts:1731-1733` (CLAUDE.md memory — three prior build attempts proved that coupling is infeasible).
6. **Password UX dead-ends.** Operator sees the password once at mint; if lost, they rotate (`rotate=true`) rather than recover — documented in the share panel copy.
7. **Treat-as-production.** Validate Phase F against the live DB on tenant 15; mock/state passing does not count as done — only rendered UI in the operator dashboard + the public preview surface counts (CLAUDE.md memory: user-visible completion = rendered UI only).

## Files reference

| File | Change | Phase |
|------|--------|-------|
| `migrations/20260601120000_campaign_preview_shares.sql` | NEW: `campaign_preview_shares` + `campaign_preview_comments` | A |
| `scripts/init-db.js` (alongside `marketing_operator_creative_preferences` / `honcho_write_idempotency_keys`, ~line 535+) | mirror both tables for fresh installs | A |
| `backend/marketing/preview-share-store.ts` | NEW: token gen/hash, scrypt password, CRUD, timing-safe verify | A |
| `app/api/marketing/jobs/[jobId]/preview-share/route.ts` | NEW: mint / list / revoke (operator, tenant-scoped, flag-gated) | B |
| `app/preview/[shareToken]/route.ts` | NEW: public sectioned render, password prompt, expired/404 branded states | C |
| `backend/marketing/preview-view-model.ts` | NEW: `buildClientPreviewViewModel` reusing dashboard projection + public-pages render | C |
| `app/api/preview/[shareToken]/unlock/route.ts` | NEW: password unlock → signed cookie, rate-limited | D |
| `app/api/preview/[shareToken]/comments/route.ts` | NEW: add comment, idempotent | D |
| `app/api/preview/[shareToken]/decision/route.ts` | NEW: client approve / changes_requested, write-once | D |
| `frontend/aries-v1/results-screen.tsx` / `review-item.tsx` / `review-queue.tsx` | "Share with client" panel + comments + client-approval banner | E |
| `backend/marketing/runtime-views.ts` | surface `client_approval_state` as publish precondition (no `pendingApprovals` change) | E |
| `ROUTE_MANIFEST.md` | add `/preview/:shareToken` + `/api/preview/*` + mint endpoint | F |
| `.env.example`, `docker-compose.yml`, `CLAUDE.md` | document `ARIES_CAMPAIGN_PREVIEW_SHARE_ENABLED` | F |
| `tests/preview-share-store.test.ts` | NEW: token/password/expiry/revoke unit | A |
| `tests/preview-share-routes.test.ts` | NEW: mint/list/revoke + auth/tenant/flag | B |
| `tests/preview-public-route.test.ts` | NEW: render states + password prompt + view-model sectioning | C |
| `tests/preview-public-writes.test.ts` | NEW: unlock/comment/decision idempotency + no-publish invariant | D |
| `scripts/verify-regression-suite.mjs`, `VERSION`, `CHANGELOG.md` | allowlist new tests + bump | F |

## Related

- `backend/marketing/public-pages.ts` / `app/[...publicPath]/route.ts` — the existing static `public-<slug>/campaign` server this builds beside (not on top of).
- `lib/signed-media-token.ts` — HMAC token + URL-safe base64 + "never learn why" precedent reused for the share token.
- `app/api/marketing/reviews/[reviewId]/decision/route.ts` + `backend/marketing/runtime-views.ts` (`recordMarketingReviewDecision`) + `backend/marketing/approval-store.ts` — the operator approval path the client gate feeds into as a precondition.
- `docs/plans/2026-05-30-story-reel-video-publishing.md` — sibling roadmap epic [8]; both ship behind a default-OFF `ARIES_*_ENABLED` flag and honor the same guardrails (tenant-scoping, no autonomous publish, brand URL).
- CLAUDE.md guardrails honored: treat-as-production (live E2E on tenant 15, rendered-UI completion bar), brand URL `aries.sugarandleather.com` via `metadataSiteOrigin()`, default-OFF flag, approval-gated (client gate never auto-publishes), `MARKETING_STATUS_PUBLIC=1` never exposed, `pendingApprovals` O(1) path untouched.
