# Hermes-Native Aries Execution Migration Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move Aries runtime execution from OpenClaw/Lobster-owned contracts to Aries-owned interfaces backed by Hermes-compatible execution, without breaking marketing jobs, approval resumes, generated assets, Docker runtime, or live deployment.

**Architecture:** Introduce an Aries-owned execution boundary first, then adapt the existing OpenClaw/Lobster implementation behind it as the legacy adapter. Add a Hermes adapter only after the Aries contract, runtime envelopes, approval tokens, cancellation, and artifact contracts are pinned by tests. Keep current OpenClaw/Lobster paths working until Hermes parity is proven route-by-route.

**Tech Stack:** Next.js 16 route handlers, TypeScript service layer, Node `tsx --test`, Docker Compose, existing `lobster/` workflow scripts, Hermes Agent/gateway automation as the replacement execution target.

---

## Current verified state

- Repo: `/home/node/aries-app`
- Branch at inspection: `master`
- HEAD at inspection: `617647e fix(lobster): auto-repair truncated copy before validation gate (#238)`
- Remote: `git@github.com:DeliciousHouse/aries-app.git`
- Old OpenClaw checkout: `/home/node/openclaw` is absent
- Runtime Compose file: `/home/node/aries-app/docker-compose.yml`
- No source code was changed while preparing this plan, except this plan file.

---

## Dependency inventory and classification

### A. Execution gateway surface

| Surface | Evidence | Current role | Classification | Target |
|---|---|---|---|---|
| `backend/openclaw/gateway-client.ts` | Exports `runOpenClawLobsterWorkflow`, `resumeOpenClawLobsterWorkflow`, `cancelOpenClawLobsterWorkflow`, `OpenClawGatewayError`; calls `${OPENCLAW_GATEWAY_URL}/tools/invoke`; can run local `lobster` fallback | Main OpenClaw gateway client and local Lobster fallback | **Wrap first, then replace** | Move all callers to `backend/execution/*`; keep as `LegacyOpenClawExecutionAdapter` until Hermes parity passes |
| `backend/openclaw/aries-execution.ts` | Normalizes API args, reads Lobster cache dirs, maps gateway errors, delegates to `runOpenClawLobsterWorkflow` | Aries route workflow facade, but still OpenClaw-named | **Wrap first** | Rename conceptually to Aries execution service. Preserve behavior while moving imports away from OpenClaw paths |
| `backend/openclaw/workflow-catalog.ts` | Defines `ARIES_OPENCLAW_WORKFLOWS`, real marketing stage workflows and stub parity workflows | Workflow registry | **Wrap and rename** | Create Aries-owned registry with stable route/workflow ids; legacy adapter can still point to `.lobster` files |
| `app/api/*` route imports from `backend/openclaw/*` | `app/api/demo/route.ts`, `sandbox/launch`, `tenant/workflows`, `publish/*`, `calendar/sync`, `integrations/handlers.ts`, marketing job/review handlers | Browser-facing API coupled to OpenClaw types | **Replace imports with Aries-owned interface** | Routes import `backend/execution` and `backend/execution/errors`; no `openclaw` import in app routes |

### B. Marketing pipeline and approvals

