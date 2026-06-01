# Brand-aligned design foundation — Obsidian / Cream / Warm Stone / Ember + Cormorant Garamond

> Status: draft plan (2026-06-01). Foundation. This is the **token + typography substrate** every screen consumes. It must land before any new-screen work (demo tenant, Launch Readiness, Review Queue v2, memory screen) so those surfaces are built on-brand once instead of retro-fitted. Roadmap area [5]; priority 2 of the "10 best to build first".

## Context

Aries' UI today reads as a generic violet/cyan SaaS product: **Inter** body + **Manrope** display, a violet `#7c3aed` → `#a855f7` → cyan `#38bdf8` accent gradient, and a near-black background. The brand direction is the opposite mood — an **editorial / executive "calm, clear, in control"** identity: **Obsidian** ground, **Cream** type, **Warm Stone** neutrals, **Ember** as the single restrained accent, with **Cormorant Garamond** headlines over a **Helvetica Neue** body. There are currently **zero** `obsidian` / `warm-stone` / `cormorant` / `helvetica-neue` / `ember` styling references anywhere in `app/`, `frontend/`, `components/`, `styles/`, or `tailwind.config.ts` (verified by grep) — this is greenfield brand adoption, not a tweak.

This plan migrates the **token + font foundation only**. It is cosmetic but load-bearing: every downstream screen consumes these tokens, so getting the palette, the type scale, and the WCAG-AA contrast right here means new surfaces inherit the brand for free.

### The single most important correction to the prior recon

The earlier audit named `styles/redesign/tokens.css` as the "primary token definitions". **That file is orphaned.** A full-tree search for any import of `styles/redesign/*` (`.css` import statements, `@import`, `next.config`, `postcss`, `package.json`) returns **nothing** — `frontend/auth/index.css` is likewise imported nowhere. The **only** stylesheet wired into render is `app/globals.css` (imported by `app/layout.tsx:4`). The colors and fonts that actually paint pixels come from three real places:

1. **`app/layout.tsx`** — loads `Inter` + `Manrope` via `next/font/google` and exposes them as the `--font-inter` / `--font-manrope` CSS variables on `<body>`.
2. **`app/globals.css` `@theme` block (lines 3–10)** — maps Tailwind's design tokens: `--font-sans → var(--font-inter)`, `--font-display → var(--font-manrope)`, and `--color-primary/secondary/accent/background` to the violet/cyan hexes. In Tailwind v4 these generate the `font-sans`, `font-display`, `bg-primary`, `text-primary`, `from-primary`, `to-secondary`, `text-accent`, etc. utilities that the app uses.
3. **Hard-coded Tailwind palette classes** (`violet-*`, `cyan-*`, `purple-*`, `sky-*`, `emerald-*`) and the `.text-gradient` / `.btn-primary` / `.marketing-bg` custom classes lower in `globals.css` — these are **not** driven by `@theme`, so a token swap alone will not retheme them.

So the foundation work targets `app/layout.tsx` + `app/globals.css` (the live system), then sweeps the hard-coded palette classes. `styles/redesign/tokens.css` is migrated too (so a future bundler wiring or reuse inherits the brand, and to leave no stale violet behind), but it is **not** the thing that renders today.

## Who cares

- **Operators / @sugarandleather (Brendan)** — the dashboard is the product surface that gets shown to real users; an editorial Obsidian/Cream identity reads "premium, in control" where violet/cyan reads "AI demo".
- **Product** — areas [2] (demo tenant), [3] (Review Queue v2), [4] (channel health), [10] (memory screen) are all queued; building them on the old palette means re-skinning later. Foundation-first avoids that.
- **Eng** — one token + font migration touches ~6 real files plus a bounded palette-class sweep; doing it as a screen-by-screen retrofit would touch dozens and drift.

## Decisions (locked — do not re-litigate)

