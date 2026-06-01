# Public Trust Center + Known-Limitations page

> Status: draft plan (2026-06-01). M feature (mostly content + two static marketing pages). Covers roadmap area **13** (public trust center) and area **1d** (public "known limitations" page) in one plan. Every fact rendered already exists in `docs/SECURITY_MODEL.md` / `docs/SELF_HOSTING.md` / `docs/COMMERCIAL.md` — this plan **renders** those facts as public marketing pages; it does **not** add or change any security behavior.

## Context

Aries already has a hardened, documented security posture: next-auth v5 sessions signed with `NEXTAUTH_SECRET`, two-layer tenant authorization (`loadTenantContextForUser`), Aries-brokered OAuth tokens encrypted at rest with `OAUTH_TOKEN_ENCRYPTION_KEY`, a dual-layer Hermes callback boundary (`INTERNAL_API_SECRET` bearer + per-run SHA-256 callback token, both constant-time), a secret-rotation table, and an approval-gated publish pipeline where nothing reaches a platform without a human click. All of this is written down in `docs/SECURITY_MODEL.md` and `docs/COMMERCIAL.md`. **None of it is visible to a prospective customer or self-hoster** — there is no public page that says "here is how Aries keeps your accounts safe and what it deliberately does not do on its own."

Separately, the public site over-promises by omission: it does not say Aries depends on a non-open-source Hermes gateway, that OAuth providers must be registered per-channel before publishing works, that the only live publishing surface today is single-image feed posts (+ FB text) plus auto-composed image Stories, or that video/Reels/video-Stories ship gated OFF behind `ARIES_VIDEO_PUBLISH_ENABLED`. A prospect discovers these constraints only after signing up — exactly the public-trust blocker roadmap area 1d names.

This plan adds two static marketing pages built from the **existing** `MarketingLayout` shell:
1. `/trust` — a public **Trust Center** rendering the nine security topics already documented (auth model, tenant isolation, OAuth token encryption, approval-gated publishing, internal callback security, secret rotation, data deletion/export, security reporting, and "what Aries does NOT do automatically").
2. `/limitations` — a public **Known Limitations** page (Hermes dependency, OAuth setup burden, current publishing surfaces, what is not yet live).

Framing, consistent with the homepage's existing line ("Nothing goes live without your approval" — `frontend/donor/marketing/home-page.tsx:664`): **safety-first; nothing goes live without approval; every publish is traceable.**

This is **content + two static pages + nav/footer/sitemap/manifest wiring**, not a behavioral change. There is no DB schema change, no API route, no runtime branch. The single behavioral seam — whether the two pages and their nav/footer links are *rendered live in production* — is gated behind a default-OFF flag `ARIES_TRUST_CENTER_ENABLED` so the copy can land, be reviewed, and be QA'd before it is publicly linked.

## Who cares

- **Prospects / the buying decision** — "is it safe to connect my Instagram?" is the first objection. A public Trust Center that says *we encrypt your tokens, we never publish without your approval, here is exactly what we do and don't automate* is the single highest-leverage trust artifact, and every fact is already true and documented.
- **Self-hosters** — the Known Limitations page is the honest precondition list (you need a Hermes gateway, you must register OAuth apps, only feed image posts + image Stories are live today) that prevents a frustrated "why doesn't publishing work" support thread.
- **Security researchers** — a public, linkable `security@sugarandleather.com` + "don't open a public issue" disclosure path (already in `SECURITY_MODEL.md:82-84`) belongs on a public page, not buried in a repo doc.
- **Brendan / @sugarandleather** — "safety-first, nothing goes live without approval, every publish is traceable" is the product's actual positioning; these pages make the public site match the product.

## Decisions (locked — do not re-litigate)

1. **Render, don't restate.** Every claim on `/trust` and `/limitations` must be backed by an existing line in `docs/SECURITY_MODEL.md`, `docs/SELF_HOSTING.md`, or `docs/COMMERCIAL.md`. No page may assert a security property that is not already true and documented. If a fact isn't in those docs, it does not go on the page.
2. **Reuse the existing static-marketing-page pattern.** Both pages are server components that render `<MarketingLayout>{...}</MarketingLayout>` with const-array content blocks and `glass` cards — identical to `app/privacy/page.tsx`, `app/api-docs/page.tsx`, `app/sitemap/page.tsx`. No new layout, no client component, no new CSS file.
3. **Brand URL is `aries.sugarandleather.com`.** Any product URL on these pages is `aries.sugarandleather.com` (per memory: NEVER bare `sugarandleather.com`, which is the leather-goods site). Email addresses (`security@`, `support@`, `hello@`) keep their existing `@sugarandleather.com` form — those are the real, documented contacts in `SECURITY_MODEL.md` / `COMMERCIAL.md` and are not the product URL.
4. **No secret values, no internal paths on the page.** The page describes *that* `OAUTH_TOKEN_ENCRYPTION_KEY` encrypts tokens at rest; it never prints a key, an env-file path, an internal route, or a table name. Public-facing language only (the docs already model this — mirror their altitude, not their file references).
5. **Flag gates link visibility + sitemap routing, default OFF.** `ARIES_TRUST_CENTER_ENABLED` (default OFF). When OFF: the page files exist and tests pass, but nav/footer/`sitemap.ts`/human-sitemap do not link to them and the routes are not advertised. When ON: nav + footer + `app/sitemap.ts` + `app/sitemap/page.tsx` surface `/trust` and `/limitations`. This lets the content land + get reviewed before it is publicly discoverable. (The pages themselves are harmless static content; the flag governs *promotion*, the conservative default.) **`app/robots.ts` needs no change**: it uses a global `allow: '/'` rule and does not enumerate per-route allows, so `/trust` and `/limitations` are already crawlable when linked — robots.ts is intentionally absent from the touch-list.
6. **"What Aries does NOT do automatically" is a first-class section, not a footnote.** It is the trust differentiator: no autonomous publishing, AI never approves its own output, no cross-tenant data access, no token printed back to the browser, no Meta-side scheduling beyond the worker. These map to existing PRD invariants (`tests/prd-invariants/inv-07/08/09/11/12`).
7. **No `MARKETING_STATUS_PUBLIC=1` exposure.** These pages are pure marketing copy; they must not read runtime marketing state, must not import `backend/marketing/*`, and must not depend on `MARKETING_STATUS_PUBLIC`. (Guardrail: never expose `MARKETING_STATUS_PUBLIC=1` in prod.)