| Surface | Evidence | Current role | Classification | Target |
|---|---|---|---|---|
| `backend/marketing/orchestrator.ts` | `MARKETING_PIPELINE_FILE = marketing-pipeline.lobster`, `runMarketingPipeline`, `resumeMarketingPipeline`, approval checkpoints, cancellation id | Canonical marketing job executor | **Keep behavior, wrap execution** | Route through `MarketingExecutionPort`; legacy OpenClaw adapter remains default until Hermes adapter supports run/resume/cancel/approval |
| `lobster/marketing-pipeline.lobster` | Monolithic brand campaign workflow | Current production marketing workflow | **Keep for now** | Treat as legacy implementation fixture. Do not delete until Hermes marketing pipeline reaches contract parity |
| `lobster/stage-*/*.lobster` | Atomic stage workflows for tenant workflow routes | Current stage-level execution | **Keep for now** | Migrate after monolithic pipeline wrapper, or explicitly deprecate stage routes if product no longer needs them |
| Approval resume tokens and state | `describeLobsterResumeToken`, compatibility key logic in gateway client; approval records in marketing orchestrator | Resumes paused review/publish approvals | **Wrap with compatibility tests** | Aries-owned opaque approval token descriptor. Legacy tokens keep working during migration |
| Marketing cache dirs | `LOBSTER_STAGE1_CACHE_DIR` to `LOBSTER_STAGE4_CACHE_DIR` across `aries-execution.ts`, `artifact-collector.ts`, `jobs-status.ts`, `dashboard-content.ts`, `publish-review.ts` | Artifact read model and handoff cache | **Keep, then generalize** | Rename internally to stage artifact stores after execution adapter exists. Do not rename env vars first |

### C. Generated asset and media gateway surface

| Surface | Evidence | Current role | Classification | Target |
|---|---|---|---|---|
| `backend/marketing/asset-library.ts`, `asset-read.ts`, `asset-ingest.ts`, `real-artifacts.ts`, `public-pages.ts`, `stage-artifact-resolution.ts`, `dashboard-content.ts` | Reads `OPENCLAW_LOBSTER_CWD`, `ARIES_LOBSTER_HOST_OUTPUT_*`, `LOBSTER_STAGE*_CACHE_DIR` | Reads generated assets and status artifacts | **Keep, then rename behind artifact service** | Create `backend/marketing/artifact-store.ts` as the Aries-owned API. The first implementation can still read Lobster paths |
| `lobster/bin/_openclaw_media_gateway.py`, `tests/lobster_media_gateway_test.py`, `scripts/smoke-openclaw-media-gateway.py` | Media generation gateway and tests | Image/video generation bridge | **Replace with Hermes media tool path later** | Define a media generation port before replacing. Keep tests until Hermes image/video generation returns equivalent artifacts |
| Docker bind mount `ARIES_LOBSTER_HOST_OUTPUT_DIR` and `ARIES_LOBSTER_HOST_OUTPUT_MOUNT` | `docker-compose.yml` lines 89-97 | Lets Aries container read host-created assets | **Keep until artifact store moves to shared Aries data root** | Future Hermes adapter should write to `/data` or a configured Aries artifact root directly |

### D. Docker, env, docs, and automation

| Surface | Evidence | Current role | Classification | Target |
|---|---|---|---|---|
| `docker-compose.yml` OpenClaw/Lobster env block | `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_*_CWD`, `LOBSTER_*`, media model vars | Production runtime configuration | **Keep initially, add new aliases** | Introduce `ARIES_EXECUTION_PROVIDER`, `HERMES_GATEWAY_URL`, `HERMES_GATEWAY_TOKEN` only after adapter tests exist |
| `README.md`, `SETUP.md`, `CLAUDE.md`, `DOCKER.md` references | Setup says OpenClaw is execution boundary | Operator docs | **Update after code boundary lands** | Document dual-provider mode first, then Hermes-primary mode |
| `scripts/automations/install-openclaw-crons.mjs` and automation scripts | OpenClaw-named cron installer | Autonomous ops wiring | **Deprecate/rename** | Replace with Hermes-native cron/webhook automation after runtime execution boundary is stable |
| `package.json` scripts `validate:openclaw-lobster`, `automation:install` | OpenClaw-specific validation names | Test and operator entry points | **Keep as compatibility aliases** | Add provider-neutral scripts, then keep old names until docs and CI stop using them |

### E. Tests

