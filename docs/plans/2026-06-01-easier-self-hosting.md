# Easier self-hosting: bundled Postgres, Hermes stub, setup-checklist UI, comparison page

> Status: draft plan (2026-06-01). Roadmap area #12 (priority 8), Phase P4 (ecosystem). This makes a cold-clone self-host go from "edit `.env`, provision Postgres, beg Sugar & Leather for a Hermes gateway, run `db:init`, hope" to **one command → seeded demo tenant → a setup-checklist screen that tells you exactly what is still broken.** It does NOT change the production deploy path for `aries.sugarandleather.com`; managed prod keeps external Postgres + real Hermes.

## Context

A stranger who clones this Apache-2.0 repo today hits a wall. `docker-compose.yml` (lines 85–90) wires the app to an **external** `DB_*` Postgres that the repo never provisions — `docs/SELF_HOSTING.md:184` admits "It does not provision a Postgres container." There is no demo/stub execution mode, so every marketing pipeline run hard-fails on the Hermes config guard (`backend/execution/providers/hermes.ts:292-306`, `configurationError()` → `missingHermesConfigError`, status 503) unless you obtain a Hermes gateway URL + API key — and `docs/COMMERCIAL.md:30` says Hermes access requires contacting Sugar & Leather. There is no setup-checklist UI: the operator can't see at a glance which env vars are missing, whether the DB is reachable, whether Hermes is up, or which OAuth providers are ready. There is no seeded demo tenant. And there's no "self-host vs managed" comparison so a prospective user can decide which path to take.

Recon enumerated 8 friction points in `docs/SELF_HOSTING.md`: (1) Hermes is closed-source and mandatory for any workflow; (2) Postgres setup + role creation is fully manual; (3) the `NODE_ENV=production` OS-level guard silently breaks `npm ci`; (4) OAuth credential registration is scattered across 6 provider consoles; (5) `RESEND_API_KEY` absence silently no-ops password reset; (6) Compose requires external Postgres with no pre-startup health gate; (7) `ARIES_WEB_CONCURRENCY × DB_POOL_MAX` pool sizing has no guardrail; (8) secret rotation is a manual, side-effect-laden checklist.

This plan attacks the **first-result-in-one-command** wall, the largest of those: it bundles Postgres into a demo Compose overlay, adds a Hermes **stub execution mode** (deterministic canned envelopes, zero external service), seeds a curated demo tenant, builds a **setup-checklist UI** (a dashboard screen + a JSON readiness endpoint that reuses the existing `/api/health/db` + `/api/health/hermes` probes plus `runtime-precheck.mjs` env logic), and ships a **public self-host-vs-managed comparison page** in the marketing site. The friction points it does not auto-fix (rotation tooling, OAuth scatter) it instead **surfaces honestly** in the checklist and comparison page rather than hiding them.

## Who cares

- **Prospective self-hosters / OSS evaluators** — today the repo is un-evaluatable without a Hermes handshake. A one-command demo with a seeded tenant + stub Hermes is the difference between a star and a bounce.
- **Sugar & Leather (managed-hosting funnel)** — a clear comparison page routes serious users to managed hosting (`hello@sugarandleather.com`) instead of silently failing on Hermes and assuming the product is broken.
- **Eng / the operator (Brendan)** — the setup-checklist screen is also useful in **production**: a single page that says "DB ok, Hermes reachable, Meta connected, RESEND missing" beats grepping container logs.

## Decisions (locked — do not re-litigate)

1. **Demo overlay is a separate Compose file, not a change to `docker-compose.yml`.** Production deploy (`.github/workflows/deploy.yml`) keeps using `docker-compose.yml` (external Postgres) untouched. The new bundled-Postgres stack is `docker-compose.demo.yml`, run **only** by self-hosters via a `make demo` / `npm run demo:up` entrypoint. This avoids any risk to the live prod deploy.
2. **Hermes stub mode is a real provider/port pair, gated by `ARIES_EXECUTION_MODE=stub`** (default unset = real Hermes), selected at the single seam `backend/execution/provider-factory.ts` + a sibling marketing-port seam. It returns deterministic canned results for the marketing/social-content workflows so the dashboard renders end-to-end with **no external Hermes**. The stub keeps the existing provider/port **name** `'hermes'` and the `provider:'hermes'` discriminant (the interfaces hardcode that literal — see Current State); mode is orthogonal to name, so no string-literal union is widened. It NEVER publishes to Meta (publish dispatch stays approval-gated and, in demo, has no real tokens).
3. **The setup-checklist screen is operator-only** (`/dashboard/settings/setup`), behind auth + tenant context like the other settings pages. It is NOT a public page and NEVER leaks secret values — only present/absent booleans, reachability, and OAuth readiness, same redaction discipline as `docs/SECURITY_MODEL.md`.
4. **The comparison page is public marketing content** under `app/self-hosting/page.tsx` using the existing `MarketingLayout` shell (same pattern as `app/features/page.tsx`, which imports `MarketingLayout` from `frontend/marketing/MarketingLayout`, a re-export of `components/redesign/layout/marketing-shell`). It is static copy — no runtime data, no tenant data.
5. **Demo tenant is seeded by an idempotent script** (`scripts/seed-demo-tenant.mjs`), invoked once by the demo Compose stack, reusing the existing org/user provisioning in `lib/auth-tenant-membership.ts`. Re-running is a no-op (upsert on a fixed demo slug). The demo tenant uses curated, brand-safe placeholder content — it does NOT expose `MARKETING_STATUS_PUBLIC=1` and is not the production tenant.
6. **`MARKETING_STATUS_PUBLIC=1` stays OFF.** The demo experience is reachable by logging into the seeded demo account, not by exposing unauthenticated status routes. Per guardrail, this flag is never set to `1` in prod or in the shipped demo overlay (`docker-compose.yml:135` already defaults it empty/OFF).
7. **One rollout flag for the behavioral change: `ARIES_EXECUTION_MODE`** (values `hermes` default / `stub`). The checklist UI and comparison page are additive surfaces that don't change existing behavior, so they don't need their own flag — but the checklist's readiness endpoint is read-only and auth-gated, and the comparison page is static.