1. **The live system is the target.** Migrate `app/layout.tsx` (fonts) and `app/globals.css` (`@theme` + custom classes) first. `styles/redesign/*` is migrated for hygiene but is known-orphaned; do not spend effort wiring it in (that is a separate, out-of-scope refactor).
2. **Palette is fixed at four named roles + semantic status colors.** Obsidian (ground), Cream (type), Warm Stone (neutrals/secondary surfaces), Ember (single accent). Success/warning/danger keep semantic distinctness but are re-toned to sit calmly on Obsidian. **This is load-bearing for the Phase-2 sweep:** the dominant palette literal on the operator surfaces is not violet/cyan — it is `emerald-*` (success/live) and `sky-*` (scheduled) status color in the presenters' status-tone helpers. Those re-tone under this decision, not just the violet/cyan accents. Exact hexes are pinned in Phase 1 and are the contract for all downstream work.
3. **WCAG-AA is a gate, not a nice-to-have.** Cream-on-Obsidian body text must clear **4.5:1**; large headline/UI text must clear **3:1**. Ember-on-Obsidian and Ember-on-Cream (for buttons) must clear **3:1** for the non-text/large case and be paired with an accessible text color. Phase 1 ships a contrast-check fixture that fails CI if a token pair regresses.
4. **`font-display` keeps its name; only its value changes.** The Tailwind `font-display` utility is already consumed by `frontend/aries-v1/presenters/*` (Settings, Results, Calendar, Post-list headlines — verified: Settings 6, Calendar 1, Post-list 2, Results 2 usages) and `frontend/documentation/Docs.tsx:74`. We repoint `--font-display` from Manrope to **Cormorant Garamond** and `--font-sans` from Inter to **Helvetica Neue** (web-safe stack; Helvetica Neue is a system font, not a `next/font/google` import). No class renames — the swap is invisible to JSX, so every existing headline rethemes for free.
5. **Behavioral flag is `ARIES_BRAND_V2_ENABLED`, default OFF.** A purely-cosmetic change is still user-visible, so per guardrails it ships behind a default-OFF flag. The flag swaps a single `data-brand` attribute on `<html>`; both the legacy and v2 token sets live in `app/globals.css`, scoped by attribute selector, so flipping the flag is a zero-deploy retheme and rollback.
6. **No new visual effects.** This is brand alignment, not a glow/animation pass (explicitly de-prioritized in the roadmap: "visual effects before brand alignment"). Existing `glow-purple` / `neon-glow` / `shine` decorations are re-toned or muted, never amplified.
7. **Cormorant Garamond is loaded via `next/font/google`** (already the loader for Inter/Manrope) so it self-hosts with no FOIT/FOUT and no external request at runtime — matches the existing `display: 'swap'` strategy.

## Current State (VERIFIED — master @ v0.1.13.18)

**Fonts — `app/layout.tsx`:**
- `Inter` (weights `400/500/600/700/800`) → `--font-inter`; `Manrope` (`600/700/800`) → `--font-manrope` (lines 7–19). Both applied to `<body className={...inter.variable...manrope.variable}>` (line 38). `<html lang="en">` (line 37) — no `data-brand` today.

**Live theme — `app/globals.css`:**
- `@theme` (lines 3–10): `--font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif`, `--font-display: var(--font-manrope), var(--font-inter), ui-sans-serif, sans-serif`, `--color-background: #050505`, `--color-primary: #7c3aed`, `--color-secondary: #a855f7`, `--color-accent: #c084fc`.
- `:root { color-scheme: dark }` (lines 12–14); `body` background `var(--color-background)`, color `#fff` (lines 33–34, inside `@layer base`).
- Hard-coded violet/crimson **not** driven by `@theme`: `.text-gradient` (lines 91–96, primary→secondary→accent — all violet/purple, no cyan), `.marketing-bg::before` (lines 98–107, crimson radial `rgba(194,53,80)`/`rgba(122,0,30)` literals), `.btn-primary` (lines 211–222, `var(--aries-crimson)`/`var(--aries-white)` — **undefined vars**), `.glass*` / `.bg-animate` / `.glow-purple` / `.hover-gradient-border` (lines 489–551, `rgba(124,58,237)`/`rgba(168,85,247)`/`rgba(192,132,252)` literals), scrollbar (`#050505`/`#1a1a1a`).
- **Undefined-token debt:** `globals.css` references `var(--aries-crimson)`, `var(--aries-accent)`, `var(--aries-white)`, `var(--space-1..24)`, `var(--text-lg)`, `var(--nav-height)`, `var(--glass-gradient)` etc. that are **defined nowhere in the repo** (grep confirms). Those custom classes (`.nav-public`, `.btn-primary`, `.hero-*`, `.section-*`) currently render with broken/fallback values — they are mostly used by older marketing partials, not the aries-v1 operator shell. We do **not** try to revive them; we re-tone only the classes that actually render.

**Orphaned redesign set — `styles/redesign/tokens.css` (+ base/utilities/marketing/app-shell/workflows):**
- `tokens.css` defines `--rd-accent: #7c3aed`, `--rd-accent-strong: #a855f7`, `--rd-accent-soft: #c084fc`, `--rd-cyan: #38bdf8`, `--rd-font-sans: 'Inter'...`, `--rd-font-display: 'Manrope'...`, `--rd-bg: #05050b`, and violet/cyan `--rd-gradient-*`. `utilities.css`/`marketing.css` reference `var(--rd-accent*)` / `var(--rd-cyan)`. **None of these files are imported** anywhere (verified) — orphaned. Migrated for hygiene only.

**Tailwind — `tailwind.config.ts`:**
- `extend.colors`: `aries-crimson #C23550`, `aries-deep #A0122D`, `aries-darkest #7A001E` (lines 12–14) — legacy crimson, low real usage. `fontFamily.sans: ['Inter','Manrope','sans-serif']` (line 17). `letterSpacing.widest: 0.25em` (line 19). `plugins: [tailwindcss-animate]`.
- Note: in Tailwind v4 the `@theme` block in `globals.css` is authoritative for `--color-*` / `--font-*`; `tailwind.config.ts` `extend.colors` only adds the `aries-*` named utilities. Both must be migrated for full coverage.

