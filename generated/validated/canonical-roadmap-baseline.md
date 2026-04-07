# Canonical roadmap baseline

This file replaces the stale historical phase machine in `ROADMAP.md` as the current validated planning baseline.

## Current state

- Repo audit complete.
- Production workflow contract is **not fully frozen** because workflow mappings and supported-route docs still drift from executable truth.
- Validated audit artifact: `generated/validated/repo-audit-baseline.json`
- Supporting summary: `generated/validated/repo-audit-summary.md`

## Recommended phase order

### Phase 1 — Freeze production contract
Persistent owner: Jarvis
Supporting execution label if used: `aries-prod` (subordinate specialist / task label only)

Objective:
- Lock the canonical production contract to the current executable repo truth.

Acceptance criteria:
- Workflow mappings reflect the real production path (`marketing-pipeline.lobster` + resumes) or are intentionally reduced.
- Stubbed operational routes are either upgraded, explicitly excluded from the supported contract, or clearly documented as non-production.
- Production docs/manifests match the executable route and workflow surface.
- Production runtime assumptions remain: baked image, `/data`, external Postgres, external OpenClaw Gateway.

Current blockers:
- `backend/openclaw/workflow-catalog.ts` disagrees with `backend/marketing/orchestrator.ts`.
- Several supported UI/API routes still resolve to parity stubs.
- Docs/manifests lag the checked-in app/test surface.

### Phase 2 — Derive local parity from production
Persistent owner: Jarvis
Supporting execution label if used: `aries-local` (subordinate specialist / task label only)

Objective:
- Generate host-local and Docker-local contracts from the frozen production baseline.

Acceptance criteria:
- Host local env values are derived from production, not guessed independently.
- Docker local keeps parity-safe runtime plus dev-only bind mounts.
- Local documentation reflects the actual `npm run dev` Turbopack command.
- Local Lobster fallback path validates cleanly.

Current blocker:
- `tests/marketing-local-dev-regression.test.ts` currently fails on local fallback with `brand_kit_fetch_failed:fetch failed`.

### Phase 3 — Validate and package handoff
Persistent owner: Jarvis
Supporting execution labels if used: `aries-validator`, `release-readiness-specialist` (subordinate specialist labels only)

Objective:
- Run the validation gate against the frozen production + local contracts and prepare deployment handoff artifacts.

Acceptance criteria:
- Validation suite passes for the chosen supported contract.
- Drift findings are either resolved or explicitly accepted.
- Handoff artifacts clearly separate production contract from local/dev derivations.

## Immediate next action

Run the **production contract-freeze pass** next under Jarvis ownership. Use `aries-prod` only as a subordinate execution label if needed.