## Current State (VERIFIED — branch `fix/story-composer-serving`)

**Compose / bundled Postgres:**
- `docker-compose.yml:85-90` reads `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` from env; there is **no `postgres` service** in the file. `docker-compose.local.yml` only adds a dev override + an `aries-app-dev` profile, also **no Postgres**. `docker-compose.yml:135` references `MARKETING_STATUS_PUBLIC: ${MARKETING_STATUS_PUBLIC:-}` (defaults empty/OFF — never `1`).
- `docs/SELF_HOSTING.md:184`: "Compose expects PostgreSQL to be external... It does not provision a Postgres container." `docs/COMMERCIAL.md:20` + `:30-33`: self-hoster must provide their own Postgres + a Hermes gateway ("contact Sugar & Leather, LLC for access").
- No `Makefile`, no `demo:*` npm script. `npm run db:init` → `scripts/init-db.js`.

**Hermes stub / demo mode:**
- `backend/execution/provider-factory.ts` is the single seam: `getExecutionProvider(env)` always returns `new HermesExecutionAdapter(env)`; `resolveExecutionProviderName()` always returns `'hermes'`. **No stub branch.**
- `backend/execution/providers/hermes.ts:292-306` (`configurationError()`) fails closed when `HERMES_GATEWAY_URL`/`HERMES_API_SERVER_KEY` are unset (`missingHermesConfigError`, status 503). So a cold self-host can't run ANY workflow.
- `backend/marketing/execution-port.ts:145-149` `getMarketingExecutionPort(env)` always returns `new HermesMarketingPort(env)` — the second seam, used by the social-content pipeline. No stub branch. **Note (verified):** `MarketingExecutionPortName` is the hardcoded literal `'hermes'` (line 10) and `MarketingExecutionResult` hardcodes `provider:'hermes'` in **both** union variants (lines 88-90). A stub port must satisfy `name='hermes'` and return `provider:'hermes'`.
- **Pipeline progression is callback-driven, not return-value-driven (verified in `backend/marketing/ports/hermes.ts`):** `runPipeline` submits an `aries_run` and returns `kind:'submitted'` (line 768); stage advancement (research→strategy→production→approval→publish-ready) is driven by authenticated callbacks to `/api/internal/hermes/runs` via the poll-bridge invoking `handleHermesRunCallback` (lines 372-373, 750-809). **This is the load-bearing fact for Phase B:** a stub cannot just *return* a canned envelope and expect the dashboard to advance — it must feed synthetic callbacks into the same callback handler the poll-bridge uses (or return a synthetic terminal `kind:'completed'` and let the orchestrator drive), exactly mirroring the real port's callback contract.
- `backend/execution/workflow-catalog.ts` already models `mode: 'real' | 'stub'` per workflow (line 19; e.g. `demo_start.mode='stub'`, line 41), but **nothing consumes that field** to short-circuit the gateway call — it's metadata only (verified: no `=== 'stub'` reads in the execution backend). **Reuse this `mode` field as the canned-envelope key.**
- `backend/execution/types.ts` defines `ExecutionProvider` + `WorkflowExecutionResult` — the interface a stub must satisfy. The `kind:'ok'` shape is `{kind:'ok', envelope: WorkflowEnvelope, primaryOutput: Record<string,unknown> | null}` (NOT a nested `envelope:{status,output}`); `name` is typed `ExecutionProviderName`.

**Health / readiness surfaces (REUSE these — already exist):**
- `app/api/health/db/route.ts` — `probeDatabaseHealth()` runs `SELECT 1`, returns `{status, poolStats, roundTripMs, cacheAgeMs, cached}`, 503 on failure, with a 1s probe cache. **Note:** on error it currently returns `error.message` (line 62) — the new setup route must NOT do this (see redaction discipline below).
- `app/api/health/hermes/route.ts` — calls `probeHermesSocialContentRuntime(process.env)` (exported at `backend/marketing/hermes-runtime-contract.ts:256`), returns the gateway-health report + 503 when down.
- `scripts/runtime-precheck.mjs:77-117` — defines the `providerEnv` map (line 77), `envSet` helper, `providerMisconfigurations` (line ~91), and `configuredProviders` (line ~117) per OAuth provider from env. This env-readiness logic is the source of truth to reuse for the checklist's OAuth section.

**Setup-checklist UI:**
- `app/dashboard/settings/` has exactly two children: `business-profile/`, `channel-integrations/`. **No `setup/`.** No readiness endpoint under `app/api/`. Settings tabs render in `frontend/aries-v1/settings-screen.tsx` (ShellPanels for Business Profile + Channels/Integrations).

**Demo tenant seed:**
- `lib/auth-tenant-membership.ts` has `slugFromIdentity()` (line 27), idempotent org provisioning (`organizations` upsert by slug — `INSERT INTO organizations` at line 74), and `LOCAL_DEV_DEFAULT_TENANT_ROLE='tenant_admin'` (line 13). **No `scripts/seed-demo-tenant.*`.** `grep` for `demo`/`seed` in `init-db.js` returns only an unrelated `onboarding_memory_seeded_at` column (line 48).

