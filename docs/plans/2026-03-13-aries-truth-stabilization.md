# Aries Truth Stabilization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the current Aries app truthful, operable, and internally consistent without expanding scope.

**Architecture:** Preserve only the runtime paths that are actually wired. Fix thin route wrappers where they drop required inputs or point at conflicting screens, choose one canonical marketing job flow, downgrade or remove fake API success paths, and align the UI/docs to the backend contracts that really exist in this repo.

**Tech Stack:** Next.js 15 app router, React 18, TypeScript, Node test runner via `tsx --test`, backend helpers under `backend/`, route handlers under `app/api/`.

---

### Task 1: Restore Route Wrapper Truth

**Files:**
- Modify: `app/onboarding/status/page.tsx`
- Modify: `app/marketing/new-job/page.tsx`
- Modify: `frontend/onboarding/status.tsx`
- Modify: `frontend/settings/index.tsx`
- Modify: `frontend/app-shell/routes.ts` only if navigation truth changes
- Test: `tests/runtime-pages.test.ts`

**Step 1: Write the failing test**
- Add wrapper-level smoke tests proving the listed route pages return renderable elements and preserve required query inputs.
- Add a regression proving onboarding status preserves `signup_event_id` from the route boundary.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/runtime-pages.test.ts`
- Expected: FAIL on the onboarding status passthrough and any route wrapper drift captured by the smoke harness.

**Step 3: Write minimal implementation**
- Pass through required onboarding query state.
- Point `/marketing/new-job` at the canonical screen selected in Task 2.
- Downgrade obviously false page actions, especially `/settings`, if no live route exists yet.

**Step 4: Run test/build to verify it passes**
- Run: `npm test -- tests/runtime-pages.test.ts`
- Run: `npm run typecheck`

### Task 2: Choose One Canonical Marketing Job Flow

**Files:**
- Modify: `app/marketing/new-job/page.tsx`
- Modify: `frontend/marketing/brand-campaign.tsx`
- Modify: `frontend/marketing/new-job.tsx`
- Modify: `frontend/api/contracts/marketing.ts`
- Modify: `backend/marketing/jobs-start.ts`
- Test: `tests/marketing-job-flow.test.ts`

**Step 1: Write the failing test**
- Add a focused test that defines the accepted request shape and canonical route target for marketing job creation.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/marketing-job-flow.test.ts`
- Expected: FAIL because the repo currently supports overlapping `brand_campaign` and generic marketing job creation paradigms.

**Step 3: Write minimal implementation**
- Keep exactly one authoritative `/marketing/new-job` screen and payload contract.
- Remove or retire the conflicting path instead of preserving two overlapping creation flows.
- Keep tenant handling truthful and avoid hidden hardcoded tenant behavior unless the backend contract explicitly requires it.

**Step 4: Run test to verify it passes**
- Run: `npm test -- tests/marketing-job-flow.test.ts`
- Run: `npm run typecheck`

### Task 3: Remove Fake API Success Paths

**Files:**
- Modify: `app/api/contact/route.ts`
- Modify: `app/api/waitlist/route.ts`
- Modify: `app/api/events/route.ts`
- Modify: `app/api/publish/dispatch/route.ts`
- Modify: onboarding and marketing route handlers if response semantics are overstated
- Test: `tests/runtime-api-truth.test.ts`

**Step 1: Write the failing test**
- Add API truth-table tests that reject fake-success semantics for the prioritized routes.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/runtime-api-truth.test.ts`
- Expected: FAIL where current routes return success even though no real workflow exists.

**Step 3: Write minimal implementation**
- Wire to the real backend path when it exists.
- Otherwise return explicit not-implemented or unavailable semantics and remove misleading success bodies.

**Step 4: Run test to verify it passes**
- Run: `npm test -- tests/runtime-api-truth.test.ts`

### Task 4: Reconcile Frontend and Backend Contracts

**Files:**
- Modify: `frontend/onboarding/start.tsx`
- Modify: `frontend/onboarding/status.tsx`
- Modify: `frontend/marketing/job-status.tsx`
- Modify: `frontend/api/client/onboarding.ts`
- Modify: `frontend/api/client/marketing.ts` only if required by the canonical contract
- Modify: related contract types under `frontend/api/contracts/`
- Test: `tests/onboarding-marketing-contracts.test.ts`

**Step 1: Write the failing test**
- Add targeted tests proving onboarding start/status and marketing status screens use the actual request/response shapes.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/onboarding-marketing-contracts.test.ts`

**Step 3: Write minimal implementation**
- Remove stale field assumptions, dead props, and fake fallbacks.
- Ensure deep-link params and status loading behavior match the live route/API contract.

**Step 4: Run test to verify it passes**
- Run: `npm test -- tests/onboarding-marketing-contracts.test.ts`

### Task 5: Make Integrations Status Honest

**Files:**
- Modify: `frontend/settings/integrations.tsx`
- Modify: `frontend/settings/platform-card.tsx` if status copy needs to change
- Modify: `app/api/integrations/route.ts`
- Modify: `backend/integrations/status.ts`
- Modify: `backend/integrations/provider-state.ts`
- Test: `tests/integrations-status.test.ts`

**Step 1: Write the failing test**
- Add a focused test around token-health derivation and exposed UI semantics.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/integrations-status.test.ts`

**Step 3: Write minimal implementation**
- Use actual validity/expiry data if available.
- Otherwise downgrade to an honest connected/unknown-expiry model instead of inventing expiry knowledge.

**Step 4: Run test to verify it passes**
- Run: `npm test -- tests/integrations-status.test.ts`

### Task 6: Align Docs and Manifests to Runtime Truth

**Files:**
- Modify: `ROUTE_MANIFEST.md`
- Modify: `README-runtime.md`
- Modify: `ROADMAP.md`
- Modify: `EXECUTION_MANIFEST.md`
- Modify: `SETUP.md`

**Step 1: Verify current drift**
- Re-read the live routes and API handlers against the current docs.

**Step 2: Write minimal implementation**
- Remove inflated claims and record only the routes/APIs/workflows that are truly wired after Tasks 1-5.

**Step 3: Run verification**
- Run: `npm run precheck`

### Task 7: Final Verification

**Files:**
- No new product files; verification and cleanup only

**Step 1: Run targeted tests**
- Run: `npm test -- tests/runtime-pages.test.ts tests/marketing-job-flow.test.ts tests/runtime-api-truth.test.ts tests/onboarding-marketing-contracts.test.ts tests/integrations-status.test.ts`

**Step 2: Run static verification**
- Run: `npm run typecheck`
- Run: `npm run build`

**Step 3: Record truth contract**
- Summarize routes that render, APIs that are truly wired, APIs intentionally downgraded, canonical marketing flow, and the integrations status model.