**Hard-coded palette classes (cannot be re-themed by `@theme` — require a sweep). VERIFIED COUNT: 66 occurrences across `frontend/aries-v1/` (full `violet|cyan|purple|sky|emerald` grep), plus the marketing/public files. Per-file breakdown of the operator-shell hits:**
- `components.tsx` — 10 (status chips: `sky-400`/`cyan-400`/`violet-400`/`teal-400`/etc. at the `:151,:153` region and the surrounding status-tone ladder).
- `post-list-presenter.tsx` — 9 (status pills/dots: `sky-*`, `emerald-*`, and `from-sky-400 to-primary` / `from-emerald-400 to-primary` gradients at `:277,:285,:286,:294,:295`).
- `onboarding-flow.tsx` — 8; `creative-action-drawer.tsx` — 7.
- `calendar-presenter.tsx` — 6 (`emerald-*` confirm buttons `:591,:605`; channel-badge `sky-*` `:926,:931`; status-tone `:951,:952`).
- `settings-presenter.tsx` — 5 (`emerald-*` connected/ok states `:76,:96,:405,:474,:484`).
- `post-workspace.tsx` — 5 (`workflowStateTone` helper `:101–104`: `emerald/violet/sky/rose`; progress bar `:1641` `from-sky-400 via-cyan-300 to-emerald-300`).
- `dashboard-home-presenter.tsx` — 4 (`emerald-*` callout/badge `:338,:341,:347,:482`).
- `landing-page.tsx` — 4; `results-presenter.tsx` — 3 (`emerald-*` live, `sky-*` scheduled `:144,:333,:334`); `review-item.tsx`/`reschedule-drawer.tsx`/`instagram-publish-drawer.tsx`/`facebook-publish-drawer.tsx`/`business-profile-screen.tsx` — 1 each.
- **The dominant literal on the success-bar presenters is `emerald-*` (live/success) + `sky-*` (scheduled) status color, not violet/cyan.** Those re-tone under Decision 2.
- **Live shell is clean:** `frontend/app-shell/layout.tsx`, `components/redesign/layout/app-shell.tsx`, and `frontend/aries-v1/home-dashboard.tsx` carry **zero** palette literals (verified) — the shell + home rethemes purely from tokens + `font-display`.
- Marketing/public: `app/not-found.tsx`, `app/contact/page.tsx`, `app/features/page.tsx`, `app/api-docs/page.tsx` (`text-gradient`, `from-primary to-secondary` CTAs — all four confirmed); `frontend/marketing/new-job.tsx:530` (`from-primary to-secondary`), `frontend/marketing/job-status.tsx:103` (`cyan-500`), `:416` (`from-primary to-secondary`), `:553` (`cyan-200`).
- `app/creative-memory/page.tsx` — 13 `cyan-*`/`violet-*`/`purple-*` hits (internal tooling, lower priority; re-tone in the Phase-2 sweep, not blocking).
- `frontend/documentation/Docs.tsx:74` — `font-display` consumer (gets Cormorant automatically; no class change).

**Brand assets — `lib/brand.ts`:** logo `/aries-logo.webp`, favicons. Out of scope (no mark redesign here).

**Tooling:** `npm run typecheck` = `next typegen && tsc --noEmit`. `npm run lint` adds `check-banned-patterns.mjs` (terms: `n8n`, `parity-stub`, `placeholder response/error`, `not yet wired`, …) + boundary/protocol checks. `npm run verify` = `guardrails:agent` + `verify-regression-suite.mjs` (which runs an explicit `args: ['--test', '<file>']` list — adding the new fixture means appending one entry to that array). There is **no CSS/visual unit gate today** — Phase 1 adds a self-contained token-contract test (Node test runner) so the brand contract is enforced by `full-suite`. `ARIES_BRAND_V2_ENABLED` does **not** yet exist anywhere (greenfield flag); `isVideoPublishEnabled` (`backend/marketing/synthesize-publish-posts.ts:115`) is the mirror parser to copy.

## Architecture (target token flow)

```
app/layout.tsx
  Inter, Manrope  ── REPLACE ──>  Cormorant_Garamond (display)  +  --font-helvetica stack (body, no google import)
        │  variables: --font-cormorant, (--font-inter/--font-manrope kept for legacy OFF path)
        ▼
app/globals.css
  @theme {
    --font-sans:    var(--brand-font-sans)     ← indirection so OFF/ON branch via :root vars
    --font-display: var(--brand-font-display)
    --color-background: var(--brand-bg)
    --color-primary:    var(--brand-primary)
    --color-secondary:  var(--brand-secondary)
    --color-accent:     var(--brand-accent)
    --color-foreground: var(--brand-fg)   (NEW token, consumed by body + utilities)
  }
  :root                  { …legacy violet/cyan + Inter/Manrope --brand-* values (unchanged default)… }
  :root[data-brand="v2"] { …Obsidian/Cream/Warm Stone/Ember + Cormorant/Helvetica --brand-* values… }   ← flag-scoped
        │  generates Tailwind utilities: font-sans, font-display, bg-primary, text-primary,
        │  from-primary, to-secondary, bg-background, text-foreground, …
        ▼
  .text-gradient / .btn-primary / .marketing-bg / .glow-* (custom classes)
        re-toned to Obsidian/Ember, scoped under [data-brand="v2"]
        ▼
Hard-coded palette sweep (Phase 2)
  violet-*/cyan-*/purple-*/sky-*/emerald-* in frontend/aries-v1/* (66 hits, incl. status-tone
  helpers in the 5 presenters) + marketing
        ── REPLACE ──>  brand utilities (bg-primary/text-foreground/text-secondary) or
                         a small set of new @theme color tokens (--color-warm-stone, --color-ember-soft,
                         re-toned --color-success/-warning/-danger)
        ▼
tailwind.config.ts
  aries-crimson/deep/darkest  ── REPLACE/RETIRE ──>  ember/warm-stone/obsidian/cream named utilities
        ▼
styles/redesign/tokens.css (orphaned)  ── migrate hexes for hygiene, no wiring ──
```