**Comparison / self-host marketing page:**
- `app/features/page.tsx` (imports `MarketingLayout` at line 2) + `app/documentation/page.tsx` use the marketing shell. `app/sitemap.ts` lists `/features` + `/documentation` (lines 7-8). **No `app/self-hosting/` page** and no comparison content. `docs/COMMERCIAL.md` has the managed-vs-OSS split in prose but it's not surfaced as a marketing page.

**Tests / precedent:**
- `tests/hermes-runtime-contract.test.ts` (probe shape), `tests/deploy-workflow-self-hosted.regression-015.test.ts` (self-hosted deploy regression) are the closest precedents. `scripts/verify-regression-suite.mjs` is the allowlist for the fast gate.
- **`tests/prd-invariants/inv-05-hermes-native-default.test.ts` is a `full-suite` REQUIRED gate** that asserts `DEFAULT_EXECUTION_PROVIDER === 'hermes'`, `resolveExecutionProviderName({}) === 'hermes'` (empty env), and `getExecutionProvider({})` returns a usable adapter on the default env. The stub design **must preserve all three** (it does: empty env stays hermes; the stub only appears when `ARIES_EXECUTION_MODE=stub`). Related invariants `inv-07-publishing-requires-approval` / `inv-09-ai-content-draft-until-approved` also constrain the stub (it must not auto-publish and must keep drafts approval-gated).

## Architecture (target)

```
ONE COMMAND  →  make demo  (or npm run demo:up)
        │
        ▼
docker-compose.yml  +  docker-compose.demo.yml   (overlay; adds postgres + sets ARIES_EXECUTION_MODE=stub)
        ├─ postgres:16   (bundled, named volume, healthcheck)
        ├─ aries-db-init  (one-shot: waits for pg healthy → npm run db:init → node scripts/seed-demo-tenant.mjs)
        ├─ aries-app      (ARIES_EXECUTION_MODE=stub, demo APP_BASE_URL, no real Hermes/Meta needed)
        └─ aries-scheduled-posts-worker (unchanged; idle in demo — no real tokens)
        │
        ▼
LOGIN as seeded demo operator  →  dashboard renders end-to-end via STUB
        │
        ▼
backend/execution/provider-factory.ts   ─ ARIES_EXECUTION_MODE=stub ─►  StubExecutionAdapter (name='hermes')
backend/marketing/execution-port.ts      ─ ARIES_EXECUTION_MODE=stub ─►  StubMarketingPort   (name='hermes')
   (StubMarketingPort drives the runtime by feeding SYNTHETIC CALLBACKS into the same
    handleHermesRunCallback path the real poll-bridge uses — return value alone does not
    advance stages; publish dispatch still approval-gated, no Meta tokens)
        │
        ▼
/dashboard/settings/setup  ← GET /api/internal/setup/readiness
   reuses: /api/health/db probe  +  hermes-runtime-contract probe  +  runtime-precheck OAuth logic
   renders: env-var checklist · DB status · Hermes reachability · OAuth readiness · email · flags
        │
        ▼
PUBLIC  app/self-hosting/page.tsx  (MarketingLayout)  →  self-host vs managed comparison + 8 friction points, honestly stated
```

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Readiness endpoint + setup-checklist screen (reuse existing probes) | High | 5h / 2h | none |
| B | Hermes **stub execution mode** (`ARIES_EXECUTION_MODE=stub`) — both seams + canned envelopes + synthetic callbacks | High | 9h / 3.5h | none |
| C | Bundled-Postgres demo Compose overlay + `make demo` / `npm run demo:up` + db-init-and-seed one-shot | High | 5h / 2h | B (stub so app boots without Hermes) |
| D | Seeded demo tenant script (idempotent, reuses tenant-membership provisioning) | Medium | 4h / 1.5h | C |
| E | Public self-host-vs-managed comparison page (`app/self-hosting`) + nav + docs sync | Medium | 4h / 1.5h | A (links to checklist concept) |
| F | Docs: rewrite `SELF_HOSTING.md` quick-start around `make demo`; document `ARIES_EXECUTION_MODE`; ship | Medium | 3h / 1h | A–E |