| Surface | Evidence | Current role | Classification | Target |
|---|---|---|---|---|
| `tests/marketing-gateway-logging.test.ts`, `tests/openclaw-lobster-gateway-availability.test.ts`, `tests/openclaw-marketing-workflows.test.ts`, `tests/marketing-local-dev-regression.test.ts` | Pin gateway behavior, fallback behavior, path normalization, availability | Regression protection for current runtime | **Keep, clone, then retire selectively** | Add provider-neutral execution tests first. Keep legacy tests under `openclaw` names while legacy adapter exists |
| Marketing flow tests | `tests/marketing-job-flow.test.ts`, `tests/marketing-flow-smoke.test.ts`, `tests/marketing-validated-runtime.test.ts`, etc. | User-facing contract tests | **Keep as primary safety net** | Run after every adapter change. These decide whether users see broken marketing jobs |
| Python Lobster tests | `lobster/tests/*` and `tests/lobster_media_gateway_test.py` | Script and media compatibility | **Keep until Hermes parity exists** | Add Hermes media adapter tests before deleting Lobster-specific tests |

---

## Migration principles

1. Do not delete `lobster/` first. That would break the only known-good execution backend.
2. Rename concepts at the Aries boundary before changing implementation. Users should see Aries/Hermes names before the old OpenClaw internals disappear.
3. Keep approval resume and cancel behavior exact. A campaign paused at strategy review must still resume after the migration.
4. Keep generated artifact paths readable. The UI depends on files created outside the web request path.
5. Use feature flags for provider selection. Default to legacy OpenClaw until Hermes has contract parity.
6. For runtime-affecting fixes, rebuild/redeploy the container and verify live behavior before calling the migration done.

---

## Proposed target architecture

```text
Browser / API client
  -> app/api/* route handlers
  -> backend/execution/index.ts
      -> ExecutionService
          -> WorkflowCatalog
          -> ExecutionProvider
              -> LegacyOpenClawExecutionAdapter
                  -> backend/openclaw/gateway-client.ts
                  -> lobster/*.lobster
              -> HermesExecutionAdapter
                  -> Hermes gateway/tool invocation
                  -> Aries artifact root under DATA_ROOT
  -> backend/marketing/orchestrator.ts
      -> MarketingExecutionPort
      -> MarketingArtifactStore
      -> ApprovalStore
```

The important move is the boundary. Once routes and marketing services talk to `ExecutionService`, OpenClaw becomes one adapter, not the app's identity.

---

## Implementation phases

### Phase 1: Create provider-neutral execution types

**Objective:** Add Aries-owned types without changing runtime behavior.

**Files:**
- Create: `backend/execution/types.ts`
- Create: `backend/execution/errors.ts`
- Create: `backend/execution/index.ts`
- Test: `tests/execution-provider-contract.test.ts`

**Steps:**
1. Write a failing test that imports `ExecutionError`, `WorkflowExecutionResult`, and `ExecutionProvider` from `backend/execution`.
2. Assert the error shape covers current mapped codes: not configured, unauthorized, unreachable, tool unavailable, request invalid, response invalid, server error.
3. Implement `ExecutionError` as a provider-neutral wrapper with `provider`, `code`, `message`, `status`, and optional `cause`.
4. Implement `WorkflowExecutionResult` union matching current `ok`, `not_implemented`, and `gateway_error` outcomes, but without OpenClaw names.
5. Export all new types from `backend/execution/index.ts`.
6. Run: `npx tsx --test tests/execution-provider-contract.test.ts`

Expected result: new provider-neutral types pass without touching existing routes.

### Phase 2: Wrap the legacy OpenClaw/Lobster adapter

**Objective:** Make current runtime available behind the new Aries execution interface.

**Files:**
- Create: `backend/execution/providers/legacy-openclaw.ts`
- Modify: `backend/execution/index.ts`
- Test: `tests/execution-legacy-openclaw-adapter.test.ts`

