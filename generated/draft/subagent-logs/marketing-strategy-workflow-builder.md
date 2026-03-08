# marketing-strategy-workflow-builder

## Summary
Built a new n8n marketing strategy workflow and companion spec with an explicit approval gate before production, explicit stage transitions in job state, structured status updates, and bounded repair handling.

## Scope
- Updated only the four allowed files:
  - `./specs/marketing_strategy_workflow_spec.v1.json`
  - `./n8n/marketing-strategy.workflow.json`
  - `./generated/draft/subagent-results/marketing-strategy-workflow-builder.json`
  - `./generated/draft/subagent-logs/marketing-strategy-workflow-builder.md`

## Inputs used
- `./specs/marketing_job_contract_spec.v1.json`
- `./specs/tenant_runtime_state_schema.v1.json`
- `./specs/job_runtime_state_schema.v1.json`
- Marketing research outputs in workspace:
  - `./generated/draft/subagent-results/marketing-research-workflow-builder.json`
  - `./generated/draft/subagent-logs/marketing-research-workflow-builder.md`
  - runtime strategy input default path: `./generated/draft/{tenant_id}/workspaces/research/README.md`
- `./skills/n8n-local-runtime/contract.json` (allowlist reference)

## Workflow behavior
1. Accepts webhook `POST /webhook/marketing-strategy`.
2. Validates required input (`tenant_id`, `job_type`) and hard-fails if shared schemas are missing/invalid.
3. Builds a job runtime artifact at `./generated/draft/marketing-jobs/{job_id}.json`.
4. Enforces approval checkpoint before production:
   - `request.approval.approved !== true` → `awaiting_approval` (HTTP 202), no production advancement.
   - `request.approval.approved === true` → `ready_for_production` (HTTP 200).
5. Adds bounded repair support around research-artifact readiness:
   - Missing/empty research artifact with attempts remaining → `needs_repair` (HTTP 409).
   - Missing/empty research artifact at max attempts → `failed` (HTTP 422).

## State modeling details
- Uses job schema-compatible top-level state values (`running`, `waiting_repair`, `completed`, `failed`).
- Keeps finer-grained stage transitions explicit in:
  - `outputs.stage_transitions`
  - `outputs.structured_status_updates`
  - `outputs.current_stage`
- Includes approval checkpoint object in both response and job outputs:
  - `required: true`
  - `gate_before_stage: production_ready`
  - approved / approved_by / note

## Compliance checks
- JSON parse validation passed for:
  - `./specs/marketing_strategy_workflow_spec.v1.json`
  - `./n8n/marketing-strategy.workflow.json`
  - `./generated/draft/subagent-results/marketing-strategy-workflow-builder.json`
- Node types used are within allowlist:
  - `n8n-nodes-base.webhook`
  - `n8n-nodes-base.set`
  - `n8n-nodes-base.if`
  - `n8n-nodes-base.executeCommand`
  - `n8n-nodes-base.respondToWebhook`