**Sequencing:** A and B are independent and can land first (A is purely additive read-only UI; B is the execution seam). C depends on B (the demo stack must boot the app with no real Hermes, which only the stub allows). D depends on C (seed runs inside the demo stack's init one-shot). E depends on A only for cross-linking. F is last (docs reflect the shipped commands).

```
A ──────────────┐
B ──> C ──> D ───┼─> F
        └─> E ───┘
```

---

### A — Readiness endpoint + setup-checklist screen (High, 5h)

**New: `app/api/internal/setup/readiness/route.ts`** — auth-gated (`getTenantContext()`, reject if no session), tenant-scoped, read-only `GET`. Composes three already-existing sources into one redacted JSON payload:
1. **DB:** call the same probe used by `app/api/health/db/route.ts` (extract its `probeDatabaseHealth` into a shared `backend/health/db-probe.ts` so both routes import it — do NOT duplicate the `SELECT 1` logic). Return `{ ok, roundTripMs, poolStats }`.
2. **Hermes:** call `probeHermesSocialContentRuntime(process.env)` from `backend/marketing/hermes-runtime-contract.ts` (the exact call `app/api/health/hermes/route.ts` already makes). Return `{ ok, url, httpStatus }` — **strip any payload that could echo a key**.
3. **Env + OAuth readiness:** new `backend/health/env-readiness.ts` that factors the provider-env logic out of `scripts/runtime-precheck.mjs:77-117` (the `providerEnv` map + `envSet` + `providerMisconfigurations` + `configuredProviders` computation) into a reusable pure function `computeProviderReadiness(env)`. The route calls it and also reports presence-booleans (never values) for core required vars (`APP_BASE_URL`, `NEXTAUTH_SECRET`, `INTERNAL_API_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`, `DB_*`), email (`RESEND_API_KEY`/`EMAIL_FROM`), and the execution mode (`ARIES_EXECUTION_MODE` = `stub`/`hermes`).

**New: `app/dashboard/settings/setup/page.tsx`** + `frontend/aries-v1/setup-checklist-screen.tsx` — a client screen that fetches `/api/internal/setup/readiness` and renders sectioned status rows (green/amber/red dots, matching the channel-integrations health tone vocabulary in `frontend/aries-v1/channel-integrations-screen.tsx`). Sections: **Environment** (required vars present?), **Database** (reachable + round-trip ms), **Hermes** (reachable, or "stub mode — running without a gateway"), **OAuth providers** (per-provider ready/misconfigured/absent, reusing the precheck classification), **Email** (configured or "password reset disabled"), **Flags** (read-only echo of the relevant `ARIES_*` toggles). Each red/amber row carries a one-line remediation string pointing at the exact `.env` var or `SELF_HOSTING.md` anchor.

**Redaction discipline:** the route returns ONLY booleans, enum statuses, round-trip ms, and the (non-secret) Hermes URL host. It must never return a secret value or a raw DB error string that could contain a connection string with a password — map DB errors to a generic `connection_failed` code (the existing `/api/health/db` returns `error.message` at line 62; the setup route must NOT, per `SECURITY_MODEL.md` "never return raw state").

**Files:**
- NEW `app/api/internal/setup/readiness/route.ts`
- NEW `backend/health/db-probe.ts` (extracted from `app/api/health/db/route.ts`; that route now imports it)
- NEW `backend/health/env-readiness.ts` (extracted from `scripts/runtime-precheck.mjs`; the script now imports it)
- EDIT `app/api/health/db/route.ts` (import shared probe — behavior unchanged)
- EDIT `scripts/runtime-precheck.mjs` (import shared `computeProviderReadiness` — output unchanged)
- NEW `app/dashboard/settings/setup/page.tsx`
- NEW `frontend/aries-v1/setup-checklist-screen.tsx`
- EDIT settings nav (`frontend/aries-v1/settings-screen.tsx`, where the Business Profile / Channels-Integrations panels render) to add a "Setup" tab/link.

**Acceptance (user-visible):** logged in, navigating to `/dashboard/settings/setup` renders a checklist where, on the live VM, **Database = green**, **Hermes = green**, **Meta = ready**, **RESEND = configured-or-amber**, and on a fresh stub demo, **Hermes = "stub mode"** (not red), **Meta = absent**, **DB = green**. Zero secret values appear in the page or the network response.

### B — Hermes stub execution mode (High, 9h)

**Flag: `ARIES_EXECUTION_MODE`** — `''`/`hermes` (default) → real Hermes; `stub` → canned. Read once in the two factory seams. (Verified net-new: zero existing usages repo-wide.)

1. **New `backend/execution/providers/stub.ts`** — `StubExecutionAdapter implements ExecutionProvider` (the interface in `backend/execution/types.ts`), with `name = 'hermes'` (the literal the `ExecutionProviderName` type expects — no union widening). `runWorkflow(key, input)` returns a deterministic `WorkflowExecutionResult` of shape `{kind:'ok', envelope, primaryOutput}` (the exact union member in `types.ts`) per `workflow-catalog.ts` `mode`: for catalog workflows it synthesizes a believable demo `envelope` + `primaryOutput`. No `fetch`, no gateway, no config guard. Deterministic = same input → same output (seeded from `key`+a hash of input) so tests are stable.
2. **New `backend/marketing/ports/stub.ts`** — `StubMarketingPort implements MarketingExecutionPort` (interface in `backend/marketing/execution-port.ts`), with `name = 'hermes'` and returning `MarketingExecutionResult` (`{kind:'completed'|'submitted', provider:'hermes', ...}` — the discriminant is the hardcoded literal `'hermes'`; do NOT invent a `'stub'` provider name). **Mechanism (load-bearing):** stage progression in the real port is callback-driven, so the stub must drive the social-content runtime the same way — by feeding **synthetic callbacks** into `handleHermesRunCallback` (the same entry the real poll-bridge calls) for research → strategy → production → (approval checkpoint) → publish-ready, producing a **curated weekly plan + sample posts** (brand-safe placeholder copy, `aries.sugarandleather.com` CTA where a URL is needed — NEVER bare `sugarandleather.com`). `getCallbackUrl()`/`getSessionKey()` return demo-safe values. `submitRawRun` resolves immediately with a synthetic `hermesRunId` (the `SubmitRawRunResult` shape). **Critical:** publish dispatch remains approval-gated; the stub produces drafts requiring approval, it does NOT auto-publish (guardrail + `inv-07`/`inv-09`: nothing publishes without approval; and in demo there are no Meta tokens anyway).
3. **EDIT `backend/execution/provider-factory.ts`** — add `resolveExecutionMode(env)`; when `stub`, `getExecutionProvider` returns `new StubExecutionAdapter(env)`. **Keep `resolveExecutionProviderName` returning `'hermes'` and `DEFAULT_EXECUTION_PROVIDER='hermes'` unchanged** so `inv-05-hermes-native-default.test.ts` (a `full-suite` REQUIRED gate asserting empty-env → hermes and a usable adapter on default env) stays green. The provider *name* stays hermes-shaped for downstream; mode is orthogonal. (Verified: zero `=== 'hermes'`/`!== 'hermes'` literal-inequality sites in `backend/`/`app/`/`lib/`, so branching on mode rather than widening the name is the low-risk path — but still re-grep per CLAUDE.md memory "Widening union → grep inequalities" before shipping.)
4. **EDIT `backend/marketing/execution-port.ts`** — `getMarketingExecutionPort(env)` returns `new StubMarketingPort(env)` when mode is `stub`; `resolveMarketingExecutionPortName` keeps returning `'hermes'`.

**Resumability / idempotency:** the stub's synthetic-callback sequence is pure and deterministic per submitted run; re-submitting the same job is naturally idempotent (the orchestrator's existing run-store dedupe still applies). The stub must honor the same approval-checkpoint contract so the Review Queue and approval routes behave identically to real Hermes — the demo's whole point is that the UI is indistinguishable.

