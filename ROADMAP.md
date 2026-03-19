# Aries Production Continuation Roadmap

This roadmap defines a **persistent, multi-run phase machine** for advancing this workspace from current validated state to a production-ready, repo-backed system.

## Current baseline (already achieved)
- Backend contracts frozen and validated
- Marketing workflows active through the OpenClaw execution boundary
- Onboarding + marketing backend wiring exists
- Shared frontend types/clients exist
- Thin frontend screens exist
- Known blocker: frontend wireup drift in:
  - `frontend/onboarding/start.tsx`
  - `frontend/onboarding/status.tsx`
  - `frontend/marketing/job-status.tsx`

---

## Phase 1 — Fix frontend wireup drift
**Objective**
- Remove contract drift in the three failing screens and align to frozen contracts exactly.

**Inputs**
- `./generated/draft/frontend-screen-build-results.json`
- Frozen contract/type files under `./specs/` and `./frontend/api/contracts/`

**Outputs**
- Patched screen files (only failing sections)
- `./generated/draft/heartbeat-phase-log.md` entries

**Validation gate**
- `frontend-wireup-validator` reports zero contract-field drift on all five screens.

**Stop conditions**
- Pass: move to Phase 2
- Hard fail: write `./generated/draft/heartbeat-defect-report.json` and stop

---

## Phase 2 — Re-run frontend validator
**Objective**
- Confirm clean frontend contract wiring after Phase 1 fixes.

**Inputs**
- Frontend screens/components
- Shared frontend clients/types
- Frozen backend contracts

**Outputs**
- Updated `./generated/draft/frontend-screen-build-results.json`
- Updated `./generated/draft/frontend-screen-build-phase-log.md`

**Validation gate**
- Validator status is pass with no undefined contract fields.

**Stop conditions**
- Pass: move to Phase 3
- Bounded failures: repair only failing sections, retry up to 3
- Hard fail: write defect report and stop

---

## Phase 3 — End-to-end UI smoke
**Objective**
- Smoke test onboarding and marketing flows end-to-end through UI + live backend.

**Inputs**
- Frontend screens
- Live backend endpoints
- Active execution-boundary workflows

**Outputs**
- Smoke run evidence in `./generated/draft/heartbeat-phase-log.md`
- Structured smoke summary in draft artifacts

**Validation gate**
- Happy-path onboarding + marketing flow complete through UI-driven calls.

**Stop conditions**
- Pass: move to Phase 4
- Bounded failures: repair only failing flow section, retry up to 3
- Hard fail: defect report and stop

---

## Phase 4 — Polish operational frontend
**Objective**
- Minimal operational polish (clarity, errors, status UX) without adding unrelated features.

**Inputs**
- Existing thin screens/components
- Runtime/error canonical types

**Outputs**
- Focused UI improvements
- Updated logs/artifacts in draft

**Validation gate**
- No contract drift reintroduced; operational UX checks pass.

**Stop conditions**
- Pass: move to Phase 5
- Bounded failures: patch only failing UI section, retry up to 3
- Hard fail: defect report and stop

---

## Phase 5 — Verify backend endpoint behavior against live UI
**Objective**
- Confirm endpoint semantics and response shapes match frozen contracts during live UI usage.

**Inputs**
- Frozen contracts in `./specs/`
- UI and API client code
- Live backend

**Outputs**
- Verification logs and structured comparison artifacts

**Validation gate**
- Endpoint responses match frozen shapes and canonical enum domains.

**Stop conditions**
- Pass: move to Phase 6
- Bounded failures: patch only mismatched contract-consumer section, retry up to 3
- Hard fail: defect report and stop

---

## Phase 6 — Package repo for production OpenClaw import
**Objective**
- Produce clean importable repository state with required artifacts and docs.

**Inputs**
- Validated backend/frontend/contracts/workflows

**Outputs**
- Production import package/checklist artifacts

**Validation gate**
- Packaging checklist complete and reproducible from repository state.

**Stop conditions**
- Pass: move to Phase 7
- Bounded failures: patch packaging gaps only, retry up to 3
- Hard fail: defect report and stop

---

## Phase 7 — Prepare production deployment handoff artifacts
**Objective**
- Final handoff documentation + operational runbook for deployment.

**Inputs**
- Packaged repo and validation outputs

**Outputs**
- Deployment handoff bundle (docs + verification references)

**Validation gate**
- Handoff checklist complete and internally consistent.

**Stop conditions**
- Pass: mark roadmap complete
- Hard fail: defect report and stop

---

## Phase machine rules
- Never skip phase gates.
- Never start unrelated features.
- Patch only failing sections.
- Use bounded subagents in parallel only for independent scopes.
- Hard failures stop the machine until addressed.