The `data-brand` attribute on `<html>` is set in `app/layout.tsx` from `ARIES_BRAND_V2_ENABLED`. OFF ⇒ no attribute ⇒ `:root` legacy `--brand-*` values win ⇒ pixel-identical to today. ON ⇒ `data-brand="v2"` ⇒ Obsidian/Cream/Ember values + re-toned custom classes win. **The `@theme` block references `--brand-*` indirection vars defined under both `:root` and `:root[data-brand="v2"]`** so the font/color swap branches on the attribute (a raw `@theme` value cannot branch on a selector — this indirection is the load-bearing trick, see Risks).

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| 1 | Pin palette hexes + type stack; add v2 `--brand-*` value set (flag-scoped) + `@theme` indirection in `app/globals.css`; load Cormorant Garamond + Helvetica stack in `app/layout.tsx`; WCAG-AA contrast fixture | Critical | 4h / 1.5h | none |
| 2 | Re-tone custom classes (`.text-gradient`, `.btn-primary`, `.marketing-bg`, `.glow-*`) under `[data-brand="v2"]`; sweep the 66 hard-coded `violet/cyan/purple/sky/emerald` literals in `frontend/aries-v1/*` (incl. the status-tone helpers in components.tsx/post-workspace.tsx and the 5 success-bar presenters) + marketing to brand/status tokens | High | 7h / 2.5h | 1 |
| 3 | Migrate `tailwind.config.ts` (retire `aries-crimson*`, add `ember`/`warm-stone`/`obsidian`/`cream` named utilities, repoint `fontFamily.sans`) + orphaned `styles/redesign/tokens.css` for hygiene | Medium | 2h / 45m | 1 |
| 4 | Flag wiring (`ARIES_BRAND_V2_ENABLED`), docs (`CLAUDE.md` / `.env.example` / `docker-compose.yml`), live operator-dashboard verification on the real VM, ship | Medium | 3h / 1h | 1, 2, 3 |

**Sequencing:** 1 first (defines the token contract everything else consumes). 2 depends on 1's tokens. 3 is independent of 2 (config + orphan hygiene) but depends on 1's hexes. 4 last (needs all token + class work to verify the rendered dashboard).

```
1 ─┬─> 2 ──┐
   └─> 3 ──┼─> 4
```

---

### Phase 1 — Pin palette + type; flag-scoped v2 token set; contrast gate (Critical)

**Pin the palette (this table is the downstream contract). Hexes are chosen to clear WCAG-AA and are verified by the Phase-1 fixture (ratios below are the computed values for the proposed hexes):**

| Role | Token | Hex (proposed) | Contrast vs Obsidian | Used as |
|------|-------|----------------|----------------------|---------|
| Obsidian (ground) | `--color-background` | `#14110F` | — | page bg, panels (darker), shell |
| Obsidian-elevated | `--color-surface` (NEW) | `#1E1A17` | — | cards, raised panels |
| Cream (type) | `--color-foreground` (NEW) | `#F4EFE6` | **16.42** ✓ ≥4.5 | primary text on Obsidian |
| Cream-muted | `--color-foreground-muted` (NEW) | `#C7BEB0` | **10.23** ✓ ≥4.5 | secondary text |
| Warm Stone | `--color-secondary` | `#A89A86` | **6.83** ✓ ≥3.0 | neutral surfaces, borders, secondary UI |
| Ember (accent) | `--color-primary` | `#C2552D` | **4.15** ✓ ≥3.0 (large) | primary buttons, key accents |
| Ember-soft | `--color-accent` | `#D98E5F` | 7.15 | gradient stop, hovers, soft highlights |
| Success | `--color-success` (NEW) | re-toned green that reads on Obsidian | (fixture) | live/success status (replaces `emerald-*`) |
| Warning | `--color-warning` (NEW) | re-toned amber | (fixture) | warning status |
| Danger | `--color-danger` (NEW) | re-toned terracotta-red | (fixture) | danger status |
| Scheduled | `--color-info` (NEW) | re-toned warm blue/stone | (fixture) | scheduled status (replaces `sky-*`) |