**Files:**
- NEW `backend/execution/providers/stub.ts`
- NEW `backend/marketing/ports/stub.ts`
- EDIT `backend/execution/provider-factory.ts`
- EDIT `backend/marketing/execution-port.ts`
- NEW `backend/execution/stub-envelopes.ts` (the canned per-workflow output fixtures, shared by both stubs)

**Acceptance (user-visible):** with `ARIES_EXECUTION_MODE=stub` and **no** `HERMES_GATEWAY_URL`/`HERMES_API_SERVER_KEY` set, starting a weekly social-content job from the dashboard runs to a rendered weekly plan + sample posts in the Review Queue **without any external call** and without the 503 config error. Approving advances the pipeline. Nothing publishes (no tokens; approval-gated). The `full-suite` gate — including `inv-05`/`inv-07`/`inv-09` — stays green.

### C — Bundled-Postgres demo Compose overlay (High, 5h)

**New `docker-compose.demo.yml`** — a Compose overlay merged over `docker-compose.yml` for self-hosters only. Adds:
- `postgres` service: `image: postgres:16`, named volume `aries-demo-pgdata`, `POSTGRES_USER/PASSWORD/DB` matching the demo `.env`, a `pg_isready` healthcheck.
- `aries-db-init` one-shot service: `depends_on: postgres (service_healthy)`, command runs `node scripts/init-db.js && node scripts/seed-demo-tenant.mjs`, then exits 0. Restart `on-failure` only.
- Overrides `aries-app` env: `ARIES_EXECUTION_MODE: stub`, `DB_HOST: postgres`, demo `APP_BASE_URL: http://localhost:3000`, and explicitly leaves Hermes/Meta vars blank (stub needs none). `depends_on: aries-db-init (service_completed_successfully)`.
- Pins `MARKETING_STATUS_PUBLIC` empty (guardrail — never `1`).
- Uses a self-contained internal network so a self-hoster doesn't need the external `docker-stack` network the prod compose requires; the demo overlay declares its own `networks:` or overrides the external one.

**New `Makefile`** (or `npm run demo:up`/`demo:down` scripts) — `make demo` = `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build -d`; `make demo-down` = `... down -v`. Ship a committed `.env.demo` template with safe non-secret demo defaults (random-but-fixed `NEXTAUTH_SECRET`/`INTERNAL_API_SECRET` placeholders the operator is told to leave or rotate).

**Files:**
- NEW `docker-compose.demo.yml`
- NEW `Makefile` (targets: `demo`, `demo-down`, `demo-logs`) and/or `package.json` `demo:up`/`demo:down` scripts
- NEW `.env.demo` (committed template, no real secrets)

**Acceptance (user-visible):** on a clean checkout with Docker, `make demo` brings up Postgres + app, runs init+seed, and `http://localhost:3000` serves the login page; logging in as the seeded demo operator (D) renders a populated dashboard. No external Postgres, no Hermes, no Meta required. `docker compose ... down -v` removes the demo volume cleanly.

### D — Seeded demo tenant (Medium, 4h)

**New `scripts/seed-demo-tenant.mjs`** — idempotent. Reuses `lib/auth-tenant-membership.ts` org provisioning (or its SQL shape — the `INSERT INTO organizations` upsert at line 74) to upsert: one `organizations` row (fixed slug e.g. `demo-acme`), one demo `users` row (`tenant_admin`, a known demo email + a clearly-demo password hash), and the membership linking them. Then seeds a curated brand profile / business profile so the dashboard isn't empty (brand-safe placeholder business, channels none-connected, a sample weekly plan if the stub doesn't generate one on first load). All writes `ON CONFLICT DO NOTHING`/upsert by slug+email so re-running (e.g. container restart) is a no-op.

**Guardrails:** the demo tenant is **not** the production `@sugarandleather` tenant; uses placeholder copy and `aries.sugarandleather.com` only where a URL is needed (never bare `sugarandleather.com`). Does NOT enable `MARKETING_STATUS_PUBLIC`. Does NOT seed real OAuth tokens.

**Files:**
- NEW `scripts/seed-demo-tenant.mjs`
- EDIT `package.json` (add `seed:demo` script) — invoked by `aries-db-init` in C.

**Acceptance (user-visible):** after `make demo`, logging in with the documented demo credentials lands on a dashboard with a named demo business, a sample weekly plan (via the stub), and channel-integrations showing all providers "not connected" (honest). Running the seed twice changes nothing (verified by row counts).

### E — Public self-host-vs-managed comparison page (Medium, 4h)

