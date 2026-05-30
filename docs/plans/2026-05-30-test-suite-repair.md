# Test-suite repair — turn the REQUIRED full-suite gate green

**Status:** Open for a builder to pick up.
**Author:** Staff eng, 2026-05-30.
**Epic:** Repair the remaining red tests so the REQUIRED `full-suite` gate on `master` is green.
**Related:**
- `TODOS.md` → top "Ship" section (the four P0 triage items; this plan covers three of them).
- `#513` child A owns `tests/auth/integrations-tenant-context.test.ts` — **explicitly out of scope here.**
- `.github/workflows/tests.yml:50-63` — the `full-suite` job that must go green.

---

## Context

`full-suite` is now a REQUIRED status check on `master` (memory: *test-suite rot + gate gap*, shipped #505/#507). CI runs every `tests/**/*.test.ts` at `--test-concurrency=1` against a per-runner `DATA_ROOT` (`.github/workflows/tests.yml:60-63`). Until that job is reliably green, every PR is noisy and real regressions hide behind unrelated red.

The TODOS.md triage was written **2026-04-23** and last retriaged **2026-05-23**. Since then, repair PRs landed: `#432` (OAuth/integrations aligned to Postgres handlers), `#433` (brand-profile contract ported off deleted python), `#434` (frontend-api-layer unstuck), and `#502` ("repair 63 rotted tests + 2 product edge cases (full suite green)"). **The working tree already reflects those rewrites.** This plan's primary job is therefore *verification* — confirm the five EPIC-named files actually pass on a clean runner — plus closing a small set of residual-risk seams that the triage text predates and that a clean-room CI run could still surface.

This is deliberately scoped. We are not re-architecting the test harness; we are driving one specific gate from "assumed green" to "verified green," and fixing whatever the verification turns up.

## Who cares

- **Every engineer** opening a PR — a red base gate trains people to ignore CI, which is how the rot started (memory: *test-suite rot + gate gap*).
- **Marketing pipeline owners** — `frontend-api-layer.test.ts` is the contract test for the customer-facing campaign workspace hydration (brand/strategy/creative/publish review). It is the single largest signal we have that the dashboard renders truthful data.
- **Auth/integrations owners** — `oauth-connect.test.ts` guards the Meta OAuth connect/disconnect/reconnect/callback flows.

## Decisions (locked, do not re-litigate)

1. **`tests/auth/integrations-tenant-context.test.ts` is OUT.** It is owned by `#513` child A. Do not touch it, do not assert on it, do not duplicate its fixes here. If it is red, that is #513's problem.
2. **The test rewrites are the source of truth, not TODOS.md.** Where the triage text and the current test file disagree (and they do — see Current State), the file wins. Do not "re-fix" a file that already uses the new seam.
3. **No production behavior changes to make a test pass.** If a test asserts the wrong thing, fix the test. If a test catches a real product bug, that is a *separate* finding to be raised, not silently patched into green. (#502 already did this dance for "2 product edge cases" — do not regress those.)
4. **Verify on a clean runner profile.** Local "passes for me" is not acceptance. Acceptance is the exact CI invocation: `find tests -name '*.test.ts' | sort` piped to `tsx --test --test-concurrency=1`, with `APP_BASE_URL` and a per-run `DATA_ROOT` set. Test-ordering pollution is a known failure mode in this repo (the 2026-05-23 retriage found `auth-tenant-membership` / `oauth-callback-runtime` only failed *in suite*), so isolated passes do not count.
5. **No new node_modules-coupled or Postgres-coupled tests.** The harness must stay self-contained: mock `pool.query`, set required env via the file's `with*Env` helper, write fixtures under a per-test `mkdtemp` `DATA_ROOT`.

## Current State (VERIFIED — file:line)

All five EPIC-named files were read at `HEAD` (`b08a80a`). Working tree is clean.

**The marketing XL item — already migrated:**
- `tests/marketing-validated-runtime.test.ts:158` and `tests/marketing-brand-identity-parity.test.ts:194` import `tenantBrandProfilePath` / `tenantBusinessProfilePath` from `backend/marketing/validated-profile-store` and write fixtures directly. Both files still *define* a `runScript()` helper (`marketing-validated-runtime.test.ts:54`, `marketing-brand-identity-parity.test.ts:71`) that shells `python3 lobster/bin/<script>` — but **it is never called** (verified: zero `runScript(` invocations). It is dead code left over from the port.
- The store functions all exist: `validated-profile-store.ts:97` (`tenantBrandProfilePath`), `:105` (`tenantBusinessProfilePath`), `:186` (`loadValidatedMarketingProfileDocs`), `:247` (`loadValidatedMarketingProfileSnapshot`). `backend/tenant/business-profile.ts:716` (`getBusinessProfile`) exists.
- `tests/frontend-api-layer.test.ts:9` imports `__setMarketingExecutionPortForTests` (exists at `orchestrator.ts:1407`); the legacy `__ARIES_EXECUTION_TEST_INVOKER__` seam is gone. `setExecutionTestInvoker` (`:14-106`) is an adapter that wraps a `MarketingExecutionPort` mock and translates the old `{ args: { action } }` shape, so per-test bodies did not need rewriting.

**Residual risk inside `frontend-api-layer.test.ts` (the part to actually verify/fix):** the artifact-path layout is **inconsistent across fixtures**. Production reads default to tenant-scoped `<cacheRoot>/<tenantId>/<runId>/<step>.json` (`backend/marketing/artifact-store.ts:41-63`, `stageCacheRootForTenant`) and only fall back to the legacy `<cacheRoot>/<runId>/` layout when `ARIES_STAGE_CACHE_LEGACY_READ_FALLBACK=1` (`artifact-store.ts:73-75`). That env flag is **never set** in the test file. Yet some fixtures write tenant-scoped (`:2137-2140`, `:2517`, `:2874-2876` use `.../<tenantId>/<stage2RunId>/...`) while others write *flat* (`:815-816` test "blocks downstream approval metadata", `:1681-1682` test "prefers richer compiled Stage 4 bundles", `:1873-1874` test "keeps fresher runtime review fields", `:2333-2335` test "does not leak stale strategy review"). The flat ones only pass if that specific hydration path tolerates the legacy layout; this is the seam most likely to be red on a clean runner and is the verification's first suspect.

**Source-fingerprint gating (verified mechanic):** `loadValidatedMarketingProfileDocs` nulls out any doc whose source URL does not match `options.currentSourceUrl` (`validated-profile-store.ts:198-201`, `recordMatchesCurrentSource`). The fixtures set the runtime doc's `inputs.brand_url` to `https://<tenantId>.example.com` (`frontend-api-layer.test.ts:451`, `:775`) and the brand-kit `source_url`/`canonical_url` to the same host. A fixture whose brand-profile `website_url` drifts from the runtime `brand_url` will silently hydrate `null` and fail the review assertions.

**The auth item — already migrated:**
- `tests/auth/oauth-connect.test.ts:14` declares `META_ENV_KEYS = ['META_APP_ID','META_APP_SECRET','OAUTH_TOKEN_ENCRYPTION_KEY']` and sets all three in `withMetaEnv` (`:21-23`). Tenant IDs are numeric strings (`'1'`/`'2'`, e.g. `:291`, `:337`, `:397`). A full SQL mock (`makeQueryMock`, `:85-178`) serves `dbGetConnection` (`WHERE tenant_id = $1 AND provider = $2`), `dbGetConnectionById` (`WHERE id = $1`), upsert/insert/pending-state/audit, and throws on unhandled SQL.
- `seedConnectedProvider` (`:44-61`) still seeds the in-memory `oauthStore()`, and the disconnect/reconnect assertions read back from `oauthStore().connectionsById` (`:413`, `:506`). So the tests are a **hybrid**: `pool.query` is mocked for the read/lookup path, while the in-memory store is used for the post-mutation assertion. The note that worked-row uses `connection_status` (`:56`) but the SQL-mock synthetic row uses `status` (`:122-123`) is the kind of column-name drift that can make tests 5/7/8 (disconnect/reconnect) flaky — verify these specifically.

**The infra item — already migrated:**
- `tests/onboarding-draft-route.test.ts:246` is the rewritten test 3 exactly as triage prescribed: it re-sets `DB_HOST/USER/PASSWORD/NAME` inside `withDraftEnv` (`:256-259`, because the helper deletes them at `:148-151`), injects a non-network `28P01` error via `installDbMock` (`:261-264`), and asserts `503` + `error: 'onboarding_draft_unavailable'` + redaction of `password authentication failed|aries_user|28P01` (`:270-272`). `tests/onboarding-draft-store.test.ts` and `tests/password-reset.test.ts` already pass per the 2026-05-23 retriage.

**The gate itself:** `.github/workflows/tests.yml:60` exports `DATA_ROOT="${RUNNER_TEMP}/aries-data"`, `:61` globs all `tests/**/*.test.ts`, `:63` runs `tsx --test --test-concurrency=1`. `scripts/verify-regression-suite.mjs:150-161` already lists `onboarding-draft-route`, `oauth-connect`, and `marketing-validated-runtime` in the fast suite, and flags `frontend-api-layer.test.ts` as `~70s; needs split`.

## Architecture (data flow under test)

```
  full-suite CI job (tests.yml:60-63)
    DATA_ROOT=$RUNNER_TEMP/aries-data   APP_BASE_URL=https://aries.example.com
    tsx --test --test-concurrency=1  tests/**/*.test.ts
        |
        +-- frontend-api-layer.test.ts ----------------------------+
        |     setExecutionTestInvoker -> __setMarketingExecutionPortForTests
        |        (MarketingExecutionPort mock; orchestrator.ts:1407)
        |     fixtures: <DATA_ROOT>/generated/{draft,validated}/<tenantId>/...
        |               ARTIFACT_STAGEn_CACHE_DIR/<tenantId>/<runId>/<step>.json   <-- tenant-scoped
        |        v                                                  |
        |   route handlers -> backend/marketing/jobs-status, artifact-store,
        |        validated-profile-store (source-fingerprint gate :198-201)
        |
        +-- oauth-connect.test.ts ---------------------------------+
        |     withMetaEnv (META_APP_ID/SECRET, OAUTH_TOKEN_ENCRYPTION_KEY)
        |     t.mock.method(pool,'query', makeQueryMock(rows))  +  oauthStore() seed
        |        v
        |   app/api/internal/integrations/* handlers -> oauthDb (dbGetConnection/...)
        |
        +-- onboarding-draft-route.test.ts ------------------------+
        |     withDraftEnv (DB_* set) + installDbMock(throw 28P01)
        |        v
        |   app/api/onboarding/draft/route -> backend/onboarding/draft-store
        |        (network errs -> DATA_ROOT fallback; non-network -> 503 redacted)
        |
        +-- marketing-validated-runtime.test.ts ------------------+
        +-- marketing-brand-identity-parity.test.ts --------------+
              fixtures written directly to validated-profile-store paths;
              assertions via loadValidatedMarketingProfileSnapshot + getBusinessProfile
              (NO python subprocess; runScript() helper is dead code)
```

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Depends on |
|---|---|---|---|---|
| A | Establish the clean-room baseline: run the exact CI invocation, capture the real red set | P0 | 0.5d / 20m | none |
| B | Marketing hydration: fix tenant-scoped artifact-path + source-fingerprint fixture drift in `frontend-api-layer.test.ts` | P0 | 1.5d / 1.5h | A |
| C | Marketing contract: confirm validated-runtime + brand-identity-parity green; delete dead `runScript()` helper | P0 | 0.5d / 30m | A |
| D | Auth: confirm oauth-connect green; fix `status`/`connection_status` column drift + any 503/404/ECONNREFUSED residue (tests 5/7/8/10) | P0 | 1d / 1h | A |
| E | Infra: confirm onboarding-draft-route test 3 green on clean `DATA_ROOT` | P0 | 0.25d / 15m | A |
| F | Lock it in: full clean-room re-run, confirm `full-suite` green, no `integrations-tenant-context` regressions attributed here | P0 | 0.5d / 30m | B,C,D,E |

### Phase A — Clean-room baseline (do this first, do not skip)

**Implementation.** Reproduce CI exactly. From repo root:
```bash
NODE_ENV=development npm ci                       # worktree has NO node_modules — required
export DATA_ROOT="$(mktemp -d)/aries-data"
export APP_BASE_URL=https://aries.example.com
mapfile -t TEST_FILES < <(find tests -name '*.test.ts' | sort)
npx --no-install tsx --test --test-concurrency=1 "${TEST_FILES[@]}" 2>&1 | tee /tmp/full-suite.log
```
Then extract the actual failing files and test names (`grep -E '^(not ok|# fail)' /tmp/full-suite.log`). **This is the real worklist.** Triage each failure into: (1) one of the four in-scope files, (2) `integrations-tenant-context` (hand to #513, do not touch), (3) a new/unexpected red (escalate before fixing). Run each in-scope failing file *also* in isolation to detect ordering pollution vs. a real defect.

**Acceptance.** A written red-set: file → test name → category (B/C/D/E / out / new). If the in-scope files already pass clean, Phases B–E collapse to "confirmed green, no change" and you proceed straight to F. The plan must survive both outcomes.

### Phase B — Marketing hydration artifact-path + fingerprint drift

**Implementation.** For each `frontend-api-layer.test.ts` failure from Phase A in the hydration group, the fix is fixture-side, not product-side:
- **Tenant-scope the flat fixtures.** Rewrite the flat artifact writes (`:815-816`, `:1681-1682`, `:1873-1874`, `:2333-2335`) to insert the `tenantId` segment: `path.join(process.env.ARTIFACT_STAGE2_CACHE_DIR!, tenantId, stage2RunId, 'campaign_planner.json')`, matching the tenant-scoped fixtures at `:2137-2140`. Mirror the surrounding `mkdir(path.dirname(...), { recursive: true })`. Do **not** instead set `ARIES_STAGE_CACHE_LEGACY_READ_FALLBACK=1` — the legacy layout is a deprecated read path (`artifact-store.ts:65-75`, scheduled for removal), and tests should assert the layout production writes today.
- **Align brand_url fingerprints.** Where a review hydrates `null` unexpectedly, confirm the fixture brand-profile / website-analysis `website_url` matches the runtime doc `inputs.brand_url` (`:451`, `:775`) so `recordMatchesCurrentSource` (`validated-profile-store.ts:198-201`) does not null the doc. Fix the fixture, not the gate.
- **Copy/window/voice drift (triage's tests 6/9/29).** If any assertion fails on a literal string (eyebrow/heading/voice label), check whether shipped copy moved (precedent: `campaign-workspace.tsx` `eyebrow` `Checkpoint`→`Review`). If the copy is correct and the test is stale, update the assertion; if the copy regressed, raise it as a product finding per Decision 3.

**Acceptance.** Every `frontend-api-layer.test.ts` test passes in isolation **and** in the full sorted suite. No `ARIES_STAGE_CACHE_LEGACY_READ_FALLBACK` was introduced. Diff is fixtures/assertions only — zero edits under `backend/` or `app/`.

### Phase C — Marketing contract files

**Implementation.** These already import the TS store directly and reference only existing exports, so the expectation is "already green." Confirm via Phase A. Then remove the dead `runScript()` helper in both files (`marketing-validated-runtime.test.ts:54-80`, `marketing-brand-identity-parity.test.ts:71-...`) and its now-unused imports (`spawnSync` from `node:child_process`) — leaving a python-subprocess helper in a file that no longer calls python is a rot trap and a misleading signal to the next reader. If Phase A shows a real failure (e.g. a snapshot field the store does not populate), fix the fixture to match the verified store output shape (`ValidatedMarketingProfileSnapshot`, `validated-profile-store.ts:216-239`).

**Acceptance.** Both files green in suite. `grep -rn 'lobster/bin\|spawnSync.*python' tests/marketing-*.test.ts` returns nothing. No new python dependency.

### Phase D — Auth oauth-connect

**Implementation.** Confirm via Phase A. For any residual red:
- **Column drift (tests 5/7/8 — disconnect/reconnect).** The worked seed row uses `connection_status` (`:56`) and the post-mutation assertion reads `oauthStore().connectionsById.get(...).connection_status` (`:413`, `:506`), but `makeQueryMock`'s synthetic upsert row returns `status` (`:122-123`). Make the mock's row shape match the column the handler + store actually use (check `backend/integrations/oauth-db.ts` / the connect handler for whether the live column is `connection_status` or `status`, then make the mock consistent). Fix the mock, not the schema.
- **Callback ECONNREFUSED (test 10).** Ensure the callback-flow test mocks both `pool.query` (for `dbGetPendingState`) and `globalThis.fetch` (token exchange, `:609`) so no real socket is opened. The pending-state lookup currently returns empty (`:160-164`); a callback test that needs a hit must seed it through the mock, not the DB.
- **503/404 (tests 5/7/8).** These resolve once the mock serves the right rows for the disconnect/reconnect lookups (`dbGetConnectionById`, `:99-104`) with numeric tenant IDs.

**Acceptance.** All 10 tests in `oauth-connect.test.ts` pass in suite. No real Postgres socket or outbound HTTP is opened (verify the unhandled-SQL `throw` at `:177` is never hit and no `ECONNREFUSED` appears in the log). `integrations-tenant-context.test.ts` is untouched.

### Phase E — Infra onboarding-draft-route test 3

**Implementation.** Confirm via Phase A. The test (`:246-273`) is already shaped correctly. The only clean-runner risk is the `DATA_ROOT` fallback: when CI sets `DATA_ROOT=$RUNNER_TEMP/aries-data`, the draft store's network-error fallback path writes there — but test 3 injects a **non-network** `28P01` error, which must bypass the fallback and surface 503 (`backend/onboarding/draft-store.ts` `shouldUseFallbackDraftStore`). Verify `shouldUseFallbackDraftStore` treats `28P01` as non-recoverable (does not match `ECONNREFUSED`/`ENOTFOUND`). If it falls through to the fallback and returns 200, that is a real product bug in the error classifier — raise it (Decision 3) rather than weakening the test.

**Acceptance.** `onboarding-draft-route.test.ts` all tests pass in suite with `DATA_ROOT` set to a writable temp dir (mirroring CI). No `ECONNREFUSED` in the log for this file.

### Phase F — Lock it in

**Implementation.** Re-run the exact Phase A invocation on a clean `DATA_ROOT`. Confirm zero failures attributable to B/C/D/E. Run `npm run verify` (the fast gate the pre-push hook expects) and `npm run lint`. Open the PR; the `full-suite` required check is the real acceptance.

**Acceptance.** `full-suite` green on the PR. If `integrations-tenant-context` is still red, the PR body states it explicitly and attributes it to #513 (it must not be made worse by this work).

## Testing Plan (fixture-primary)

| Layer | What | How | Gate |
|---|---|---|---|
| Marketing hydration | brand/strategy/creative/publish review hydration from tenant-scoped artifacts | `frontend-api-layer.test.ts` fixtures under per-test `mkdtemp` DATA_ROOT + `__setMarketingExecutionPortForTests` mock | full-suite |
| Marketing contract | validated-store path layout + snapshot precedence + business-profile sync | `marketing-validated-runtime.test.ts`, `marketing-brand-identity-parity.test.ts` direct-store fixtures (no subprocess) | full-suite |
| Auth | OAuth connect/disconnect/reconnect/callback with Postgres-backed handlers | `oauth-connect.test.ts` `t.mock.method(pool,'query', makeQueryMock)` + `withMetaEnv` + numeric tenant IDs | full-suite |
| Infra | draft route 503 redaction on non-network DB error | `onboarding-draft-route.test.ts` `installDbMock` throwing `28P01`, DB env kept set | full-suite, fast verify |
| Ordering | no cross-file pollution | each in-scope file run isolated AND in the full sorted glob | Phase A + F |
| Boundary | no python subprocess, no real socket, no real HTTP | grep for `lobster/bin`/`spawnSync python`; assert unhandled-SQL throw never fires | Phase C/D |

Fixtures are primary: every assertion is driven by JSON written to a per-test `mkdtemp` DATA_ROOT or by an in-memory mock; nothing touches a live Postgres or the network. This matches CLAUDE.md guardrail #1 (no DB fan-out) trivially — the suite makes zero real DB calls — and the resumability rule is not in play (no stage execution is run for real).

## Rollback

Pure test-and-fixture changes plus (Phase C) dead-helper deletion. Revert the PR to restore the prior state; no migration, no runtime behavior, no env-var, no schema change ships. If a fixture fix accidentally masks a real regression, the offending test reverts independently. There is no production blast radius.

## Out of Scope

- `tests/auth/integrations-tenant-context.test.ts` — **owned by #513 child A.** Not touched here.
- Splitting the ~70s `frontend-api-layer.test.ts` for speed (`verify-regression-suite.mjs:150` "needs split") — separate perf task, not a correctness fix.
- Any production code change to make a test pass (Decision 3). Real product bugs surfaced during verification are raised as separate findings, not patched into green.
- Re-architecting the test harness, adding Jest/Vitest, or introducing a Postgres test container.
- The Honcho write-path test files and the four P0→P3 Honcho backlog items in TODOS.md — unrelated workstream.
- CI matrix / node-version changes (#507 already moved CI to node 24).

## Files Reference

| File | Role |
|---|---|
| `.github/workflows/tests.yml:50-63` | The `full-suite` REQUIRED gate; canonical invocation to reproduce |
| `tests/frontend-api-layer.test.ts` | XL hydration contract; flat-vs-tenant-scoped fixture drift at `:815`,`:1681`,`:1873`,`:2333` (Phase B) |
| `tests/marketing-validated-runtime.test.ts` | Direct-store contract; dead `runScript()` at `:54` (Phase C) |
| `tests/marketing-brand-identity-parity.test.ts` | Direct-store parity; dead `runScript()` at `:71` (Phase C) |
| `tests/auth/oauth-connect.test.ts` | OAuth flows; `makeQueryMock` `:85`, column drift `:56`/`:122` (Phase D) |
| `tests/onboarding-draft-route.test.ts` | Draft 503 redaction test 3 at `:246` (Phase E) |
| `backend/marketing/validated-profile-store.ts` | `tenantBrandProfilePath:97`, snapshot `:247`, fingerprint gate `:198-201` |
| `backend/marketing/artifact-store.ts` | `stageCacheRootForTenant:52`, legacy-read gate `:73` |
| `backend/marketing/orchestrator.ts` | `__setMarketingExecutionPortForTests:1407` (test seam) |
| `backend/tenant/business-profile.ts` | `getBusinessProfile:716` |
| `backend/onboarding/draft-store.ts` | `shouldUseFallbackDraftStore` (network-vs-non-network classifier; Phase E) |
| `scripts/verify-regression-suite.mjs:150-161` | Fast suite membership for these files |