> **Button-text contrast is a real constraint, not a finalize-later footnote.** Cream `#F4EFE6` on Ember `#C2552D` computes to **3.96:1** — that clears the 3:1 large/bold-text gate but **fails the 4.5:1 normal-text gate.** So a primary button must either (a) use bold/≥18.66px-or-≥14px-bold label text and assert the 3:1 path, or (b) darken Ember until Cream clears 4.5:1. The fixture asserts *whichever path Phase 1 picks* — it must not silently pass a 3.96 pair against a 4.5 threshold. Pick (a) or (b) in this phase and encode the chosen threshold in the test.

> Exact hexes are finalized **in this phase** by running the contrast fixture; the table is the verified starting point. The fixture is the source of truth.

**Implementation:**
1. **`app/layout.tsx`:**
   - Add `import { Cormorant_Garamond } from 'next/font/google'`; instantiate `cormorant` with weights `['500','600','700']`, `display: 'swap'`, `variable: '--font-cormorant'`. (Helvetica Neue is a **system** font — no Google import; it lives only in the CSS stack.)
   - Keep `Inter`/`Manrope` imports for the **legacy** (`data-brand` absent) path so OFF stays pixel-identical; add `cormorant.variable` to `<body className>`.
   - Set `<html lang="en" data-brand={isBrandV2Enabled() ? 'v2' : undefined}>`. Use a tiny server-side helper `isBrandV2Enabled()` (treat `1|true|yes|on` as enabled, mirroring `isVideoPublishEnabled` in `backend/marketing/synthesize-publish-posts.ts`) — **do not** read `process.env` raw in JSX.
2. **`app/globals.css`:**
   - Introduce `--brand-*` indirection vars. In `@theme`, repoint `--font-sans` → `var(--brand-font-sans)`, `--font-display` → `var(--brand-font-display)`, and `--color-background/-primary/-secondary/-accent` → their `--brand-*` equivalents; add `--color-foreground: var(--brand-fg)`.
   - Define the legacy values under `:root { --brand-font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif; --brand-font-display: var(--font-manrope), var(--font-inter), ui-sans-serif, sans-serif; --brand-bg: #050505; --brand-primary: #7c3aed; --brand-secondary: #a855f7; --brand-accent: #c084fc; --brand-fg: #fff; … }` — unchanged from today, so OFF = byte-identical.
   - Define the v2 values under `:root[data-brand="v2"] { --brand-font-sans: var(--font-helvetica, 'Helvetica Neue'), Helvetica, Arial, system-ui, sans-serif; --brand-font-display: var(--font-cormorant), 'Cormorant Garamond', Georgia, serif; --brand-bg: #14110F; --brand-fg: #F4EFE6; --brand-primary: #C2552D; --brand-secondary: #A89A86; --brand-accent: #D98E5F; … plus --color-surface/-foreground-muted/-success/-warning/-danger/-info }`.
   - Change `body { color: #fff }` → `body { color: var(--color-foreground); }` so Cream applies under v2 and the legacy `--brand-fg: #fff` keeps white under OFF.
3. **Contrast fixture — NEW `tests/brand-design-tokens.test.ts`** (Node built-in runner, **self-contained**, no DB/infra):
   - Hard-code the v2 token hexes (the contract), compute WCAG contrast ratios for the load-bearing pairs: Cream/Obsidian (≥4.5), Cream-muted/Obsidian (≥4.5), Cream/Surface (≥4.5), Ember/Obsidian large (≥3.0), Warm-Stone-border/Obsidian (≥3.0 non-text), re-toned Success/Obsidian + Info/Obsidian (status legibility), and the **button label pair** at whichever gate Phase 1 chose (3:1 large-bold or 4.5 normal). Fail the test (and thus `full-suite`) if any pair regresses below its declared threshold.
   - This is the brand contract gate. Adjusting a hex later forces a green fixture run.

**Acceptance:** with `ARIES_BRAND_V2_ENABLED=1`, `<html data-brand="v2">` renders Obsidian bg + Cream text + Cormorant headlines + Ember primary buttons; with the flag OFF the page is byte-identical to today (violet/cyan/Inter/Manrope). `tests/brand-design-tokens.test.ts` passes and every contrast pair clears its declared threshold (including the documented button-text path).

### Phase 2 — Re-tone custom classes + sweep hard-coded palette (High)

**Implementation:**
1. **Custom classes in `app/globals.css`** — scope a v2 override block:
   - `.text-gradient` → under `[data-brand="v2"]`, gradient `linear-gradient(to right, var(--color-primary), var(--color-accent))` (Ember → Ember-soft), dropping the violet stops.
   - `.btn-primary` → Ember background, Cream text (per the chosen contrast path), muted shadow (kill the violet glow); fix the **undefined `var(--aries-crimson)`/`var(--aries-white)`** by switching to `var(--color-primary)`/`var(--color-foreground)`.
   - `.marketing-bg::before`, `.bg-animate`, `.glow-purple`, `.hover-gradient-border`, `.glass*::before` → replace `rgba(124,58,237)`/`(168,85,247)`/`(192,132,252)` literals with `color-mix(in oklab, var(--color-primary) X%, transparent)` under v2; keep legacy literals under the default selector. Re-tone, do not amplify (Decision 6).
   - Scrollbar `#050505`/`#1a1a1a` → Obsidian-derived under v2.