**New `app/self-hosting/page.tsx`** — uses `MarketingLayout` (same import pattern as `app/features/page.tsx`: `import MarketingLayout from '../../frontend/marketing/MarketingLayout'`). Static content, no runtime/tenant data. Sections:
- **Two paths, side by side:** Self-host (Apache-2.0, you run Postgres + Hermes, free) vs Managed (`hello@sugarandleather.com`, Hermes included, monitored). Sourced from `docs/COMMERCIAL.md` — keep claims identical to that doc; do not invent SLA numbers.
- **What self-hosting requires** — the honest list from `docs/COMMERCIAL.md:30-33` (your own Postgres, your own Hermes gateway, OAuth app registrations, email provider).
- **Try it in one command** — show the `make demo` flow and that stub mode lets you evaluate the UI **without** a Hermes gateway, with a note that real content generation needs Hermes (managed or self-run).
- **The 8 friction points, stated plainly** (not hidden): Hermes dependency, manual Postgres, `NODE_ENV` guard, OAuth scatter, silent email fallback, pool sizing, secret rotation, external-Postgres-in-prod-compose — each with the one-line mitigation. This is the "known limitations" honesty the roadmap demands (Framing: "Aries is safety-first... every publish action is traceable").
- Link to `SELF_HOSTING.md` and the (operator-only) setup-checklist concept.

**Nav:** add a "Self-hosting" link to the marketing shell / footer alongside Features/Documentation (the marketing nav lives in `components/redesign/layout/marketing-shell` and/or the landing chrome — edit wherever the `/features` + `/documentation` links render).

**Files:**
- NEW `app/self-hosting/page.tsx`
- EDIT the marketing nav/footer component (the one rendering Features/Documentation links, under `components/redesign/layout/`) to add Self-hosting.
- EDIT `app/sitemap.ts` to include `/self-hosting` (alongside the existing `/features` + `/documentation` entries on lines 7-8).

**Acceptance (user-visible):** visiting `https://<host>/self-hosting` renders the comparison + 8-friction-point page in the marketing shell, with a working link to the demo command and to managed-hosting contact. Brand URL appears only as `aries.sugarandleather.com`.

### F — Docs + ship (Medium, 3h)