**Steps:**
1. Write tests with `globalThis.__ARIES_OPENCLAW_TEST_INVOKER__` proving legacy adapter calls the same payload shape as `runOpenClawLobsterWorkflow`.
2. Test run, resume, and cancel operations separately.
3. Implement `LegacyOpenClawExecutionAdapter` by delegating to `backend/openclaw/gateway-client.ts`.
4. Map `OpenClawGatewayError` to `ExecutionError` without losing `status` or `code`.
5. Keep existing `backend/openclaw/*` files unchanged.
6. Run: `npx tsx --test tests/execution-legacy-openclaw-adapter.test.ts tests/marketing-gateway-logging.test.ts`

Expected result: new adapter is a pass-through wrapper, and legacy gateway behavior remains pinned.

### Phase 3: Move workflow catalog to Aries-owned naming

**Objective:** Stop exposing `ARIES_OPENCLAW_WORKFLOWS` to route handlers.

**Files:**
- Create: `backend/execution/workflow-catalog.ts`
- Modify: `backend/openclaw/workflow-catalog.ts`
- Modify: `app/api/tenant/workflows/route.ts`
- Modify: `app/api/tenant/workflows/[workflowId]/runs/route.ts`
- Test: `tests/execution-workflow-catalog.test.ts`
- Keep: `tests/openclaw-marketing-workflows.test.ts` as compatibility coverage

**Steps:**
1. Write tests that provider-neutral workflow ids include every current key from `ARIES_OPENCLAW_WORKFLOWS`.
2. Add `ARIES_WORKFLOWS` and `ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS` in the new catalog.
3. Have the old OpenClaw catalog re-export from the new catalog or map to it, so old tests still pass.
4. Update tenant workflow routes to import from `backend/execution/workflow-catalog.ts`.
5. Run: `npx tsx --test tests/execution-workflow-catalog.test.ts tests/openclaw-marketing-workflows.test.ts tests/auth/workflow-route-tenant-context.test.ts`

Expected result: routes no longer import OpenClaw-named catalog symbols.

### Phase 4: Replace route-level OpenClaw imports

**Objective:** Browser-facing route handlers should not import `backend/openclaw/*`.

**Files:**
- Modify: `app/api/demo/route.ts`
- Modify: `app/api/sandbox/launch/route.ts`
- Modify: `app/api/calendar/sync/handler.ts`
- Modify: `app/api/publish/dispatch/handler.ts`
- Modify: `app/api/publish/retry/handler.ts`
- Modify: `app/api/integrations/handlers.ts`
- Modify: `app/api/onboarding/start/route.ts`
- Modify: `app/api/marketing/jobs/handler.ts`
- Modify: `app/api/marketing/jobs/[jobId]/approve/handler.ts`
- Modify: `app/api/marketing/jobs/[jobId]/delete/handler.ts`
- Modify: `app/api/marketing/reviews/[reviewId]/decision/route.ts`
- Test: existing affected route tests

**Steps:**
1. Add provider-neutral helper functions: `runAriesWorkflow`, `mapExecutionError`, `cancelAriesWorkflow`.
2. Update one low-risk route first, `app/api/demo/route.ts`, and run its tests.
3. Update publish/calendar/integrations routes.
4. Update onboarding route.
5. Update marketing routes last because approvals and cancellation are higher risk.
6. Verify no app route imports `backend/openclaw`:
   `rg "backend/openclaw|openclaw/" app backend/marketing --glob '*.ts'`
7. Run targeted tests:
   `npx tsx --test tests/frontend-api-layer.test.ts tests/onboarding-runtime-cutover.test.ts tests/marketing-jobs-not-found.test.ts tests/marketing-job-flow.test.ts`

Expected result: OpenClaw coupling is below the execution adapter boundary only.

### Phase 5: Add provider selection with legacy default

**Objective:** Allow Aries to choose `legacy-openclaw` or `hermes` without changing callers.

**Files:**
- Create: `backend/execution/provider-factory.ts`
- Modify: `backend/execution/index.ts`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Test: `tests/execution-provider-selection.test.ts`