## Current State (VERIFIED — branch @ fix/story-composer-serving)

**Documented-but-unrendered security facts — `docs/SECURITY_MODEL.md`:**
- Auth: next-auth v5, `NEXTAUTH_SECRET`-signed sessions, HttpOnly origin-scoped cookie, generic error to avoid user enumeration, bcrypt password hashes (lines 3-12).
- Tenant isolation: two-layer check (session middleware + `loadTenantContextForUser` membership lookup in `organizations`), parameterized queries on resolved `tenantId`, never trusts client-supplied tenant id; roles `tenant_admin` / `tenant_analyst` / `tenant_viewer` (lines 14-30).
- Internal callback auth: `INTERNAL_API_SECRET` bearer (constant-time) + per-run SHA-256 callback token against `execution_runs`; `HERMES_API_SERVER_KEY` (outbound) vs `INTERNAL_API_SECRET` (inbound) intentionally separate (lines 31-46).
- OAuth token security: LinkedIn/X/YouTube/TikTok/Reddit tokens encrypted at rest via `OAUTH_TOKEN_ENCRYPTION_KEY` (32-byte base64); Meta tokens env-managed, not in DB; rotation invalidates stored tokens → reconnect (lines 48-54).
- Publishing authorization: `POST /api/publish/dispatch` requires authenticated operator session + valid tenant context (lines 56-58).
- API trust boundary: `app/api/*` validates bodies, resolves tenant server-side, returns typed safe shapes, never leaks rows/paths/state; `app/api/internal/*` not browser-facing (lines 60-68).
- Secret rotation table: 5 secrets with rotation side-effects (lines 70-81).
- Security reporting: `security@sugarandleather.com` / private GitHub advisory; do not open a public issue (lines 82-84).

**Commercial / self-host facts — `docs/COMMERCIAL.md` + `docs/SELF_HOSTING.md`:**
- Hermes is NOT open-source; this repo is the client adapter only; managed hosting at `aries.sugarandleather.com` (COMMERCIAL.md:18-21).
- Self-host requires: own Postgres, Hermes gateway (contact S&L), per-channel OAuth app registrations, transactional email provider (COMMERCIAL.md:27-32; OAuth callback URLs enumerated SELF_HOSTING.md:101-109).
- Apache 2.0 license; trademark caveat (COMMERCIAL.md:5, 45-47).

