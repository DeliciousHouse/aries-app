# Finish the test-suite split — tenant-scope flat fixtures, retire the oauth "drift" myth, honestly mark requires-infra

**Status:** Open for a builder to pick up.
**Author:** Staff eng, 2026-06-01.
**Epic:** Honor `docs/plans/2026-05-30-test-suite-repair.md` to completion. That plan turned the REQUIRED `full-suite` gate from "assumed green" to "verified green." This plan closes the *residual correctness debt* recon found inside the now-green suite so the gate is honestly green, not accidentally green — and draws a clean line between "self-contained" and "requires-infra" tests.
**Roadmap:** Public-readiness area 1(a) — "test suite clean OR clearly split requires-infra vs self-contained." P0 public-trust gate.
**Related:**
- `docs/plans/2026-05-30-test-suite-repair.md` — parent plan; its Phases B–E landed (#502/#515). This plan is the verified follow-through, not a re-plan.
- `.github/workflows/tests.yml:20-63` — the `full-suite` REQUIRED gate this keeps honestly green.
- `#513` child A owns `tests/auth/integrations-tenant-context.test.ts` — **out of scope, do not touch.**

---

## Context

`full-suite` is a REQUIRED status check on `master` (memory: *test-suite rot + gate gap*, shipped #505/#507). It runs every `tests/**/*.test.ts` at `--test-concurrency=1` against a per-runner `DATA_ROOT` (`.github/workflows/tests.yml:60-63`). The parent test-suite-repair plan drove it to green.

But "green" hides three honesty problems that recon surfaced and this plan resolves:

1. **Four hydration fixtures in `tests/frontend-api-layer.test.ts` pass without exercising the production read path.** They write Stage-2/Stage-4 artifacts to a *flat* `<cacheRoot>/<runId>/<step>.json` layout. Production reads tenant-scoped `<cacheRoot>/<tenantId>/<runId>/<step>.json` (`backend/marketing/jobs-status.ts:387`), then falls through to a log-root path on miss (`:391`). The flat fixture matches **neither** primary nor fallback, so the artifact is never read — the test stays green by hydrating from a *different* source (runtime file / workspace store). The fixture is dead weight that looks load-bearing. A future change to the tenant-scoped read path would not be caught by these tests. **Verified empirically (see Current State): tenant-scoping the fixture keeps the test green and makes it exercise the real `jobs-status.ts:387` primary branch.**

2. **The oauth "column drift" the recon flagged is a false positive.** `tests/auth/oauth-connect.test.ts` is a hybrid: the Postgres path is mocked with `status` (matching the live column `oauth-db.ts:10`), and the *in-memory* store is seeded with `connection_status` (matching the live in-memory shape `oauth-memory-store.ts:10`). The post-mutation assertions at `:413`/`:506` deliberately assert the in-memory store is **unchanged** ("disconnect/reconnect is DB-only now"), so `connection_status` is the correct column to read there. Both column names are right for their respective stores. There is no bug to fix — only a comment to add so the next reader does not "repair" a correct test and a verification to lock it in.

3. **The requires-infra vs self-contained boundary is implicit.** Seven test files self-skip with `t.skip('database env not configured')` (e.g. `tests/scheduled-posts-worker-live-db.test.ts:67`, `tests/marketing/ingest-production-assets-live-db.test.ts:96`). They pass on CI only because they skip — the gate counts a skip as not-a-failure. That is fine, but the *intent* ("this needs a live Postgres, it is not self-contained") is encoded inconsistently across files and is invisible in the suite output. Roadmap area 1(a) asks for this split to be **clear**, not just functional.

This is deliberately a *correctness-and-clarity* plan, not a "fix red tests" plan. Every in-scope file already passes. We are upgrading three from "green by accident / implicit" to "green for the right, documented reason," so the REQUIRED gate is a trustworthy public-readiness signal.

## Who cares

- **Every engineer opening a PR** — a gate that is green for the wrong reason is worse than red: it trains people to trust a signal that does not actually cover the code path it claims to (memory: *test-suite rot + gate gap*).
- **Marketing pipeline owners** — `frontend-api-layer.test.ts` is the contract test for customer-facing campaign workspace hydration (brand/strategy/creative/publish review). If its fixtures do not exercise the tenant-scoped artifact read, the dashboard's truthfulness is unverified for the exact path production uses.
- **Public-readiness / trust** — area 1(a) is a public launch blocker. "Tests are clean and the requires-infra split is explicit" is a checklist item a reviewer (or a self-host evaluator) can verify in seconds once the split is labeled.

## Decisions (locked — do not re-litigate)

1. **`tests/auth/integrations-tenant-context.test.ts` is OUT** — owned by `#513` child A. Do not touch, assert on, or duplicate its fixes.
2. **The test files are the source of truth, not TODOS.md or the recon text.** Where recon and the verified file disagree (the oauth "drift"), the file + empirical run win. **Do not "fix" the oauth column to `status` at `:56`/`:413`/`:506`** — that would break the correct in-memory-store assertion. (Recon mislabeled this; this plan corrects the record.)
3. **No production behavior changes to make a test pass.** If verification turns up a real product bug, raise it as a separate finding (Decision honored from the parent plan). The flat-fixture fix is fixture-side only — zero edits under `backend/` or `app/`.
4. **Verify on the exact CI invocation.** `find tests -name '*.test.ts' | sort` piped to `tsx --test --test-concurrency=1`, `APP_BASE_URL=https://aries.example.com`, per-run `mkdtemp` `DATA_ROOT`. Isolated passes do not count — ordering pollution is a known repo failure mode.
5. **The requires-infra split is *additive labeling*, not removal.** We do not delete or unconditionally-skip the live-DB tests; we standardize how they declare "I need infra" so the boundary is legible. The skip string `'database env not configured'` stays the canonical marker; this plan makes its usage uniform and documents it.
6. **No new node_modules-coupled or Postgres-coupled self-contained tests.** Self-contained tests mock `pool.query`, set env via the file's `with*Env` helper, and write fixtures under a per-test `mkdtemp` `DATA_ROOT`.

## Current State (VERIFIED — file:line + empirical run, master @ `3ad77e6`)

**Baseline run (the four in-scope files, exact CI invocation, `mkdtemp` DATA_ROOT):**
- `tests/auth/oauth-connect.test.ts` — **10/10 pass.**
- `tests/onboarding-draft-route.test.ts` — **3/3 pass.**
- `tests/frontend-api-layer.test.ts` — **56/56 pass.**
- (`marketing-validated-runtime` / `marketing-brand-identity-parity` already green per parent plan Phase C; not re-listed in this scope's recon but inside the same gate.)

So nothing is red. The work is correctness/clarity, not repair.

**1 — Flat-fixture drift in `frontend-api-layer.test.ts` (the real residual):**
- The production read builds `path.join(root, tenantId, runId, '<step>.json')` as `primary` (`backend/marketing/jobs-status.ts:381-387`) and falls back to `stageLogRoot(stage).replace('{runId}', runId) + '/<step>.json'` on miss (`:358-368`, `:391`) — i.e. `output/logs/<runId>/stage-N-.../<step>.json`.
- Three fixtures write **flat** `<cacheRoot>/<runId>/<step>.json` (no `tenantId`, no log-root):
  - `:815-816` in `test('/api/marketing/jobs/:jobId and /latest block downstream approval metadata when strategy changes are requested')` (declared `:802`). Local `tenantId = 'tenant_real'` exists at `:812` but is unused in the path.
  - `:1873-1874` in `test('/api/marketing/jobs/:jobId keeps fresher runtime review fields while backfilling missing real publish artifacts')` (declared `:1867`). No local `tenantId` var; the test's canonical tenant is `'tenant_real'` (used at `:1887`).
  - `:2333-2335` in `test('/api/marketing/jobs/:jobId does not leak stale strategy review content from a different source on the same tenant')` (declared `:2325`). Local `tenantId = 'tenant_shared_source_guard'` at `:2329`; the *stale* run is intentionally a different source — see note below.
- The correct tenant-scoped pattern is already used elsewhere in the same file: `:2137-2140` (`path.join(process.env.ARTIFACT_STAGE2_CACHE_DIR!, tenantId, stage2RunId, '...')`), and `:1681-1682` is **already tenant-scoped** (`'tenant_real'`) — recon confirmed `:1681` is **not** a blocker; do not touch it.
- **Empirically verified:** temporarily rewriting `:815-816` to `path.join(..., tenantId, stage2RunId, ...)` and running `--test-name-pattern="block downstream approval metadata"` → still **1/1 pass**. So tenant-scoping is safe and makes the fixture land where `jobs-status.ts:387` actually reads.
- **`:2333` nuance (do not blindly tenant-scope):** that test asserts a *stale, different-source* strategy review is **not** leaked. Its stale fixture is deliberately mismatched. Tenant-scope the **path layout** (insert the `tenantId` segment so the read path is the production one) but preserve the **source mismatch** that the test depends on — the leak-prevention comes from `recordMatchesCurrentSource` (`backend/marketing/validated-profile-store.ts:198-201`) nulling a doc whose `source_url` ≠ `currentSourceUrl`, not from the artifact being unreachable. Verify the test still asserts no-leak after the layout change; if tenant-scoping alone made the stale doc suddenly hydrate, that is a real source-fingerprint finding to raise (Decision 3), not to paper over.

**2 — Oauth "column drift" is NOT a bug (verified):**
- Live Postgres column is `status` (`backend/integrations/oauth-db.ts:4,10`; RETURNING projects `status` at `:107`). The SQL mock's synthetic row uses `status` (`tests/auth/oauth-connect.test.ts:73,110,124`) — **correct, matches the DB.**
- Live in-memory store column is `connection_status` (`backend/integrations/oauth-memory-store.ts:10`). `seedConnectedProvider` seeds `connection_status` (`:56`) and the post-mutation assertions read `oauthStore().connectionsById.get('102')?.connection_status` (`:413`, `:506`) — **correct, matches the in-memory shape.**
- The assertions are *"unchanged"* checks: disconnect/reconnect are DB-only, so the memory store must still read `connection_status: 'connected'` (comments at `:412`, `:505` say exactly this). Changing `:56`/`:413`/`:506` to `status` would assert against a field the memory record does not have → `undefined` → test breaks. **The fix here is a one-line clarifying comment, not a code change.**

**3 — 28P01 non-fallback is correct (verified):**
- `shouldUseFallbackDraftStore` (`backend/onboarding/draft-store.ts:350-374`) lists `42P01`, `42703`, and the network/availability codes (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `08000/08001/08003/08006`, `53300`, `57P01/02/03`). **`28P01` (invalid_password) is intentionally absent**, so a non-network auth error surfaces 503 + `onboarding_draft_unavailable` with redaction instead of silently falling back to `DATA_ROOT`. Test 3 (`tests/onboarding-draft-route.test.ts:246-273`) asserts exactly this and passes. The plan's job is to *assert this invariant is locked*, not change the classifier.

**4 — Requires-infra markers (the split to make explicit):**
- 7 files self-skip with `t.skip('database env not configured')`: `tests/publish-creative-asset-ids.test.ts`, `tests/scheduled-posts-worker-end-date.test.ts`, `tests/scheduled-posts-worker-live-db.test.ts`, `tests/hackathon-register.test.ts`, `tests/marketing/synthesize-publish-posts-live-db.test.ts`, `tests/marketing/dashboard-publish-items-counter.test.ts`, `tests/marketing/ingest-production-assets-live-db.test.ts`.
- The string is consistent; what is missing is (a) a single shared guard helper so the check is uniform and greppable, and (b) a documented convention (a `tests/REQUIRES_INFRA.md` index + a `npm run` lens) so the split is *visible*, satisfying roadmap 1(a)'s "clearly split" language.
- **Env-key footprint is NOT uniform today (audit before adopting a shared helper):** the broadest file, `tests/marketing/synthesize-publish-posts-live-db.test.ts:32-33`, gates on **all five** of `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`; others check a subset. The shared guard must require the **superset** (all five), never a laxer triple, so that a previously-skipping file is never made to suddenly *run* (and fail) in a partial-env shell. See Phase E + Risks.

**The gate:** `.github/workflows/tests.yml:60` exports `DATA_ROOT="${RUNNER_TEMP}/aries-data"`, `:62` globs `tests/**/*.test.ts`, `:63` runs `tsx --test --test-concurrency=1`. `scripts/verify-regression-suite.mjs:161-172` lists `onboarding-draft-route`, `oauth-connect`, `marketing-validated-runtime` in the fast suite and deliberately excludes `frontend-api-layer.test.ts` (`:158`, "~70s; needs split").

## Architecture (what each layer proves)

```
  full-suite CI gate (tests.yml:60-63)  — REQUIRED on master
    DATA_ROOT=$RUNNER_TEMP/aries-data   APP_BASE_URL=https://aries.example.com
    tsx --test --test-concurrency=1  $(find tests -name '*.test.ts' | sort)
        |
        +-- SELF-CONTAINED (mock pool.query / mkdtemp DATA_ROOT / no socket) --+
        |     frontend-api-layer.test.ts
        |        fixtures NOW write <cacheRoot>/<tenantId>/<runId>/<step>.json   <-- Phase B
        |        -> jobs-status.ts:387 primary tenant-scoped read is EXERCISED
        |     oauth-connect.test.ts
        |        SQL mock row = status (oauth-db.ts:10)  +  memory seed = connection_status
        |        (oauth-memory-store.ts:10) -> both correct; comment added       <-- Phase C
        |     onboarding-draft-route.test.ts
        |        installDbMock throws 28P01 -> shouldUseFallbackDraftStore=false
        |        -> 503 onboarding_draft_unavailable, redacted                   <-- Phase D
        |
        +-- REQUIRES-INFRA (skips when DB env absent) -----------------------+
              *-live-db.test.ts et al. -> requireDbEnvOrSkip(t) shared guard   <-- Phase E
              skip string 'database env not configured' (canonical)
              indexed in tests/REQUIRES_INFRA.md
```

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Depends on |
|---|---|---|---|---|
| A | Clean-room baseline: run the exact CI invocation; capture the real green/skip set; confirm zero red | P0 | 0.25d / 20m | none |
| B | Tenant-scope the 3 flat hydration fixtures in `frontend-api-layer.test.ts` (`:815`,`:1873`,`:2333`); preserve the `:2333` source mismatch | P0 | 0.75d / 1h | A |
| C | Add clarifying comment + a regression assertion documenting the oauth `status`/`connection_status` two-store split; do NOT change the columns | P0 | 0.25d / 20m | A |
| D | Lock the 28P01 non-fallback invariant: add an explicit unit assertion over `shouldUseFallbackDraftStore` (28P01 ⇒ false) | P0 | 0.25d / 20m | A |
| E | Make the requires-infra split explicit: shared `requireDbEnvOrSkip` guard + `tests/REQUIRES_INFRA.md` + flag-gated `requires-infra` lens | P0 | 1d / 1.5h | A |
| F | Lock it in: full clean-room re-run; `npm run verify`; `npm run lint`; confirm `full-suite` green, no `integrations-tenant-context` regression attributed here | P0 | 0.5d / 30m | B,C,D,E |

**Sequencing:** A first (re-establish the baseline on this commit). B/C/D parallel (independent files). E parallel (touches a new helper + the 7 live-DB files + docs). F last.

```
A ─┬─> B ──┐
   ├─> C ──┤
   ├─> D ──┼─> F
   └─> E ──┘
```

### Phase A — Clean-room baseline (do this first, do not skip)

**Implementation.** Reproduce CI exactly from repo root:
```bash
# worktree already has node_modules; in a fresh checkout: NODE_ENV=development npm ci
export DATA_ROOT="$(mktemp -d)/aries-data"
export APP_BASE_URL=https://aries.example.com
mapfile -t TEST_FILES < <(find tests -name '*.test.ts' | sort)
npx --no-install tsx --test --test-concurrency=1 "${TEST_FILES[@]}" 2>&1 | tee /tmp/full-suite.log
grep -E '^(not ok|# (pass|fail|skipped|tests))' /tmp/full-suite.log
```
Triage every `not ok` into: (1) one of the four in-scope files (B/C/D), (2) a requires-infra file that should have *skipped* but did not (E — its guard is wrong), (3) `integrations-tenant-context` (hand to #513, do not touch), (4) new/unexpected red (escalate before fixing). Run each in-scope file *also* in isolation to detect ordering pollution.

**Acceptance.** A written record: total files, pass count, skip count, and a confirmation that the four in-scope files are green and that exactly the 7 known files skip with `'database env not configured'`. If a requires-infra file *runs* (does not skip) and fails, that is Phase E's first target.

### Phase B — Tenant-scope the flat hydration fixtures

**Implementation.** Fixture-side only; zero `backend/`/`app/` edits.
- `:815-816` (test `:802`, `tenantId='tenant_real'` at `:812`): rewrite both writes to
  `path.join(process.env.ARTIFACT_STAGE2_CACHE_DIR!, tenantId, stage2RunId, '<step>.json')`. Keep the existing `mkdir(path.dirname(plannerPath), { recursive: true })`.
- `:1873-1874` (test `:1867`): the test has no local `tenantId`; introduce `const tenantId = 'tenant_real';` (its canonical tenant, already used at `:1887`) and rewrite both Stage-4 writes to `path.join(process.env.ARTIFACT_STAGE4_CACHE_DIR!, tenantId, stage4RunId, '<step>.json')`.
- `:2333-2335` (test `:2325`, `tenantId='tenant_shared_source_guard'` at `:2329`): insert the `tenantId` segment so the **path layout** is production-canonical, but **preserve the deliberate source mismatch** the leak-prevention test depends on (`recordMatchesCurrentSource`, `validated-profile-store.ts:198-201`). After the change, re-run this specific test and confirm it still asserts no-leak. If tenant-scoping alone makes the stale doc hydrate (it should not — the source mismatch still nulls it), stop and raise a source-fingerprint finding per Decision 3.
- **Do NOT** set `ARIES_STAGE_CACHE_LEGACY_READ_FALLBACK=1` — the legacy flat-read is a deprecated, scheduled-for-removal path (`artifact-store.ts:65-75`); tests must assert the layout production writes today.
- **Do NOT** touch `:1681-1682` — already tenant-scoped (`'tenant_real'`).

**Acceptance.** Each of the three tests passes in isolation **and** in the full sorted suite. `grep -nE "ARTIFACT_STAGE[24]_CACHE_DIR!, (stage2RunId|stage4RunId|staleRunId)," tests/frontend-api-layer.test.ts` returns **only** intentional non-tenant-scoped writes (none expected after this phase, except where a test deliberately models a missing/legacy artifact — document any such case inline). Diff is fixtures only; no `ARIES_STAGE_CACHE_LEGACY_READ_FALLBACK` introduced; zero edits under `backend/` or `app/`.

### Phase C — Document the oauth two-store split (no column change)

**Implementation.** The `status` (Postgres) vs `connection_status` (in-memory) split is correct and intentional — recon mislabeled it as drift. To stop the next reader from "repairing" it:
- Add a comment above `makeQueryMock`'s type (`tests/auth/oauth-connect.test.ts:69`) stating the SQL mock row mirrors the **Postgres** column `status` (`oauth-db.ts:10`), and above `seedConnectedProvider` (`:44`) stating the in-memory store uses `connection_status` (`oauth-memory-store.ts:10`) and the `:413`/`:506` assertions intentionally read the **memory** store to prove the DB-only mutation left it untouched.
- Add one assertion to the disconnect test (around `:413`) that *also* reads back through the DB mock path (e.g. assert the mutation went to Postgres, not the memory store) so the two-store contract is positively pinned, not just commented. Keep it a pure mock assertion — no real socket.
- **Do NOT** rename `:56`/`:373`/`:442`/`:459` columns or change `:413`/`:506`.

**Acceptance.** All 10 `oauth-connect.test.ts` tests pass in suite. A `grep -n "connection_status" tests/auth/oauth-connect.test.ts` shows the comment explaining why it is correct. No real Postgres socket / outbound HTTP opened (the unhandled-SQL `throw` at `:177` never fires).

### Phase D — Lock the 28P01 non-fallback invariant

**Implementation.** Test 3 (`onboarding-draft-route.test.ts:246-273`) already proves 503-on-28P01 at the route layer. Add a focused **unit** assertion directly over the classifier so the invariant is pinned at its source and cannot silently regress if someone edits the code list:
- In `tests/onboarding-draft-route.test.ts` (or a sibling `tests/onboarding-draft-fallback-classifier.test.ts` if the classifier is exported; otherwise keep it route-level), assert that a `28P01`-coded error does **not** trigger fallback (route returns 503 `onboarding_draft_unavailable`, body redacts `password authentication failed|aries_user|28P01`) while a `ECONNREFUSED`-coded error **does** fall back to the `DATA_ROOT` store (route returns 200). This makes the network-vs-auth boundary an explicit, named test rather than an implicit single-case.
- If `shouldUseFallbackDraftStore` is not currently exported, do **not** export it solely for the test (avoid widening the module surface) — drive both branches through the route via `installDbMock` with the two error codes, matching the existing test-3 shape (`:261-264`).

**Acceptance.** Both branches (28P01⇒503, ECONNREFUSED⇒200-fallback) assert green in suite. The redaction assertion (`:270-272` shape) still holds. No classifier code change.

### Phase E — Make the requires-infra split explicit (the roadmap deliverable)

**Implementation.** Standardize the implicit split into a legible one. New behavior is **flag-gated default OFF** because it changes which tests *run* in an infra-present environment.
1. **Shared guard helper** `tests/helpers/requires-infra.ts` (NEW): `export function requireDbEnvOrSkip(t: TestContext): boolean` that checks **the superset of DB env keys the 7 live-DB files read today** and, when any is absent, calls `t.skip('database env not configured')` and returns `false`. **The superset is `DB_HOST && DB_PORT && DB_USER && DB_PASSWORD && DB_NAME`** — derived from the broadest file `synthesize-publish-posts-live-db.test.ts:32-33`. Using a narrower triple would make a file that *should* skip (because, say, `DB_PASSWORD` is unset) suddenly run and fail on a partial-env runner. **Audit each of the 7 files first (Phase A) and confirm the chosen key set is ≥ what every file requires before adopting.** Mirror the exact existing skip string so CI output is unchanged.
2. **Adopt the guard** in the 7 live-DB files (replace their ad-hoc inline check with `if (!requireDbEnvOrSkip(t)) return;`): `tests/publish-creative-asset-ids.test.ts:276`, `tests/scheduled-posts-worker-end-date.test.ts:145`, `tests/scheduled-posts-worker-live-db.test.ts:67`, `tests/hackathon-register.test.ts:97`, `tests/marketing/synthesize-publish-posts-live-db.test.ts` (3 sites: `:124`/`:266`/`:338`), `tests/marketing/dashboard-publish-items-counter.test.ts:146`, `tests/marketing/ingest-production-assets-live-db.test.ts:96`. Behavior is identical (still skips when DB env absent); the win is a single, greppable source of truth.
3. **Index** `tests/REQUIRES_INFRA.md` (NEW): one table listing each requires-infra file, the env it needs (`DB_*`, and any `HERMES_*`/mount), and the one-line command to run it against the live DB. This is the human-readable half of roadmap 1(a)'s "clearly split."
4. **`requires-infra` lens, flag-gated:** add a `scripts/list-requires-infra.mjs` that greps `tests/**` for `requireDbEnvOrSkip(` and prints the split (self-contained count vs requires-infra count). Wire it to a new npm script `test:requires-infra-report`. Gate any *execution* of the live-DB suite behind **`ARIES_TEST_REQUIRES_INFRA_ENABLED`** (default OFF): when unset/OFF, the report is informational only and the guard skips as today; when ON (operator sets `DB_*` + the flag in a real-DB shell), `npm run test:requires-infra` runs *only* those files with the guard satisfied. The `full-suite` CI gate is unchanged — it never sets the flag, so the live-DB files keep skipping on CI exactly as now.

**Flag entry (for `CLAUDE.md` Environment Variables, matching house format):**
> - `ARIES_TEST_REQUIRES_INFRA_ENABLED=1` — opt-in switch for running the requires-infra (live-Postgres) test split locally. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, the live-DB test files (indexed in `tests/REQUIRES_INFRA.md`) self-skip with `t.skip('database env not configured')` via the shared `requireDbEnvOrSkip` guard, exactly as the `full-suite` CI gate expects. When ON **and** `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` point at a reachable Postgres, `npm run test:requires-infra` runs those files for real. This is a developer/operator convenience flag read **only by the test harness, never by the app runtime, and never set by CI**; for that reason it lives in `CLAUDE.md` + `.env.example` (dev-shell env) and is **not** added to `docker-compose.yml`'s app-runtime environment block.

**Acceptance.** `npm run test:requires-infra-report` prints the two buckets and the 7 files in the requires-infra bucket. On CI (flag OFF, no `DB_*`), all 7 still skip with the unchanged string and `full-suite` stays green. `tests/REQUIRES_INFRA.md` exists and is accurate. No self-contained test moved into requires-infra or vice-versa. The flag is documented in `CLAUDE.md` + `.env.example` only (not `docker-compose.yml`).

### Phase F — Lock it in

**Implementation.** Re-run the exact Phase A invocation on a clean `mkdtemp` `DATA_ROOT`. Confirm zero failures attributable to B/C/D/E and that the 7 requires-infra files still skip. Run `npm run verify` (fast gate) and `npm run lint` (typecheck + banned-pattern + boundary). Run `npm run guardrails:agent` before opening the PR (CLAUDE.md guardrail #2 — parallel-worktree duplicate-work check). Open the PR; the `full-suite` REQUIRED check is the real acceptance.

**Acceptance.** `full-suite` green on the PR. `frontend-api-layer.test.ts`'s three rewritten fixtures verified to exercise the tenant-scoped `jobs-status.ts:387` primary read. `integrations-tenant-context.test.ts` untouched (if independently red, PR body attributes it to #513 and confirms this work did not regress it).

## Feature flag

`ARIES_TEST_REQUIRES_INFRA_ENABLED` (default OFF) — Phase E only. It gates *test execution selection in a developer/operator shell*, never app runtime and never CI; for that reason it is documented in `CLAUDE.md` + `.env.example` only and is deliberately **kept out of `docker-compose.yml`** (whose environment block carries app-runtime knobs the container actually reads). The three fixture/comment/assertion phases (B/C/D) are test-only correctness fixes with no behavioral surface, so they correctly ship **without** a flag (a flag would be ceremony — there is no production behavior to toggle). This honors the "new behavior behind a default-OFF flag" guardrail precisely: the only new *behavior* (optionally running the live-DB split) is gated; pure test-truth fixes are not.

## User-visible success bar

This is an internal trust/quality gate, so the "rendered UI" bar is the CI surface an operator/reviewer actually looks at — not a dashboard screen:
- **The `full-suite` REQUIRED check renders green on the PR** (GitHub Checks tab) *after* the fixtures provably exercise the tenant-scoped read path — i.e. green for the right reason, not by accident.
- **`npm run test:requires-infra-report` renders the explicit split** (self-contained N / requires-infra 7) in the terminal, and `tests/REQUIRES_INFRA.md` renders the human-readable index — these are the concrete artifacts that make roadmap 1(a)'s "clearly split requires-infra vs self-contained" verifiable at a glance.
- Per memory (*user-visible completion = rendered*): a passing local run alone does **not** count; done = the `full-suite` check shown green on the actual PR plus the rendered split report.

## Testing Plan (fixture-primary)

| Layer | What | How | Gate |
|---|---|---|---|
| Marketing hydration | brand/strategy/publish review hydrate from **tenant-scoped** Stage-2/4 artifacts (`jobs-status.ts:387` primary branch) | `frontend-api-layer.test.ts` `:815`/`:1873`/`:2333` fixtures rewritten tenant-scoped under `mkdtemp` DATA_ROOT | full-suite |
| Source-fingerprint | stale, different-source strategy review is NOT leaked even with production path layout | `frontend-api-layer.test.ts:2325` retains source mismatch; `recordMatchesCurrentSource` nulls the doc | full-suite |
| Auth two-store | DB mutation uses `status` (Postgres); memory store unchanged at `connection_status` | `oauth-connect.test.ts` SQL mock (`status`) + memory seed (`connection_status`) + new positive DB-path assertion | full-suite, fast verify |
| Infra classifier | 28P01⇒503 redacted (no fallback); ECONNREFUSED⇒200 fallback | `onboarding-draft-route.test.ts` `installDbMock` two-code branch | full-suite, fast verify |
| Requires-infra split | the 7 live-DB files skip uniformly via `requireDbEnvOrSkip`; report prints the buckets | `tests/helpers/requires-infra.ts` guard + `scripts/list-requires-infra.mjs` | full-suite (skip path) |
| Ordering | no cross-file pollution from the rewrites | each touched file run isolated AND in the full sorted glob | Phase A + F |
| Boundary | no real socket / HTTP / Postgres in self-contained tests | unhandled-SQL throw never fires; no `ECONNREFUSED` in log | Phase C/D |

Fixtures are primary: every self-contained assertion is driven by JSON under a per-test `mkdtemp` DATA_ROOT or an in-memory mock; nothing touches a live Postgres or the network. This satisfies CLAUDE.md guardrail #1 (no DB fan-out) trivially — the self-contained suite makes zero real DB calls — and the resumability rule is not in play (no stage execution runs for real).

## Idempotency / resumability

Not applicable to runtime — there is no migration, worker, or stage execution. The *plan itself* is resumable: each phase is independently shippable. If F finds a residual red, the offending phase's diff reverts in isolation without touching the others. The requires-infra guard is idempotent by construction (a missing-env skip is repeatable and side-effect-free).

## Rollback

Pure test/fixture/helper/doc changes plus one new default-OFF dev flag. Revert the PR to restore the prior state; no migration, no runtime behavior, no schema, no app-facing env. If a fixture rewrite accidentally masks a real regression, that single test reverts independently. There is **zero production blast radius** — the flag is never read by the app and never set by CI.

## Out of Scope

- `tests/auth/integrations-tenant-context.test.ts` — **owned by #513 child A.** Not touched.
- **Re-fixing the oauth `status`/`connection_status` columns** — they are correct (Decision 2). This plan explicitly forbids that change.
- **Removing `ARIES_STAGE_CACHE_LEGACY_READ_FALLBACK`** — its retirement is the parent `artifact-store.ts:70` TODO, a separate cleanup; this plan only stops *tests* from depending on the flat layout.
- **Splitting the ~70s `frontend-api-layer.test.ts` for speed** (`verify-regression-suite.mjs:158` "needs split") — a perf task, not a correctness fix; this plan makes the fixtures honest, not faster.
- **Standing up a Postgres test container / actually running the live-DB suite on CI** — out of scope; the requires-infra split *labels* and optionally *enables locally*, it does not provision infra. (Roadmap area 12 "easier self-hosting" owns one-command Postgres.)
- **Any production code change to make a test pass** (Decision 3). Real bugs surfaced during verification are raised as separate findings.
- The Honcho write-path test files and the four Honcho backlog items — unrelated workstream.

## Risks

- **Tenant-scoping a fixture flips its hydration source and changes what it asserts.** Mitigation: empirically verified for `:815` (still green, now exercises `jobs-status.ts:387`); run each rewritten test isolated + in-suite (Phase B/F). For `:2333`, the source-mismatch leak-prevention is preserved deliberately — if scoping alone makes the stale doc hydrate, that is a *finding*, not a fix-to-green (Decision 3).
- **The `:2333` test is a leak-prevention test — over-eager scoping could weaken it.** Mitigation: scope only the path *layout*, keep the `source_url`/`currentSourceUrl` mismatch; assert no-leak still holds post-change.
- **`requireDbEnvOrSkip` checks the wrong env subset and a live-DB test that should skip instead runs (and fails) on CI.** Mitigation: derive the env keys from the **superset** of what the 7 files read today (the broadest is `synthesize-publish-posts-live-db.test.ts:32-33`'s full five `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`); never adopt a laxer key set than any file requires; keep the exact skip string so CI counts it identically; Phase F confirms all 7 still skip on the flag-OFF CI profile.
- **Ordering pollution makes a rewrite green in isolation but red in-suite (known repo failure mode).** Mitigation: Decision 4 — every touched file run both isolated and in the full sorted glob in Phase A and F.
- **A reviewer "re-fixes" the oauth columns later, reintroducing the false bug.** Mitigation: Phase C's clarifying comments + the positive DB-path assertion make the two-store split self-documenting and test-pinned.
- **Adding a flag for a test-only convenience reads as ceremony.** Mitigation: the flag gates a real behavior change (which tests *run* against a live DB locally); the pure test-truth fixes (B/C/D) correctly ship flagless, keeping the flag honest. The flag is documented only where dev shells read env (`CLAUDE.md`, `.env.example`), not in `docker-compose.yml`, so it never falsely implies the running container consumes it.

## Files Reference

| File | Change | Phase |
|---|---|---|
| `tests/frontend-api-layer.test.ts:815-816,1873-1874,2333-2335` | tenant-scope the 3 flat Stage-2/4 fixtures; preserve `:2333` source mismatch; do NOT touch `:1681` | B |
| `tests/auth/oauth-connect.test.ts:44,69,413,506` | clarifying comments on the `status`/`connection_status` two-store split + positive DB-path assertion; NO column change | C |
| `tests/onboarding-draft-route.test.ts:246-273` | add ECONNREFUSED⇒fallback branch alongside the existing 28P01⇒503 case | D |
| `tests/helpers/requires-infra.ts` | NEW — `requireDbEnvOrSkip(t)` shared guard (superset DB_* keys, canonical skip string) | E |
| `tests/publish-creative-asset-ids.test.ts:276`, `tests/scheduled-posts-worker-end-date.test.ts:145`, `tests/scheduled-posts-worker-live-db.test.ts:67`, `tests/hackathon-register.test.ts:97`, `tests/marketing/synthesize-publish-posts-live-db.test.ts:124,266,338`, `tests/marketing/dashboard-publish-items-counter.test.ts:146`, `tests/marketing/ingest-production-assets-live-db.test.ts:96` | adopt `requireDbEnvOrSkip` | E |
| `tests/REQUIRES_INFRA.md` | NEW — index of requires-infra files + env + run command | E |
| `scripts/list-requires-infra.mjs` | NEW — prints the self-contained/requires-infra split | E |
| `package.json` | NEW scripts `test:requires-infra-report`, `test:requires-infra` (flag-gated) | E |
| `CLAUDE.md`, `.env.example` | document `ARIES_TEST_REQUIRES_INFRA_ENABLED` (default OFF); **NOT** `docker-compose.yml` (test-only flag, never read by the running container) | E |
| `backend/marketing/jobs-status.ts:381-391` | READ-ONLY reference — the tenant-scoped primary read the fixtures must exercise | B |
| `backend/marketing/validated-profile-store.ts:198-201` | READ-ONLY reference — `recordMatchesCurrentSource` source-fingerprint gate | B |
| `backend/integrations/oauth-db.ts:4,10,107` | READ-ONLY reference — live Postgres column `status` | C |
| `backend/integrations/oauth-memory-store.ts:10` | READ-ONLY reference — in-memory column `connection_status` | C |
| `backend/onboarding/draft-store.ts:350-374` | READ-ONLY reference — fallback classifier (28P01 absent ⇒ non-fallback) | D |
| `backend/marketing/artifact-store.ts:65-75` | READ-ONLY reference — legacy flat-read fallback gate (do NOT enable in tests) | B |
| `.github/workflows/tests.yml:20-63` | READ-ONLY reference — the `full-suite` REQUIRED gate kept honestly green | F |
| `scripts/verify-regression-suite.mjs:158,161-172` | READ-ONLY reference — fast-suite membership + frontend-api-layer exclusion | F |

## Related

- `docs/plans/2026-05-30-test-suite-repair.md` — parent; Phases B–E landed. This plan is its verified, honest-completion follow-through.
- Roadmap area 1(a) — public trust blocker: "test suite clean OR clearly split requires-infra vs self-contained." This plan delivers both halves.
- CLAUDE.md guardrails honored: treat-as-production (no runtime change, zero blast radius), default-OFF flag for the one behavioral change (`ARIES_TEST_REQUIRES_INFRA_ENABLED`), full CI-exact `full-suite` before push, no autonomous publish touched, `MARKETING_STATUS_PUBLIC` not exposed.