**Steps:**
1. Write tests for `ARIES_EXECUTION_PROVIDER` defaulting to `legacy-openclaw`.
2. Test explicit `ARIES_EXECUTION_PROVIDER=legacy-openclaw`.
3. Test `ARIES_EXECUTION_PROVIDER=hermes` returns a not-yet-configured Hermes adapter with a clear `ExecutionError`.
4. Add env vars but do not require them yet:
   - `ARIES_EXECUTION_PROVIDER`
   - `HERMES_GATEWAY_URL`
   - `HERMES_GATEWAY_TOKEN`
   - `HERMES_SESSION_KEY`
5. Run: `npx tsx --test tests/execution-provider-selection.test.ts tests/deploy-manifest-parity.test.ts`

Expected result: no production behavior changes. The new knobs exist but legacy stays default.

### Phase 6: Introduce a stub Hermes adapter

**Objective:** Make Hermes support explicit and testable before real runtime calls.

**Files:**
- Create: `backend/execution/providers/hermes.ts`
- Test: `tests/execution-hermes-adapter.test.ts`

**Steps:**
1. Write tests that missing `HERMES_GATEWAY_URL` and `HERMES_GATEWAY_TOKEN` produce actionable `ExecutionError` messages.
2. Define the Hermes request envelope in code comments and tests:
   - workflow id
   - args JSON
   - cwd or workspace root if needed
   - timeout/max output
   - approval resume token
   - cancel correlation id
3. Implement the adapter as a clear `not_configured` or `not_implemented` response, not a silent fallback.
4. Run: `npx tsx --test tests/execution-hermes-adapter.test.ts tests/execution-provider-selection.test.ts`

Expected result: operators can select Hermes and get honest errors instead of hidden OpenClaw fallback.

### Phase 7: Generalize marketing artifact reads

**Objective:** Create an Aries-owned artifact store while preserving current Lobster cache compatibility.

**Files:**
- Create: `backend/marketing/artifact-store.ts`
- Modify: `backend/marketing/asset-library.ts`
- Modify: `backend/marketing/asset-read.ts`
- Modify: `backend/marketing/real-artifacts.ts`
- Modify: `backend/marketing/public-pages.ts`
- Modify: `backend/marketing/stage-artifact-resolution.ts`
- Modify: `backend/marketing/dashboard-content.ts`
- Test: `tests/marketing-artifact-store.test.ts`
- Existing tests: `tests/asset-ingest.test.ts`, `tests/video-artifact-collector.test.ts`, `tests/marketing-jobs-cache.test.ts`

**Steps:**
1. Write tests that the artifact store resolves all current `LOBSTER_STAGE*_CACHE_DIR` paths and `/host-lobster-output` paths exactly as today.
2. Add neutral names in the artifact store API: `stageCacheRoot(stage)`, `hostOutputMount()`, `resolveGeneratedAsset(path)`.
3. Replace direct env reads in one file at a time.
4. Keep env var names unchanged in this phase.
5. Run: `npx tsx --test tests/marketing-artifact-store.test.ts tests/asset-ingest.test.ts tests/video-artifact-collector.test.ts tests/marketing-jobs-cache.test.ts`

Expected result: asset reading has an Aries-owned boundary, but generated content is still found.

### Phase 8: Wire real Hermes execution for one non-critical workflow

**Objective:** Prove real Hermes invocation on a low-risk route before marketing.

**Files:**
- Modify: `backend/execution/providers/hermes.ts`
- Test: `tests/execution-hermes-adapter.test.ts`
- Pick one route after inspection: `demo_start`, `calendar_sync`, or another stub/parity workflow

**Steps:**
1. Pick a route that does not create paid media, publish ads, or mutate customer marketing state.
2. Define the Hermes tool endpoint contract in the adapter test using a mocked `fetch`.
3. Implement Hermes run for that one workflow.
4. Keep resume/cancel unsupported unless the selected workflow needs them.
5. Run: `npx tsx --test tests/execution-hermes-adapter.test.ts tests/frontend-api-layer.test.ts`
6. If this changes runtime behavior, rebuild/redeploy a test container before touching production defaults.