2. **Hard-coded Tailwind palette sweep — 66 occurrences in `frontend/aries-v1/`** — replace literal palette utilities with brand/status tokens (add NEW `@theme` tokens `--color-warm-stone`, `--color-ember-soft`, and the re-toned `--color-success/-warning/-danger/-info` so `bg-warm-stone`/`text-success`/etc. exist). The high-value, success-bar-visible sites:
   - **Status-tone helper functions (centralized — re-tone once, fixes many call sites):** `frontend/aries-v1/components.tsx:148–156` ladder (`sky/cyan/violet/teal`), `post-workspace.tsx:100–104` `workflowStateTone` (`emerald/violet/sky/rose`) and progress bar `:1641` (`from-sky-400 via-cyan-300 to-emerald-300`) → Ember accent for the `ready_to_publish`/active states; re-toned Success for `published/live`; re-toned Info for `scheduled/approved`.
   - **The 5 success-bar presenters** (`/dashboard`, Results, Calendar, Settings, Post list) — these carry 27 of the 66 literals, mostly `emerald-*` (live/success) and `sky-*` (scheduled): `dashboard-home-presenter.tsx:338,341,347,482`; `results-presenter.tsx:144,333,334`; `calendar-presenter.tsx:591,605,926,931,951,952`; `settings-presenter.tsx:76,96,405,474,484`; `post-list-presenter.tsx:156,211,230,238,277,285,286,294,295` (note the `from-sky-400 to-primary`/`from-emerald-400 to-primary` status gradients). Re-tone to the new status tokens; the `font-display` headlines retheme automatically (no class change).
   - **Drawers/onboarding/landing** (`onboarding-flow.tsx` 8, `creative-action-drawer.tsx` 7, `landing-page.tsx` 4, and the single-hit drawers/`review-item`/`business-profile-screen`) — sweep in this phase.
   - Marketing/public CTAs (`app/not-found.tsx`, `app/contact/page.tsx`, `app/features/page.tsx`, `app/api-docs/page.tsx`, `frontend/marketing/new-job.tsx:530`, `frontend/marketing/job-status.tsx:416`) `from-primary to-secondary` already follow `@theme` so they retheme automatically — **verify**, only touch the residual `cyan-*` literals (`job-status.tsx:103,553`).
   - `app/creative-memory/page.tsx` (internal tooling, 13 hits) — re-tone in this phase if time allows; it is **not** a blocking operator surface, so it may trail into a follow-up without blocking ship.
3. **Per CLAUDE.md memory "Widening union → grep inequalities" analog for class strings:** after settling on token names, grep the whole tree for every remaining `violet-`, `cyan-`, `purple-`, `sky-`, `emerald-`, `from-primary`, `to-secondary`, `text-gradient` and triage each — literal class strings won't be caught by `tsc`. Produce a checklist; leave deliberately-skipped internal-tooling sites documented in the PR.

**Acceptance:** with the flag ON, the operator dashboard (`/dashboard`), Settings, Results, Calendar, Post list, Review queue, and the public marketing home show **no** violet/cyan accents and **no** raw `emerald-*`/`sky-*` status color — status chips, progress bars, CTAs, and gradients all read Obsidian/Cream/Warm Stone/Ember + re-toned status tokens. With the flag OFF they are unchanged. A grep for `violet-|cyan-|purple-|sky-|emerald-` in `frontend/aries-v1/` returns only documented internal-tooling exceptions.

### Phase 3 — Tailwind config + orphan hygiene (Medium)

**Implementation:**
1. **`tailwind.config.ts`:** retire `aries-crimson/deep/darkest` (low real usage; grep first to confirm no operator surface depends on them — if any do, redirect those to Ember in the same commit) and add named brand utilities `ember`, `warm-stone`, `obsidian`, `cream` under `extend.colors` so non-`@theme` consumers can use `bg-ember` etc. Update `fontFamily.sans` to the Helvetica stack.
2. **`styles/redesign/tokens.css` (+ `utilities.css`, `marketing.css`, `app-shell.css` references):** migrate `--rd-accent*`/`--rd-cyan`/`--rd-font-*`/`--rd-gradient-*`/`--rd-bg` to Obsidian/Cream/Ember so the orphaned set carries no stale violet. **Explicitly note in the PR that this file is not imported** — this is hygiene so a future wiring inherits the brand; do **not** spend effort wiring it in (out of scope).

**Acceptance:** `tailwind.config.ts` exposes `bg-ember`/`text-cream` etc.; a grep of `styles/redesign/` for `7c3aed|38bdf8|a855f7|c084fc|Inter|Manrope` returns nothing; `npm run typecheck` + `npm run lint` stay green.

### Phase 4 — Flag, docs, live verification, ship (Medium)

