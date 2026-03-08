# marketing-research-workflow-builder

## Summary
Reran the bounded marketing research workflow build after canonical shared schemas became available.

## Scope
- Updated only the four allowed files:
  - `./specs/marketing_research_workflow_spec.v1.json`
  - `./n8n/marketing-research.workflow.json`
  - `./generated/draft/subagent-results/marketing-research-workflow-builder.json`
  - `./generated/draft/subagent-logs/marketing-research-workflow-builder.md`

## Inputs used
- `./specs/marketing_job_contract_spec.v1.json`
- `./specs/tenant_runtime_state_schema.v1.json`
- `./specs/job_runtime_state_schema.v1.json`
- `./skills/n8n-local-runtime/contract.json` (allowlist)

## What changed
- Replaced hard-failure placeholder workflow with a runnable n8n webhook workflow (`marketing-research`).
- Added runtime guard step to assert both shared schemas exist and parse as JSON.
- Added structured 500 hard-failure response branch when schema checks fail.
- Added accepted-job branch that writes a runtime job state JSON to `./generated/draft/marketing-jobs/{job_id}.json`.

## Compliance checks
- Node types used are within allowlist:
  - `n8n-nodes-base.webhook`
  - `n8n-nodes-base.set`
  - `n8n-nodes-base.if`
  - `n8n-nodes-base.executeCommand`
  - `n8n-nodes-base.respondToWebhook`
- JSON parse validation completed for updated spec/workflow/result files.

## Hard-failure policy
- If shared schemas are missing or invalid JSON at runtime, workflow returns hard failure (HTTP 500) and does not fabricate a successful run.