Expected result: Hermes can execute at least one Aries workflow through the same `ExecutionService` interface.

### Phase 9: Migrate marketing run/resume/cancel behind a feature flag

**Objective:** Support Hermes for the full marketing pipeline without making it default.

**Files:**
- Modify: `backend/marketing/orchestrator.ts`
- Modify: `backend/execution/providers/hermes.ts`
- Test: `tests/marketing-job-flow.test.ts`
- Test: `tests/marketing-flow-smoke.test.ts`
- Test: `tests/marketing-approval-persistence.test.ts`
- Test: `tests/review-decision-idempotency.test.ts`

**Steps:**
1. Add a `MarketingExecutionPort` interface with run/resume/cancel methods.
2. Keep legacy OpenClaw implementation as default.
3. Add Hermes implementation only behind `ARIES_MARKETING_EXECUTION_PROVIDER=hermes` or the global provider flag, whichever the team chooses in Phase 5.
4. Mock Hermes run responses for:
   - completed research
   - strategy approval required
   - production approval required
   - publish paused approval required
   - resume approved
   - resume denied
   - cancel requested
5. Run targeted tests:
   `npx tsx --test tests/marketing-job-flow.test.ts tests/marketing-flow-smoke.test.ts tests/marketing-approval-persistence.test.ts tests/review-decision-idempotency.test.ts`

Expected result: Hermes marketing behavior can be tested without switching production.

### Phase 10: Operator docs and compatibility aliases

**Objective:** Update docs to describe Aries/Hermes as the intended direction while preserving legacy fallback instructions.

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `DOCKER.md`
- Modify: `CLAUDE.md`
- Modify: `package.json`
- Test: docs anchor tests and banned patterns

**Steps:**
1. Add docs for `ARIES_EXECUTION_PROVIDER=legacy-openclaw|hermes`.
2. Keep OpenClaw setup under a Legacy provider section.
3. Add neutral validation script names while keeping old aliases:
   - `validate:execution-provider`
   - `validate:legacy-openclaw-lobster`
4. Rename `automation:install` target or add `automation:install:legacy-openclaw` and a Hermes replacement.
5. Run:
   `npx tsx --test tests/route-metadata-and-docs-anchors.regression-015.test.ts tests/deploy-manifest-parity.test.ts`
   `node scripts/check-banned-patterns.mjs`

Expected result: docs tell the truth about the new architecture, without stranding current operators.

### Phase 11: Switch default only after live parity

**Objective:** Make Hermes primary after evidence, not hope.

**Prerequisites:**
- Provider-neutral route imports complete.
- Artifact store boundary complete.
- Hermes adapter supports run/resume/cancel for marketing.
- Live smoke proves one complete marketing job can run through Hermes in a staging or controlled environment.

**Steps:**
1. Run full targeted suite:
   `npx tsx --test tests/execution-*.test.ts tests/marketing-job-flow.test.ts tests/marketing-flow-smoke.test.ts tests/marketing-validated-runtime.test.ts tests/openclaw-lobster-gateway-availability.test.ts`
2. Run final repo gate:
   `npm run workspace:verify`
3. Create a PR. Do not push direct to master.
4. Wait for review/CI feedback.
5. Merge only after CI and review are clean.
6. Rebuild/redeploy the container.
7. Verify live behavior on `aries.sugarandleather.com`:
   - app loads
   - `/marketing/new-job` loads
   - can start a safe test campaign or exercise a mocked/sandboxed workflow
   - approval state renders
   - logs show Hermes provider when selected
   - no OpenClaw provider call happens in Hermes mode

Expected result: Hermes becomes primary only when it works live.

---

## Test plan

### Fast per-phase commands

