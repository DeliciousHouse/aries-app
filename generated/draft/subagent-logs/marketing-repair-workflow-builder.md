# marketing-repair-workflow-builder

## Summary
Implemented a bounded marketing repair workflow with explicit stage-scoped patching and rerun behavior.

## Scope
- Updated only the four allowed files:
  - `./specs/marketing_repair_workflow_spec.v1.json`
  - `./n8n/marketing-repair.workflow.json`
  - `./generated/draft/subagent-results/marketing-repair-workflow-builder.json`
  - `./generated/draft/subagent-logs/marketing-repair-workflow-builder.md`

## Implemented bounded repair requirements
- **Patch only failing stage section**
  - Repair command updates only `production.parallel_branches.{failed_stage}`.
- **Rerun only failed stage**
  - Rerun scope is explicitly `only_failed_stage` and tied to `failed_stage` input.
- **Max 3 attempts**
  - Retry branch increments `attempt` and recurses only when `attempt < 3`.
- **Structured defect reports**
  - On failed rerun, appends structured defect object:
    - `at`, `attempt`, `stage`, `code`, `message`, `evidence`.

## Job-state transitions and status updates
- Explicit transitions emitted in `status_updates`:
  - `repair_running`
  - `stage_patching`
  - `stage_rerun`
  - `awaiting_retry` (when attempts remain)
  - `completed` or `failed`
- Each status update includes:
  - `at`, `state`, `status`, `step`, `details`

## Validation
- JSON parse validated for:
  - `./specs/marketing_repair_workflow_spec.v1.json`
  - `./n8n/marketing-repair.workflow.json`
  - `./generated/draft/subagent-results/marketing-repair-workflow-builder.json`
- Node types used remain within local runtime allowlist family.