1. **EDIT `docs/SELF_HOSTING.md`** — add a "Quick start (one command)" section at the top: `make demo` → seeded demo tenant → stub mode. Keep the full manual path below for production self-hosters. Add an `ARIES_EXECUTION_MODE` row to the env reference table. Cross-link the new `/self-hosting` page and the `/dashboard/settings/setup` checklist.
2. **EDIT `CLAUDE.md` "Environment Variables"** — document `ARIES_EXECUTION_MODE=stub` in the flag style of the existing entries (default unset/`hermes`; `stub` returns deterministic canned envelopes with no external Hermes; demo/eval only; never set in managed prod).
3. **EDIT `docs/COMMERCIAL.md`** — note the bundled-Postgres demo overlay + stub mode under "Self-hosting".
4. `/ship-triage-deploy`; bump `VERSION` (current `0.1.13.18` → next patch segment per the repo's 4-segment scheme; this ships a new provider mode + compose overlay + routes) + `CHANGELOG.md`.

**Acceptance:** docs describe the exact shipped commands; `ARIES_EXECUTION_MODE` documented; `full-suite` gate green.

## Feature flag

`ARIES_EXECUTION_MODE` — execution provider mode selector.

- Aries treats unset or `hermes` (case-insensitive) as **real Hermes** (current behavior, the only mode in managed prod). `stub` selects the deterministic stub provider (`StubExecutionAdapter` + `StubMarketingPort`) that returns canned workflow results with **no external Hermes gateway, no API key, no `fetch`**. Used for the one-command self-host demo and local UI evaluation. The stub keeps the provider/port name `'hermes'` and the `provider:'hermes'` discriminant (no union widening); it never publishes to Meta and never bypasses approval checkpoints — publish dispatch stays approval-gated and, in demo, has no real tokens. Default unset (real Hermes). **Must remain unset/`hermes` in managed production** (`docker-compose.yml` is untouched; only `docker-compose.demo.yml` sets `stub`). This is a mode selector, not a kill switch over an existing surface, so it is read at the two factory seams (`backend/execution/provider-factory.ts`, `backend/marketing/execution-port.ts`) and nowhere else. It must NOT change `resolveExecutionProviderName`/`DEFAULT_EXECUTION_PROVIDER` (preserving `inv-05`).

The setup-checklist screen and the comparison page are additive read-only surfaces with no behavioral flag.

## User-visible success bar (rendered UI only)

Done = ALL of the following render in a browser (DB/state/mock signals do NOT count):

1. **Setup checklist:** `/dashboard/settings/setup` renders sectioned status (Environment / Database / Hermes / OAuth / Email / Flags) with green/amber/red rows and remediation strings; zero secret values in page or network payload. On the live VM, DB + Hermes + Meta show green.
2. **One-command demo:** on a clean clone, `make demo` boots and `http://localhost:3000` serves login; the seeded demo operator logs in to a **populated dashboard** (named business, sample weekly plan in Review Queue) with **no Hermes/Meta/external-Postgres configured**.
3. **Stub pipeline:** starting a weekly job in the demo runs end-to-end to a rendered plan + sample posts awaiting approval — no 503, no external call; approving advances it.
4. **Comparison page:** `/self-hosting` renders the self-host-vs-managed comparison + 8 friction points in the marketing shell, brand URL `aries.sugarandleather.com` only.

## Testing Plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit | `resolveExecutionMode`: unset/`hermes`/`HERMES`/`stub`/junk → correct mode; **`inv-05` parity: `resolveExecutionProviderName({})`/`DEFAULT_EXECUTION_PROVIDER` still `'hermes'` and `getExecutionProvider({})` usable**; grep-verified no stale `=== 'hermes'` | +6 |
| Unit | `StubExecutionAdapter.runWorkflow`: deterministic `{kind:'ok', envelope, primaryOutput}` per catalog key; `name==='hermes'`; no `fetch` invoked (inject a throwing fetch, assert not called) | +4 |
| Unit | `StubMarketingPort`: feeding synthetic callbacks drives research→strategy→production→approval→publish-ready; returns `MarketingExecutionResult` with `provider:'hermes'`; publish stays approval-gated (never auto-publishes) | +5 |
| Unit | `computeProviderReadiness(env)` extracted from precheck: parity with current `runtime-precheck.mjs` output for the same env; misconfig + configured cases | +4 |
| Unit | `db-probe` shared module returns ok/error shapes; `/api/health/db` behavior unchanged after extraction | +2 |
| Integration (route) | `GET /api/internal/setup/readiness` auth-gated (401 unauth); returns booleans/enums only; **no secret value or raw DB error string** in body (assert against a regex denylist of `password`/key prefixes; assert DB errors map to a generic code, never `error.message`) | +4 |
| Integration | demo seed idempotency: running `seed-demo-tenant` twice yields identical row counts (org/user/membership) | +2 |
| Integration | provider-factory + marketing-port return Stub instances under `ARIES_EXECUTION_MODE=stub`, Hermes instances otherwise; Stub instances still report `name==='hermes'` | +2 |
| Static/snapshot | `/self-hosting` page renders, contains managed-contact + the 8 friction headings; banned-pattern + brand-URL check (no bare `sugarandleather.com`) | +2 |
| E2E (manual) | `make demo` on a clean clone → login → dashboard populated → start job → plan renders → approve advances; `down -v` cleans up | manual |

**~35 automated + 1 manual.** New test files allowlisted in `scripts/verify-regression-suite.mjs`. All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify` then `npm run test:concurrent` (touches routes + backend + scripts), plus `npm run validate:banned-patterns` (the demo/stub copy + comparison page must not trip `placeholder`-family banned terms — write the stub fixtures as real demo content, not "placeholder response"). Run `npm run validate:execution-provider` (the Hermes callback/execution-port gate) to confirm the stub branch didn't regress the real-Hermes path, and confirm the full `tests/prd-invariants/*` set (notably `inv-05`/`inv-07`/`inv-09`) stays green.

## Rollout

- **Stub mode:** additive; `ARIES_EXECUTION_MODE` unset everywhere in managed prod = zero behavior change (`resolveExecutionProviderName`/`DEFAULT_EXECUTION_PROVIDER` untouched). Land + soak with the real path untouched; the stub is exercised only by tests and the demo overlay.
- **Setup checklist + comparison page:** additive read-only surfaces; safe to land immediately, no flag, no migration.
- **Demo overlay:** lives only in `docker-compose.demo.yml` + `Makefile`; the prod deploy (`docker-compose.yml`) is byte-identical, so the production deploy workflow is unaffected.
- **Order:** A + B first (independent). Then C → D (demo stack). E + F to close. Ship as one PR or a small stack; the prod-touching surface area is zero (no `docker-compose.yml` edit, no migration).

## Rollback

- **Stub:** unset `ARIES_EXECUTION_MODE` (or set `hermes`) → real Hermes; instant, no redeploy of code needed since it's env-driven.
- **Checklist route/screen:** purely additive; removing the route + page reverts with no data impact.
- **Demo overlay:** `docker compose -f docker-compose.demo.yml down -v`; it never touched the prod stack or prod DB.
- **Shared extractions (`db-probe`, `env-readiness`):** behavior-preserving refactors of existing code; revert restores inline logic. Covered by parity tests so a regression is caught pre-merge.

## Out of scope

- **Secret-rotation tooling** (friction #8) — surfaced honestly in the checklist + comparison page, but no automated rotation is built. (`SECURITY_MODEL.md:70-81` rotation table stays the manual reference.)
- **Open-sourcing or bundling Hermes** — Hermes stays a separate Sugar & Leather service (`COMMERCIAL.md:20`). The stub is an *evaluation* substitute, explicitly not a real content engine.
- **OAuth credential auto-provisioning** (friction #4) — the checklist shows readiness per provider; it does not register apps for you.
- **A managed-hosting signup/billing flow / pricing page** — the comparison page links to `hello@sugarandleather.com` only (pricing/support page is a separate P4 item).
- **Template gallery / example workspaces / contributor docs / public changelog** — separate P4 items.
- **Replacing `MARKETING_STATUS_PUBLIC` with a public demo route** — demo access is via the seeded login, not an unauthenticated status surface. The flag stays OFF.
- **Bundling Postgres into the *production* compose** — explicitly rejected; managed prod keeps external Postgres.

## Risks

- **Stub drift from real Hermes contract.** If the canned envelope shape or callback sequence lags the real `HermesWorkflowOutput` / callback contract, the demo renders differently from prod. *Mitigation:* the stub returns the same typed `WorkflowExecutionResult`/`MarketingExecutionResult` interfaces (compile-enforced) and drives stages via the same `handleHermesRunCallback` path; `validate:execution-provider` exercises both; stub fixtures live in one shared `stub-envelopes.ts` so the contract has one home.
- **Stub fails to advance the pipeline.** Because progression is callback-driven (not return-value-driven), a naive stub that only returns an envelope would leave the dashboard stuck at "submitted". *Mitigation:* `StubMarketingPort` explicitly feeds synthetic callbacks into the callback handler for each stage; a test asserts the job reaches publish-ready + an approval checkpoint.
- **Accidental `ARIES_EXECUTION_MODE=stub` in prod.** Would silently stop real content generation. *Mitigation:* `docker-compose.yml` never sets it; the setup-checklist screen renders a loud "Stub mode — not generating real content" banner so it's impossible to miss in any environment; a PRD-invariant-style test can assert the prod compose doesn't set `stub`.
- **Breaking `inv-05-hermes-native-default`.** A `full-suite` REQUIRED gate. *Mitigation:* the stub branches on mode only; `resolveExecutionProviderName`/`DEFAULT_EXECUTION_PROVIDER` are untouched, and a parity test re-asserts empty-env → hermes.
- **Readiness endpoint leaking secrets.** The single worst failure mode. *Mitigation:* the route returns only booleans/enums/round-trip-ms; a test asserts the JSON body matches no secret-shaped regex (key prefixes, `password`, JWT shapes) and that DB errors are mapped to a generic code, never `error.message` (the existing `/api/health/db` returns `error.message`, which this route must not copy).
- **Demo Compose network assumptions.** Prod compose uses an external `docker-stack` network; a self-hoster won't have it. *Mitigation:* the demo overlay declares a self-contained network so `make demo` works on a bare Docker install.
- **Banned-pattern trip on demo copy.** "placeholder"/"parity-stub"-family terms are banned in key files. *Mitigation:* write stub/demo content as believable demo copy, run `validate:banned-patterns` in the test plan.
- **Seed non-idempotency on restart.** A container restart re-runs the init one-shot. *Mitigation:* every seed write is upsert-by-slug/email; a parity test asserts double-run row-count stability.

## Files Reference

| File | Change | Phase |
|------|--------|-------|
| `app/api/internal/setup/readiness/route.ts` | NEW: auth-gated readiness JSON (DB+Hermes+env+OAuth, redacted) | A |
| `backend/health/db-probe.ts` | NEW: extracted `SELECT 1` probe shared with `/api/health/db` | A |
| `backend/health/env-readiness.ts` | NEW: `computeProviderReadiness` extracted from `runtime-precheck.mjs` | A |
| `app/api/health/db/route.ts` | EDIT: import shared probe (behavior unchanged) | A |
| `scripts/runtime-precheck.mjs` | EDIT: import shared readiness logic (output unchanged) | A |
| `app/dashboard/settings/setup/page.tsx` | NEW: setup-checklist screen entry | A |
| `frontend/aries-v1/setup-checklist-screen.tsx` | NEW: checklist UI (health-tone rows + remediation) | A |
| `frontend/aries-v1/settings-screen.tsx` | EDIT: add "Setup" tab/link | A |
| `backend/execution/providers/stub.ts` | NEW: `StubExecutionAdapter` (`name='hermes'`, `{kind:'ok',envelope,primaryOutput}`) | B |
| `backend/marketing/ports/stub.ts` | NEW: `StubMarketingPort` (`name='hermes'`, drives stages via synthetic callbacks) | B |
| `backend/execution/stub-envelopes.ts` | NEW: shared canned workflow fixtures | B |
| `backend/execution/provider-factory.ts` | EDIT: `resolveExecutionMode` + stub branch (name/default unchanged) | B |
| `backend/marketing/execution-port.ts` | EDIT: stub branch in `getMarketingExecutionPort` | B |
| `docker-compose.demo.yml` | NEW: bundled postgres + db-init/seed + stub app | C |
| `Makefile` / `package.json` scripts | NEW: `make demo` / `demo:up`/`demo:down`/`seed:demo` | C, D |
| `.env.demo` | NEW: committed demo env template (no real secrets) | C |
| `scripts/seed-demo-tenant.mjs` | NEW: idempotent demo tenant + curated profile seed | D |
| `app/self-hosting/page.tsx` | NEW: self-host-vs-managed comparison + 8 friction points | E |
| marketing nav/footer (`components/redesign/layout/`) + `app/sitemap.ts` | EDIT: add `/self-hosting` | E |
| `docs/SELF_HOSTING.md` | EDIT: one-command quick start + `ARIES_EXECUTION_MODE` row | F |
| `docs/COMMERCIAL.md` | EDIT: note demo overlay + stub mode | F |
| `CLAUDE.md` | EDIT: document `ARIES_EXECUTION_MODE` flag | F |
| `tests/setup-readiness-route.test.ts` | NEW (auth + redaction) | A |
| `tests/stub-execution-provider.test.ts` | NEW (deterministic, no-fetch, name='hermes', callback-driven, approval-gated, inv-05 parity) | B |
| `tests/env-readiness-parity.test.ts` | NEW (parity with precheck) | A |
| `tests/seed-demo-tenant.test.ts` | NEW (idempotency) | D |
| `scripts/verify-regression-suite.mjs`, `VERSION`, `CHANGELOG.md` | EDIT: allowlist + bump | F |

## Related

- Roadmap area #12 (this plan); P4 ecosystem; #2 demo experience (the seeded demo tenant is the substrate a richer "first useful result" demo later builds on).
- `docs/plans/2026-05-30-test-suite-repair.md` — the `tests/deploy-workflow-self-hosted.regression-015.test.ts` precedent and the `full-suite` gate this plan must keep green.
- `docs/plans/2026-05-30-story-reel-video-publishing.md` — the video/Reel/Story publish surfaces it added (shipped #520) are out of scope here; the stub never exercises them (no Meta tokens, approval-gated).
- Guardrails honored: prod compose untouched (treat-as-production), brand URL `aries.sugarandleather.com` only, `MARKETING_STATUS_PUBLIC` stays OFF, stub never auto-publishes (approval-gated; `inv-07`/`inv-09`), Hermes-native default preserved (`inv-05`), new behavior behind default-unset `ARIES_EXECUTION_MODE`, full CI-exact suite before push.