```bash
npx tsx --test tests/execution-provider-contract.test.ts
npx tsx --test tests/execution-legacy-openclaw-adapter.test.ts tests/marketing-gateway-logging.test.ts
npx tsx --test tests/execution-workflow-catalog.test.ts tests/openclaw-marketing-workflows.test.ts
npx tsx --test tests/execution-provider-selection.test.ts tests/deploy-manifest-parity.test.ts
npx tsx --test tests/execution-hermes-adapter.test.ts
npx tsx --test tests/marketing-artifact-store.test.ts tests/asset-ingest.test.ts tests/video-artifact-collector.test.ts tests/marketing-jobs-cache.test.ts
npx tsx --test tests/marketing-job-flow.test.ts tests/marketing-flow-smoke.test.ts tests/marketing-approval-persistence.test.ts tests/review-decision-idempotency.test.ts
```

### Final local gates

```bash
npm run workspace:verify
npm run typecheck
node scripts/check-banned-patterns.mjs
```

### Live deployment gate

Only after code changes that affect runtime execution:

```bash
docker compose --env-file .env -f docker-compose.yml up --build -d aries-app
# or use the existing GitHub Actions deploy path for production PR merge
```

Then verify `aries.sugarandleather.com` and runtime logs before calling the task done.

---

## Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Approval tokens break mid-campaign | Users can get stuck at strategy/production/publish approval | Keep token descriptor compatibility tests before adapter migration |
| Generated assets disappear | Marketing dashboard can show empty output after successful workflow | Artifact store tests must cover old Lobster cache dirs and host output mount |
| Hermes adapter silently falls back to OpenClaw | False confidence, migration only looks done | Provider selection tests must assert selected provider in logs/responses |
| Renaming env vars breaks deploy | Live container depends on current `.env` | Add aliases first, remove old names only in a later PR |
| Local `lobster` fallback masks gateway failure | Tests can pass while production dependency remains | Disable fallback for marketing as today; add explicit provider assertions |
| Stage workflows and monolithic pipeline diverge | Tenant workflow routes may pass while marketing jobs fail, or vice versa | Test both `tests/openclaw-marketing-workflows.test.ts` and marketing job flow tests |

---

## NOT in scope for the first implementation PR

- Deleting the `lobster/` directory.
- Removing all `OPENCLAW_*` and `LOBSTER_*` env vars.
- Making Hermes the production default.
- Rewriting the marketing pipeline logic in one large PR.
- Changing UI design or campaign UX.
- Changing Meta publishing behavior.

Those are later PRs after the Aries-owned boundary and Hermes adapter prove parity.

---

## Suggested PR slicing

1. PR 1: Provider-neutral execution types and legacy OpenClaw adapter.
2. PR 2: Workflow catalog rename and route import migration.
3. PR 3: Provider selection plus stub Hermes adapter.
4. PR 4: Marketing artifact store boundary.
5. PR 5: First real Hermes workflow.
6. PR 6: Hermes marketing run/resume/cancel behind feature flag.
7. PR 7: Docs, scripts, and deployment default switch after live parity.

Small PRs matter here. This is runtime execution, approvals, and generated assets. A single giant refactor would be a great way to spend Saturday debugging a campaign that disappeared into a path alias.

---

## Open decisions before implementation

1. Hermes invocation contract: Should Aries call Hermes through the existing gateway HTTP API, a Hermes CLI, or a dedicated Hermes MCP/tool endpoint?
2. Artifact root: Should Hermes write generated assets directly under `DATA_ROOT`, or should it preserve the current `lobster/output` layout for one release?
3. Marketing migration order: migrate monolithic `marketing-pipeline.lobster` first, or migrate the atomic stage routes first?

Recommended defaults:
- Use HTTP gateway/tool invocation first. It mirrors the current OpenClaw Gateway model and minimizes route changes.
- Preserve current artifact layout for one release, then move to `DATA_ROOT` after UI tests pass.
- Migrate one low-risk non-marketing workflow first, then monolithic marketing pipeline, then atomic stage routes.
