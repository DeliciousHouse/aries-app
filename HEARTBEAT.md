# HEARTBEAT — Aries Persistent Continuation Engine

This heartbeat drives a **long-running phase machine**. It must continue progress across multiple runs until the reconciled roadmap work is complete.

## Source of truth
- `./generated/validated/project-progress.json`
- `./generated/validated/canonical-roadmap-baseline.md`
- `./generated/validated/repo-audit-summary.md`

## Dedicated heartbeat state location
Heartbeat/status artifacts must live outside `/app/aries-app`.
Use:
- Phase log: `/app/state/aries-heartbeat/heartbeat-phase-log.md`
- Hard blockers / defect state: `/app/state/aries-heartbeat/heartbeat-defect-report.json`

Heartbeat state is file-based operational status only. It must not be treated as the main restored chat, mirrored into the rolling conversation, or used as a conversation transcript.

## Run algorithm (every heartbeat)
1. Read `generated/validated/project-progress.json`.
2. Read `generated/validated/canonical-roadmap-baseline.md`.
3. Work only on `current_phase`.
4. Execute only tasks defined for the active phase in the reconciled canonical roadmap baseline.
5. If blocked by independent work, spawn bounded subagents in parallel.
6. Validate phase outputs with the active phase gate.
7. If validation passes:
   - update `completed_phases`
   - set `next_phase`
   - set `current_phase` to the actual new active phase or `complete`
   - update `status`
   - clear resolved blockers
   - update `last_updated`
8. If validation fails but bounded repair is possible:
   - patch only failing section(s)
   - increment retry counter for current phase
   - retry up to 3 times
9. If hard failure occurs:
   - write `/app/state/aries-heartbeat/heartbeat-defect-report.json`
   - set `last_hard_failure`
   - stop phase advancement
10. Never start unrelated features.
11. If all active reconciled phases are complete and no blockers remain:
   - update `/app/state/aries-heartbeat/heartbeat-phase-log.md`
   - return `HEARTBEAT_OK`

## Hard rules
- Do not redesign validated contracts or workflows unless the active validator proves a defect.
- Do not fabricate pass results.
- Use subagents only for independent bounded scopes.
- Write heartbeat/status artifacts only to `/app/state/aries-heartbeat/`.
- Keep Mission Control in its separate project path outside `/app/aries-app`.

## Active phase mapping
- `repo_audit_reconciliation`
- `working_tree_validation`
- `targeted_repair_if_needed`
- `revalidation_and_handoff_refresh`

## Completion condition
When the reconciled active phases validate successfully and no blockers remain, mark:
- `current_phase: complete`
- `status: complete`
- `next_phase: null`
- `last_updated: <ISO timestamp>`

Then keep final summaries current and return `HEARTBEAT_OK`.