**Implementation:**
1. **Flag `ARIES_BRAND_V2_ENABLED`** (default OFF): wired in `app/layout.tsx` via `isBrandV2Enabled()`. Document in `CLAUDE.md` "Environment Variables" (mirroring existing flag entries' format), `.env.example` (`ARIES_BRAND_V2_ENABLED=0`), and `docker-compose.yml` (set explicitly to `1` for the single-tenant prod once verified — but ship the PR with it OFF and flip in a follow-up after live QA).
2. **Live operator-dashboard verification on the real VM** (treat-as-production guardrail; only rendered UI counts): with the flag ON in a scratch/preview context, load `/dashboard`, `/dashboard/results`, `/review`, `/dashboard/settings/channel-integrations`, and the public home via `/browse`; confirm Obsidian/Cream/Cormorant render, headlines are serif, primary buttons are Ember, status chips are re-toned (no raw emerald/sky), and **contrast is legible** (spot-check Cream-muted secondary text and a primary button label). Screenshot before/after.
3. **`/ship`** (or `/ship-triage-deploy`): bump `VERSION` (patch — additive, flag-gated, no contract change) + `CHANGELOG.md` (match the existing `## vX.Y.Z — type(scope): subject` header + `### Added/Fixed` style). Run the full CI-exact suite before push.

**Acceptance:** flag OFF ⇒ dashboard pixel-identical to today (regression-safe). Flag ON ⇒ rendered operator dashboard shows the brand identity end-to-end (Obsidian ground, Cream serif headlines, Ember accent, re-toned status, no violet/cyan) verified by screenshot in Brendan's dashboard — **rendered UI is the only success signal** (per memory: DB/state/mock does not count). `full-suite` green.

## Feature flag

**`ARIES_BRAND_V2_ENABLED`** — rollout switch for the Obsidian / Cream / Warm Stone / Ember + Cormorant Garamond brand identity. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default **OFF**. When OFF, `<html>` carries no `data-brand` attribute and the legacy violet/cyan + Inter/Manrope `--brand-*` value set under `:root` renders — pixel-identical to v0.1.13.18. When ON, `<html data-brand="v2">` activates the Obsidian/Cream/Ember `--brand-*` value set, re-toned custom classes, and re-toned status tokens, and `app/layout.tsx` loads Cormorant Garamond as the display font (Helvetica Neue body via system stack). Purely presentational; no behavioral/data effect. Process-wide (affects all tenants in this single-tenant container). Document alongside the other `ARIES_*_ENABLED` flags in `CLAUDE.md`.

## User-visible success bar (rendered UI only)

Done = **with `ARIES_BRAND_V2_ENABLED=1`, the operator dashboard at `/dashboard` (and Results / Review / Settings) renders the brand identity, verified by screenshot in Brendan's live dashboard**:
- Background is Obsidian (warm near-black), not the old `#050505` cool black.
- Headlines (the `font-display` `<h1>/<h2>` in `frontend/aries-v1/presenters/*`) are **Cormorant Garamond serif**, not Manrope sans.
- Body/labels are the Helvetica Neue stack; primary buttons and key accents are **Ember**, not violet, with a legible button label.
- **No** violet/cyan/purple anywhere on the rendered operator surfaces, and status chips/progress bars read the re-toned brand status tokens, **not** raw `emerald-*`/`sky-*`.
- Cream-on-Obsidian text is legible (secondary/muted text still readable — the WCAG-AA fixture passing is necessary but the screenshot is the proof).

DB rows, state files, token-file diffs, or a passing fixture **do not** count on their own — the rendered dashboard does.

## Testing + CI-exact verify

| Layer | What | Count |
|-------|------|-------|
| Unit (self-contained) | `tests/brand-design-tokens.test.ts`: WCAG contrast for Cream/Obsidian, Cream-muted/Obsidian, Cream/Surface, Ember/Obsidian-large, button label pair (at chosen gate), Warm-Stone-border/Obsidian, Success/Obsidian, Info/Obsidian | +8 |
| Unit | `isBrandV2Enabled()` parses `1/true/yes/on` ⇒ true; unset/`0/false` ⇒ false (mirror existing flag-parser tests) | +2 |
| Static | grep gate (in PR description / a `scripts` check): no `violet-/cyan-/purple-/sky-/emerald-` in `frontend/aries-v1/` except documented exceptions; no `7c3aed/38bdf8/Inter/Manrope` left in `styles/redesign/` | manual |
| Render (manual, live) | `/dashboard`, `/dashboard/results`, `/review`, `/dashboard/settings/channel-integrations`, public `/` with flag ON via `/browse`; before/after screenshots; legibility spot-check (muted text + button label) | manual |
| Regression | full suite green with flag OFF (proves zero behavioral change) and ON | — |

**CI-exact steps before push:**
```bash
NODE_ENV=development npm ci          # if node_modules missing in worktree
npm run typecheck
npm run lint                          # includes check-banned-patterns + boundary/protocol
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/brand-design-tokens.test.ts
npm run verify                        # guardrails:agent + fast regression
npm run test:concurrent               # full TS suite (touches layout/globals consumed app-wide)
```
Append `tests/brand-design-tokens.test.ts` to the explicit `args: ['--test', …]` test list in `scripts/verify-regression-suite.mjs` so the contrast contract runs in the fast gate (it is self-contained and sub-second). The `full-suite` REQUIRED check on master must be green.

**Resumability / idempotency:** N/A for static CSS, but the flag itself is the idempotent kill switch — flip `ARIES_BRAND_V2_ENABLED=0` for instant, zero-deploy rollback to the legacy palette with no data implications.

## Rollback

- **Flag:** `ARIES_BRAND_V2_ENABLED=0` ⇒ `data-brand` attribute absent ⇒ legacy `:root` `--brand-*` values + Inter/Manrope render. Instant, no redeploy, no data touched.
- **Code:** all changes are additive (new `:root[data-brand="v2"]` block, new tokens, new font import, `--brand-*` indirection that defaults to the legacy values). Reverting the commit restores the prior `@theme` exactly; the legacy block is never deleted.
- **No schema, no contract, no Hermes, no publish-path involvement** — zero blast radius beyond pixels.

## Out of scope

- **Wiring `styles/redesign/*` into the bundle** — those files are orphaned; reviving them is a separate refactor. We migrate their hexes for hygiene only.
- **Reviving the undefined `--aries-*` / `--space-*` / `--text-*` / `--nav-height` custom-class system** in `globals.css` (`.nav-public`, `.hero-*`, `.section-*`) — broken before this plan, left as-is; only re-tone classes that actually render.
- **Logo / favicon / brand-mark redesign** (`lib/brand.ts`, `public/aries-logo.webp`) — keep current mark; a mark refresh is its own design task.
- **`app/creative-memory/page.tsx` full re-tone** may trail as a documented follow-up (internal tooling, non-blocking).
- **New visual effects, animations, motion** — explicitly de-prioritized; this is brand alignment only.
- **Light-mode / theme-switcher** — "Cream" is the type color, not a light background; this plan is Obsidian-ground only. A light theme is a separate effort.
- **Screen-level redesigns** (demo tenant, Launch Readiness, Review Queue v2, memory screen) — those consume this foundation and are separate roadmap items.

## Risks

- **`@theme` cannot branch on an attribute selector (Tailwind v4 limitation).** Mitigation: the `--brand-*` indirection — define `--brand-*` values under `:root` (legacy) and `:root[data-brand="v2"]` (brand), and have `@theme` reference them via `var()`. This is the load-bearing trick — if it's gotten wrong, OFF won't be pixel-identical. Call it out explicitly in code review and prove OFF-identity with a screenshot diff.
- **Button-text contrast (Cream/Ember = 3.96:1).** Below the 4.5 normal-text gate. Mitigation: Phase 1 chooses the large/bold (3:1) path or darkens Ember, and the fixture asserts the chosen gate — do not let a 3.96 pair pass a 4.5 assertion.
- **Cream-on-Obsidian readability.** Muted/secondary text (`--color-foreground-muted`) is the easiest pair to fail AA (proposed `#C7BEB0` computes 10.23, comfortable). The Phase-1 fixture is the gate; if a chosen hex fails, adjust toward higher contrast before any pixel work — do not ship a failing pair.
- **The palette sweep is larger than a glance suggests (66 literals, dominated by `emerald-*`/`sky-*` status color in the 5 success-bar presenters).** Mitigation: re-tone the centralized status-tone helper functions first (they fan out to many call sites), then sweep the residue; the grep checklist + the rendered-dashboard screenshot acceptance catch stragglers. A class missed in the sweep stays the old color (invisible to `tsc`, per CLAUDE.md literal-string-drift memory).
- **`globals.css` is consumed app-wide**, so a malformed selector could break every page. Mitigation: `npm run test:concurrent` after the change (it exercises route/render-adjacent tests), plus live `/browse` verification of the real dashboard before ship.
- **Cormorant Garamond at small sizes / on dense data tables** can read as low-contrast or fussy. It is a **display** font only (`font-display` utility); body stays Helvetica. Verify headlines-only usage; if any data-dense table accidentally inherits Cormorant, scope it back to `font-sans`.
- **Flag flip in prod (`docker-compose.yml`) before live QA** would expose an unverified palette to the live tenant. Mitigation: ship the PR with the flag OFF; flip to `1` in a **follow-up** only after the rendered-dashboard screenshot is approved (treat-as-production guardrail).

## Related

- Roadmap area [5] (UI brand alignment) — this plan is its foundation increment; screen-level work [2]/[3]/[4]/[10] builds on these tokens.
- `docs/plans/2026-05-30-story-reel-video-publishing.md` — house-style reference for this plan's structure and the `ARIES_*_ENABLED` flag pattern.
- CLAUDE.md guardrails honored: treat-as-production (rendered-dashboard-only success bar, flip flag in prod only post-QA), default-OFF flag, full CI-exact suite before push, brand URL `aries.sugarandleather.com` untouched (no copy change), no `MARKETING_STATUS_PUBLIC` exposure (this plan touches neither), Turbopack unaffected (CSS/font only, no webpack config).
