# HEARTBEAT — Aries Persistent Continuation Engine

This heartbeat drives a **long-running phase machine**. It must continue progress across multiple runs until roadmap completion.

## Source of truth
- `./generated/validated/project-progress.json`
- `./ROADMAP.md`

## Required log/defect outputs
- Phase log: `./generated/draft/heartbeat-phase-log.md`
- Hard blockers: `./generated/draft/heartbeat-defect-report.json`

## Run algorithm (every heartbeat)
1. Read `project-progress.json`.
2. Work only on `current_phase`.
3. Execute only tasks defined for that phase in `ROADMAP.md`.
4. If blocked by independent work, spawn bounded subagents in parallel.
5. Validate phase outputs with the phase validator/gate.
6. If validation passes:
   - update `completed_phases`
   - set next `current_phase`
   - set `current_status` accordingly
   - clear resolved blockers
7. If validation fails but bounded repair is possible:
   - patch only failing section(s)
   - increment retry counter for current phase
   - retry up to 3 times
8. If hard failure occurs:
   - write `heartbeat-defect-report.json`
   - set `last_hard_failure`
   - stop phase advancement
9. Never start unrelated features.
10. If all phases in `ROADMAP.md` are complete:
    - write final completion summary to `heartbeat-phase-log.md`
    - return `HEARTBEAT_OK`

## Hard rules
- Do not redesign validated contracts or workflows unless the current phase validator proves a defect.
- Do not fabricate pass results.
- Use subagents only for independent bounded scopes.
- Keep all writes inside `./aries-platform-bootstrap`.

## Phase mapping
- `phase_1_fix_frontend_wireup_drift`
- `phase_2_rerun_frontend_validator`
- `phase_3_end_to_end_ui_smoke`
- `phase_4_polish_operational_frontend`
- `phase_5_verify_backend_behavior_against_live_ui`
- `phase_6_package_repo_for_production_openclaw_import`
- `phase_7_prepare_production_deployment_handoff`

## Completion condition
When phase 7 validates successfully and no blockers remain, mark `current_status: complete`, keep final summaries updated, and return `HEARTBEAT_OK`.