**Current publishing surface (what's live vs gated) — for the Limitations page:**
- Live today: single-image (or carousel) **feed** post on Instagram; image/carousel/text **feed** post on Facebook.
- Image **Stories** auto-compose from `scope.story_count` (shipped #523/#524/#525; `backend/marketing/story-composer.ts`) — autonomous, no flag, falls back to raw creative if composer absent.
- Video / Reels / video-Stories: code shipped (#520) but **gated OFF** behind `ARIES_VIDEO_PUBLISH_ENABLED` (default OFF) — when OFF, video/reel entries are stripped at synthesis (`backend/marketing/synthesize-publish-posts.ts:488`).
- Publish failure taxonomy + reconnect signal: shipped (#519) — `auth` failures surface "reconnect your account."
- No story/post insights (no `read_insights` / `instagram_manage_insights` granted) — analytics blocked pending scopes (per memory `project-meta-insights-scopes-missing`).

**Existing static-marketing-page pattern (the template to copy):**
- `app/privacy/page.tsx` — server component (no `'use client'`), `export const metadata`, const `PRINCIPLES` array, `<MarketingLayout>` + `glass` cards. ~48 lines. Contains the `support@sugarandleather.com` export/deletion line to mirror.
- `app/api-docs/page.tsx` — same shell, const `ENDPOINTS` array, `data-testid` markers, `text-gradient` accent. 141 lines.
- `app/sitemap/page.tsx` — same shell, const `ROUTE_GROUPS` with a `Legal` group.

**Marketing shell composition (the server/client boundary — VERIFIED):**
- `frontend/marketing/MarketingLayout.tsx` re-exports `MarketingShell as default` and the `MarketingShellProps as MarketingLayoutProps` type from `components/redesign/layout/marketing-shell.tsx`.
- `components/redesign/layout/marketing-shell.tsx` — **server component** (no `'use client'`); `MarketingShell({ children })` currently renders `<DonorMarketingShell>{children}</DonorMarketingShell>`. `MarketingShellProps` is `{ children; currentPath? }` — **no flag prop today**. **This is the real server/client boundary** and the correct place to read the flag.
- `frontend/donor/marketing/chrome.tsx` — `'use client'` (line 1). Exports `DonorMarketingShell`, `DonorNavbar`, `DonorFooter`. Because the whole file is a client component, **it cannot read `process.env` server-side**; the flag must be evaluated in `marketing-shell.tsx` and threaded down as a prop.

**Nav / footer / discovery surfaces (to wire when flag ON):**
- `frontend/donor/marketing/chrome.tsx`: `NAV_ITEMS` (lines 18-22: How it works / Features / Documentation); `DonorFooter` (line 177) has a "Product" column (lines 196-204) and a bottom legal row (lines 227-233: Terms / Privacy / Sitemap). `DonorMarketingShellProps` (lines 13-16) is `{ children; heroMode? }`.
- `app/sitemap.ts` (route sitemap): `PUBLIC_ROUTES` array (lines 5-18) — add `/trust`, `/limitations` when ON.
- `app/sitemap/page.tsx` (human sitemap): `ROUTE_GROUPS` (has a `Legal` group, lines 38-44) — add `/trust`, `/limitations` when ON.
- `ROUTE_MANIFEST.md`: `## Public routes` table (lines 5-13) — add both routes.

**Existing test harness (the test to extend):**
- `tests/public-marketing-pages.test.ts` — renders each page component, asserts `isValidElement`, asserts `.type === MarketingLayout`, and greps the source files for stable content markers + forbidden strings (`assert.doesNotMatch`). Uses `withReactGlobal` + `collectText`, and calls `DonorMarketingShell({ children: null })` directly as a function (line 82) — so a new `showTrust` prop is drivable from this harness. This is the exact pattern for the new pages.
- `scripts/verify-regression-suite.mjs` — the fast suite. **VERIFIED: `public-marketing-pages.test.ts` is NOT currently a step in this suite** (the closest existing step is `tests/social-content-public-copy.test.ts`). The new tests must therefore be added as an explicit new step; there is no existing marketing-pages step to "piggyback" on.

## Architecture (page composition — no runtime data flow)

```
Browser → GET /trust  (static server component)
  app/trust/page.tsx
    export const metadata = { title: 'Trust Center — Aries AI' }
    <MarketingLayout>
      9 const-array content blocks (glass cards):
        auth · tenant isolation · token encryption · approval-gated publishing ·
        internal callback security · secret rotation · data deletion/export ·
        security reporting · "what Aries does NOT do automatically"
    </MarketingLayout>
  ← every claim traceable to docs/SECURITY_MODEL.md (no runtime read, no backend import)

Browser → GET /limitations  (static server component)
  app/limitations/page.tsx
    <MarketingLayout>
      4 const-array content blocks:
        Hermes dependency · OAuth setup · current publishing surfaces · not-yet-live
    </MarketingLayout>
  ← claims traceable to COMMERCIAL.md / SELF_HOSTING.md + shipped-surface facts

Discovery (ONLY when ARIES_TRUST_CENTER_ENABLED is ON):
  marketing-shell.tsx          reads isTrustCenterEnabled() (SERVER component) and
                               passes showTrust down → DonorMarketingShell → navbar/footer
  chrome.tsx NAV_ITEMS / footer render the /trust + /limitations links iff showTrust
  app/sitemap.ts PUBLIC_ROUTES +→ '/trust', '/limitations'
  app/sitemap/page.tsx         +→ 'Trust & limitations' group
  ROUTE_MANIFEST.md            +→ two Public-routes rows
```

**Flag-threading (corrected — the boundary is `MarketingShell`, NOT `DonorMarketingShell`):**
A single tiny server helper `lib/public-flags.ts → isTrustCenterEnabled()` (mirrors the parse used by `isHonchoWritePublishEnabled` in `backend/memory/honcho-env.ts:24`). The flag is read in `components/redesign/layout/marketing-shell.tsx` — the **server** component that wraps every marketing page — and passed as a `showTrust` boolean into `DonorMarketingShell` (in the `'use client'` `chrome.tsx`), which threads it to `DonorNavbar` + `DonorFooter`. The nav/footer link list renders the `/trust` + `/limitations` entries only when `showTrust` is true. Reading the flag in a client component is impossible (`process.env` is undefined in the browser), so `chrome.tsx` must receive the value as a prop — it must never call `isTrustCenterEnabled()` itself. The pages themselves stay always-reachable by direct URL; the flag governs only *promotion* (nav/footer/sitemap linking).

## Phases

| # | Phase | Ships | Depends on |
|---|-------|-------|-----------|
| 1 | `/trust` Trust Center page (content + render test) | A reviewable public page reachable by direct URL | none |
| 2 | `/limitations` Known Limitations page (content + render test) | A reviewable public page reachable by direct URL | none |
| 3 | Flag-gated promotion: shell prop + nav + footer + sitemap + manifest | Pages become *discoverable* in prod when flag ON | 1, 2 |
| 4 | Flag default-OFF wiring, docs, live QA, ship | Flag documented; live render verified; gate green | 1, 2, 3 |

Phases 1 and 2 are independent and may land in either order or together. Phase 3 depends on both pages existing. Phase 4 is the ship gate.

---

### Phase 1 — `/trust` Trust Center page (single shippable increment)

**New file: `app/trust/page.tsx`** (server component, models `app/api-docs/page.tsx`):
- `export const metadata = { title: 'Trust Center — Aries AI', description: 'How Aries keeps your accounts safe: encrypted tokens, tenant isolation, and approval-gated publishing. Nothing goes live without your approval.' }`.
- Hero block: `glass` card, `text-xs uppercase tracking-[0.3em] text-primary` eyebrow "Trust & security", `<h1>` "Built so nothing goes live without your approval", subhead carrying the **safety-first / nothing goes live without approval / every publish is traceable** framing.
- Nine const-array content blocks, each a `glass rounded-[2rem]` card with `data-testid="trust-section"` + `data-topic="<slug>"` (stable markers for the test):
  1. **Authentication** — next-auth v5; sessions signed with a server secret; HttpOnly origin-scoped cookies; passwords bcrypt-hashed; identical generic errors to prevent account enumeration. (← SECURITY_MODEL.md:3-12)
  2. **Tenant isolation** — every request passes a session check then a database membership check; all data queries are scoped to *your* resolved tenant; we never trust a tenant id supplied by the browser; roles admin / analyst / viewer. (← :14-30)
  3. **Token encryption at rest** — connected social tokens are encrypted at rest with a dedicated 32-byte key; Meta tokens are environment-managed, never stored in the app database; rotating the key forces reconnect (no stale token survives). (← :48-54)
  4. **Approval-gated publishing** — AI generates drafts; a human approves before anything dispatches; the publish route requires an authenticated operator with access to the owning tenant. (← :56-58 + inv-07/inv-09)
  5. **Internal callback security** — workflow callbacks are protected by *two* independent checks (a shared bearer secret + a per-run token), both compared in constant time; even a leaked bearer secret cannot forge a callback for another run; inbound and outbound secrets are deliberately separate. (← :31-46)
  6. **Secret rotation** — documented rotation procedure with explicit side-effects per secret (rotating the session secret signs everyone out; rotating the token key forces reconnects). (← :70-81)
  7. **Data deletion & export** — your content stays tied to your account; request export or deletion by emailing `support@sugarandleather.com`. (← `app/privacy/page.tsx` deletion/export line — keep wording identical to the privacy page's existing offer)
  8. **Reporting a vulnerability** — email `security@sugarandleather.com` or open a private GitHub security advisory; please do not open a public issue. (← :82-84)
  9. **What Aries does NOT do automatically** — no autonomous publishing (every post needs a human click); AI never approves its own output; no cross-tenant data access; your tokens are never sent back to the browser; no silent platform-side scheduling beyond your reviewed plan. (← inv-07/08/09/11/12 + SECURITY_MODEL boundary)
- Closing CTA card: "Read the full security model" → link to the repo `docs/SECURITY_MODEL.md` on GitHub (or `/documentation`), and "Start with your business" → `/onboarding/start` (matches the established CTA on every marketing page).

**Hard constraints:** no import from `backend/*`; no `MARKETING_STATUS_PUBLIC`; no secret values; product URL `aries.sugarandleather.com` only.

**New test: `tests/trust-center-page.test.ts`** (models `tests/public-marketing-pages.test.ts`):
- Renders `TrustPage()`, asserts `isValidElement` and `.type === MarketingLayout`.
- `collectText` over children, assert presence of each of the nine topic headings and the framing line ("Nothing goes live without your approval").
- Source-grep guards: `assert.doesNotMatch(source, /sugarandleather\.com(?!\/)/)` style check that any **product** URL is `aries.sugarandleather.com` (allow the `@sugarandleather.com` email and the GitHub/docs links); `assert.doesNotMatch(source, /MARKETING_STATUS_PUBLIC/)`; `assert.doesNotMatch(source, /from ['"]@?\/?backend/)` (no backend import); assert no literal secret-value patterns.
- Assert `/onboarding/start` CTA present.

**Acceptance:** `/trust` renders the nine cards via `<MarketingLayout>`, every claim maps to a `docs/SECURITY_MODEL.md` line, and `tsx --test tests/trust-center-page.test.ts` passes with `APP_BASE_URL=https://aries.example.com`.

---

### Phase 2 — `/limitations` Known Limitations page (single shippable increment)

**New file: `app/limitations/page.tsx`** (server component, models `app/privacy/page.tsx`):
- `export const metadata = { title: 'Known Limitations — Aries AI', description: 'What Aries depends on, what setup it needs, and what is not yet live. Honest constraints, safety-first.' }`.
- Hero block carrying the same framing: "Aries is safety-first. Here is exactly what it depends on and what is not yet live."
- Four const-array content blocks (`data-testid="limitation-section"` + `data-topic`):
  1. **Depends on the Hermes workflow engine** — Aries delegates AI execution to a Hermes gateway, which is a separate, non-open-source service operated by Sugar & Leather; self-hosting requires access to a Hermes gateway. (← COMMERCIAL.md:18-20, 27-32)
  2. **OAuth setup is required before publishing** — each channel (Meta/Instagram, LinkedIn, X, YouTube, TikTok, Reddit, Google) must be connected with its own OAuth app registration and callback URL; until a channel is connected, posts to it cannot publish; an expired token surfaces a "reconnect your account" prompt, not a silent failure. (← SELF_HOSTING.md:101-109 OAuth callbacks + #519 reconnect taxonomy)
  3. **Current publishing surfaces** — live today: single-image (and carousel) **feed** posts on Instagram and Facebook, plus text posts on Facebook, and auto-composed image **Stories**. Video, Reels, and video Stories are built but **off by default** while we finish quality work; performance **insights** are not yet available because the required read permissions are not yet granted. (← shipped-surface recon: #520 gated OFF, #523/#524/#525 image stories live, `project-meta-insights-scopes-missing`)
  4. **What is not yet live** — autonomous publishing is intentionally not offered; analytics/insights dashboards are pending platform permissions; non-Meta channels are connect-and-draft, with publishing rolling out behind reliability work first. Framing close: "We ship reliability and reconnect UX before new surfaces, on purpose." (← roadmap "WHAT NOT TO PRIORITIZE")
- Cross-link card: "How we keep you safe" → `/trust`; "Set up your business" → `/onboarding/start`.

**Hard constraints:** identical to Phase 1 (no backend import, no `MARKETING_STATUS_PUBLIC`, brand URL discipline). The page must state video/Reels are "off by default" **without** naming the env var inline in user copy (keep `ARIES_VIDEO_PUBLISH_ENABLED` out of the public sentence — describe behavior, not the flag).

**New test: `tests/limitations-page.test.ts`** (models the Phase 1 test):
- Render + `.type === MarketingLayout` + four topic headings present.
- Assert the page does **not** over-promise: `assert.doesNotMatch(text, /fully autonomous/i)`, `assert.doesNotMatch(text, /publishes? automatically/i)`; assert it **does** carry the Hermes-dependency and reconnect framing.
- Brand-URL + no-backend-import + no-`MARKETING_STATUS_PUBLIC` source guards.

**Acceptance:** `/limitations` renders four honest constraint cards; the over-promise guards pass; `tsx --test tests/limitations-page.test.ts` green.

---

### Phase 3 — Flag-gated promotion (shell prop + nav + footer + sitemap + manifest)

**New file: `lib/public-flags.ts`**
```ts
export function isTrustCenterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ARIES_TRUST_CENTER_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
```
(Mirrors the `env`-defaulted flag-parse convention used by `isHonchoWritePublishEnabled` in `backend/memory/honcho-env.ts:24`. The `1|true|yes|on` token set matches `isVideoPublishEnabled` in `backend/marketing/synthesize-publish-posts.ts:115`.)

**Edits (link rendering all conditional on the threaded `showTrust` boolean):**

1. **`components/redesign/layout/marketing-shell.tsx`** (SERVER component — the real boundary) — read the flag and thread it down:
   - Add `showTrust?: boolean` to `MarketingShellProps` (kept optional so existing callers compile unchanged).
   - In `MarketingShell`, default `showTrust` to `isTrustCenterEnabled()` (server-evaluated) when not explicitly passed, and render `<DonorMarketingShell showTrust={showTrust}>`.
   - This is the only place that calls `isTrustCenterEnabled()`. Reading the flag here (a server component) is correct; reading it in `chrome.tsx` (a client component) is impossible.

2. **`frontend/marketing/MarketingLayout.tsx`** — the re-export of `MarketingShellProps as MarketingLayoutProps` automatically carries the new optional `showTrust` field; no value change needed, but **verify the type still compiles** after the `MarketingShellProps` edit (this file is a pure re-export; listed so it is not forgotten in review).

3. **`frontend/donor/marketing/chrome.tsx`** (`'use client'`) — accept and apply the prop; **never** read `process.env` here:
   - `DonorMarketingShellProps` gains `showTrust?: boolean`; `DonorMarketingShell` passes it to `DonorNavbar` + `DonorFooter`.
   - `DonorNavbar` + `DonorFooter` gain a `showTrust?: boolean` param.
   - When `showTrust` is true: nav renders an extra `{ name: 'Trust', href: '/trust' }` item (after Documentation); `DonorFooter` "Product" column gains `<li><a href="/trust">Trust center</a></li>` and `<li><a href="/limitations">Known limitations</a></li>`; the bottom legal row optionally gains a "Security" link to `/trust`. Apply the same `showTrust` gate to the mobile-menu `NAV_ITEMS` map so the link is consistent across breakpoints.
   - When `showTrust` is false (default): none of these render; the pages are reachable only by direct URL (Phase 1/2 behavior preserved).
   - Per CLAUDE.md memory "Widening union → grep inequalities" does not apply (no union widened), but **grep `chrome.tsx` for `/trust` and `/limitations` after editing** to confirm no duplicate insertion on a re-run.

4. **`app/sitemap.ts`** — when flag ON, append `'/trust'`, `'/limitations'` to `PUBLIC_ROUTES`. Read the flag at handler scope via `isTrustCenterEnabled()` (this is a server module).

5. **`app/sitemap/page.tsx`** — when flag ON (`isTrustCenterEnabled()`), add a `Trust & limitations` group (`/trust`, `/limitations`) to `ROUTE_GROUPS`; when OFF, omit it.

6. **`ROUTE_MANIFEST.md`** — add two rows to the `## Public routes` table (lines 5-13):
   - `| /trust | Marketing site | Public trust center: auth, tenant isolation, token encryption, approval-gated publishing, callback security, rotation, deletion/export, reporting |`
   - `| /limitations | Marketing site | Public known-limitations page: Hermes dependency, OAuth setup, current publishing surfaces, not-yet-live |`
   - (The manifest documents the route contract regardless of flag; the flag only governs *linking*, not existence.)

**Acceptance (flag matrix, tested):**
- Flag **OFF**: `DonorMarketingShell`/`DonorNavbar`/`DonorFooter` rendered with `showTrust=false` contain no `/trust` or `/limitations` href; `app/sitemap.ts` output excludes both; `app/sitemap/page.tsx` has no Trust group. Pages still render by direct URL.
- Flag **ON**: nav contains a `Trust` item; footer contains both links; `sitemap.ts` includes both routes; human sitemap shows the group.

**New test: `tests/trust-center-flag.test.ts`** — drive `isTrustCenterEnabled()` truthy/falsy across `1`/`true`/`on`/`yes`/`0`/unset; render `DonorNavbar`/`DonorFooter`/`DonorMarketingShell` with explicit `showTrust` true/false and assert link presence/absence (the harness calls these as plain functions, as `public-marketing-pages.test.ts` already does at line 82); separately render `MarketingShell` with `ARIES_TRUST_CENTER_ENABLED` set/unset to confirm the server-side default wires through. Reset `process.env.ARIES_TRUST_CENTER_ENABLED` in a `finally`.

---

### Phase 4 — Flag default-OFF wiring, docs, live QA, ship

**Implementation:**
1. **Document the flag** in `CLAUDE.md` "Environment Variables → Optional safety flags" (match the existing entry style):
   > `ARIES_TRUST_CENTER_ENABLED=1` — surfaces the public Trust Center (`/trust`) and Known Limitations (`/limitations`) pages in the marketing nav, footer, and sitemap. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF: the pages exist and are reachable by direct URL, but are not linked from nav/footer/sitemap until the copy is reviewed. Pages render documented facts only (from `docs/SECURITY_MODEL.md` / `docs/SELF_HOSTING.md`) and read no runtime state.
2. Add `ARIES_TRUST_CENTER_ENABLED=0` to `.env.example` (with a one-line comment, matching the `ARIES_VIDEO_PUBLISH_ENABLED=0` style at `.env.example:53`) and to `docker-compose.yml` env block (default `${ARIES_TRUST_CENTER_ENABLED:-0}`, matching the `ARIES_VIDEO_PUBLISH_ENABLED: ${...:-0}` style at `docker-compose.yml:74`).
3. **Live QA (user-visible success bar — rendered UI only):** with the flag flipped ON in a non-prod/preview context (or via `/qa` against a deploy), confirm in a real browser:
   - `aries.sugarandleather.com/trust` renders all nine cards through the marketing shell with correct nav/footer chrome.
   - `aries.sugarandleather.com/limitations` renders all four cards.
   - Nav shows "Trust"; footer shows "Trust center" + "Known limitations"; `/sitemap` lists them.
   - No console errors; pages pass an `/design-review` pass for the existing dark marketing theme (these pages inherit the current palette — brand-palette migration is roadmap area 5, **out of scope here**).
4. **Ship:** `/ship` → run `npm run verify` then the targeted page tests, bump `VERSION` (patch — additive static pages + default-OFF flag), update `CHANGELOG.md`, open PR. Default ships OFF; flip `ARIES_TRUST_CENTER_ENABLED=1` in prod as a follow-up once copy is signed off.

**Acceptance:** flag documented in three places (`CLAUDE.md`, `.env.example`, `docker-compose.yml`); with flag ON in a real browser the two pages render with full chrome and discovery links; `npm run verify` + `full-suite` gate green; default remains OFF.

## User-visible success bar (rendered UI only)

Done = a real browser at `aries.sugarandleather.com` (flag ON):
1. `/trust` renders the nine trust sections inside the marketing shell (nav + footer present), each section's copy matching a documented `SECURITY_MODEL.md` fact, with the "What Aries does NOT do automatically" section visible and the "Nothing goes live without your approval" framing on screen.
2. `/limitations` renders the four constraint sections (Hermes dependency, OAuth setup, current surfaces, not-yet-live) inside the same shell.
3. The marketing nav shows a "Trust" link; the footer shows "Trust center" + "Known limitations"; `/sitemap` lists both under a Trust group.
4. With the flag OFF, none of those links appear (and no page over-promises).

DB rows, state files, passing unit tests, or a 200 from a `curl` do **not** count — only the rendered pages + visible nav/footer/sitemap links in the operator-facing browser do (per memory: user-visible completion = rendered UI).

## Testing + CI-exact verify

- New tests, each run with `APP_BASE_URL=https://aries.example.com`:
  - `tests/trust-center-page.test.ts` — render + 9 topics + framing + brand-URL/no-backend/no-`MARKETING_STATUS_PUBLIC` source guards.
  - `tests/limitations-page.test.ts` — render + 4 topics + over-promise guards + brand-URL guards.
  - `tests/trust-center-flag.test.ts` — flag matrix for nav/footer/sitemap link presence (drive `showTrust` explicitly + confirm the `MarketingShell` server-side default).
- Extend `tests/public-marketing-pages.test.ts` to also `isValidElement` + `.type === MarketingLayout` the two new pages (keeps them in the canonical marketing-page contract test).
- **Add an explicit new step to `scripts/verify-regression-suite.mjs`** running the three new test files. (Do NOT rely on `public-marketing-pages.test.ts` being in the suite — VERIFIED it is not currently a step there; the closest existing entry is `tests/social-content-public-copy.test.ts`. The new files must be allowlisted explicitly.)
- Run order before push: `npm run verify` (fast suite + guardrails:agent), then `APP_BASE_URL=https://aries.example.com tsx --test tests/trust-center-page.test.ts tests/limitations-page.test.ts tests/trust-center-flag.test.ts`, then `npm run lint` (banned-pattern check — these pages must avoid `placeholder`, `not yet wired`, etc.; "not yet live" copy is fine but phrase as product capability, and verify `npm run validate:banned-patterns` passes). Full CI-exact `full-suite` gate must be green before merge (per memory: `full-suite` is a REQUIRED check on master).
- Idempotency/resumability: N/A — static pages, no DB writes, no workflow state. The only "idempotency" concern is the Phase 3 nav/footer edits (grep for the hrefs after editing to avoid duplicate insertion on re-run).

## Rollback

- **Flag:** `ARIES_TRUST_CENTER_ENABLED=0` instantly un-links both pages from nav/footer/sitemap (pages remain reachable by direct URL but un-advertised). Zero deploy needed.
- **Full revert:** delete `app/trust/page.tsx`, `app/limitations/page.tsx`, `lib/public-flags.ts`, the three test files; revert the `marketing-shell.tsx` / `chrome.tsx` / `sitemap.ts` / `sitemap/page.tsx` / `ROUTE_MANIFEST.md` / `CLAUDE.md` / `.env.example` / `docker-compose.yml` / `verify-regression-suite.mjs` edits (`MarketingLayout.tsx` is a pure re-export and needs no value revert). No schema, no data, no migration — clean revert.

## Out of Scope

- **Brand palette / typography migration** (Obsidian/Warm Stone/Ember, Cormorant Garamond) — roadmap area 5; these pages inherit the *current* dark marketing theme and will re-skin with the rest of the site.
- **Any new security behavior** — this plan renders existing, documented controls; it does not add encryption, rotate keys, change auth, or alter the callback boundary.
- **Operator-facing in-app security/settings UI** — these are *public marketing* pages; an authenticated "your security settings" surface is separate work.
- **Data deletion/export *mechanism*** — the page links the existing `support@sugarandleather.com` request path (documented in `app/privacy/page.tsx`); building a self-serve export/delete button is out of scope (it would be a real backend feature, not a content page).
- **A status/incident page or public changelog** — roadmap area P4 (ecosystem); not this plan.
- **Localizing or per-tenant-customizing** the trust copy — single global English page.
- **Reels/Stories/video publishing** — already shipped + gated (#520); the Limitations page only *describes* its gated state, it does not change it.
- **`app/robots.ts`** — needs no change (global `allow: '/'`); not edited.

## Risks

- **Over-claiming on the Trust page.** Mitigation: decision #1 — every claim traceable to a `docs/SECURITY_MODEL.md` line; the test source-greps for forbidden assertions and the "what we do NOT do" section is mandatory. A reviewer (`/review`) checks each card against the doc before flip.
- **Stating a limitation that's actually fixed (or vice-versa).** The shipped-surface facts (image stories live, video gated OFF, no insights scopes) are current as of this branch but can drift. Mitigation: phrase surfaces as "live today" / "off by default while we finish quality work" rather than hard version numbers; re-verify against `synthesize-publish-posts.ts` + `project-meta-insights-scopes-missing` memory at ship time.
- **Brand-URL slip** (bare `sugarandleather.com`). Mitigation: per memory, the test asserts product URLs are `aries.sugarandleather.com`; email `@sugarandleather.com` is the documented contact and explicitly allowed by the guard regex.
- **Flag threading through the client navbar (the easy mistake).** `chrome.tsx` is `'use client'`; reading `process.env.ARIES_TRUST_CENTER_ENABLED` anywhere inside it would be `undefined` in the browser. Mitigation: the flag is evaluated **only** in `components/redesign/layout/marketing-shell.tsx` (a server component — the real boundary) and passed down as `showTrust`. `chrome.tsx` receives a boolean prop and never imports `lib/public-flags.ts`. The flag test renders `MarketingShell` server-side AND drives `showTrust` explicitly into the navbar/footer to confirm both legs.
- **Banned-pattern false positive** on "not yet live" copy. Mitigation: avoid banned literal strings (`not yet wired`, `placeholder`, `intentionally disabled until`); phrase as product capability ("rolling out behind reliability work"); `npm run validate:banned-patterns` in the verify step catches any slip.
- **Accidentally coupling to runtime marketing state.** Mitigation: decision #7 + test guard `assert.doesNotMatch(source, /MARKETING_STATUS_PUBLIC/)` and no `backend/*` import; pages are pure static content.

## Files Reference

| File | Change | Phase |
|------|--------|-------|
| `app/trust/page.tsx` | NEW: 9-section public Trust Center (server component, `<MarketingLayout>`) | 1 |
| `app/limitations/page.tsx` | NEW: 4-section public Known Limitations page | 2 |
| `lib/public-flags.ts` | NEW: `isTrustCenterEnabled()` (default-OFF flag parse) | 3 |
| `components/redesign/layout/marketing-shell.tsx` | EDIT: read `isTrustCenterEnabled()` server-side, add `showTrust?` to `MarketingShellProps`, pass to `DonorMarketingShell` | 3 |
| `frontend/marketing/MarketingLayout.tsx` | VERIFY: re-exported `MarketingLayoutProps` carries the new optional `showTrust` (pure re-export; no value change) | 3 |
| `frontend/donor/marketing/chrome.tsx` | EDIT: accept `showTrust?` prop on shell/navbar/footer; flag-gated `NAV_ITEMS` + footer links (`/trust`, `/limitations`); never read `process.env` here | 3 |
| `app/sitemap.ts` | EDIT: flag-gated `/trust`, `/limitations` in `PUBLIC_ROUTES` | 3 |
| `app/sitemap/page.tsx` | EDIT: flag-gated `Trust & limitations` group in `ROUTE_GROUPS` | 3 |
| `ROUTE_MANIFEST.md` | EDIT: two new `## Public routes` rows | 3 |
| `tests/trust-center-page.test.ts` | NEW: render + 9 topics + framing + guards | 1 |
| `tests/limitations-page.test.ts` | NEW: render + 4 topics + over-promise/brand guards | 2 |
| `tests/trust-center-flag.test.ts` | NEW: flag matrix (nav/footer/sitemap link presence; server-side default via `MarketingShell`) | 3 |
| `tests/public-marketing-pages.test.ts` | EDIT: add the two pages to the marketing-page contract test | 1,2 |
| `CLAUDE.md` | EDIT: document `ARIES_TRUST_CENTER_ENABLED` under Optional safety flags | 4 |
| `.env.example`, `docker-compose.yml` | EDIT: `ARIES_TRUST_CENTER_ENABLED=0` default | 4 |
| `scripts/verify-regression-suite.mjs` | EDIT: add an explicit new step running the three new tests (no existing marketing-pages step to piggyback on) | 4 |
| `VERSION`, `CHANGELOG.md` | EDIT: patch bump + changelog entry | 4 |

## Related

- `docs/SECURITY_MODEL.md` — the source of truth for every `/trust` claim (auth, tenant isolation, token encryption, callback auth, rotation, reporting).
- `docs/COMMERCIAL.md`, `docs/SELF_HOSTING.md` — source of truth for the Hermes-dependency and OAuth-setup limitations.
- `app/api-docs/page.tsx`, `app/privacy/page.tsx`, `app/sitemap/page.tsx` — the established static-marketing-page pattern these pages copy.
- `components/redesign/layout/marketing-shell.tsx` — the server component that wraps every marketing page; the correct place to read the flag and thread `showTrust`.
- `tests/public-marketing-pages.test.ts` — the render-and-grep test harness the new tests extend.
- Roadmap area 1d (known-limitations page) + area 13 (trust center) — both delivered by this plan. Framing aligned to the homepage's existing "Nothing goes live without your approval" (`frontend/donor/marketing/home-page.tsx:664`).
- CLAUDE.md guardrails honored: treat-as-production (no runtime/state change; pure content), brand URL `aries.sugarandleather.com`, default-OFF flag (`ARIES_TRUST_CENTER_ENABLED`), approval-gated (the page *describes* the approval gate; it adds no autonomy), never expose `MARKETING_STATUS_PUBLIC=1` (pages read no marketing state).
