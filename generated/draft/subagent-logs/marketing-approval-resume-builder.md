# marketing-approval-resume-builder

## Summary
Built a bounded n8n workflow to resume paused marketing job stages after explicit approval.

## Scope
- Updated only the four allowed files:
  - `./specs/marketing_approval_resume_workflow_spec.v1.json`
  - `./n8n/marketing-approval-resume.workflow.json`
  - `./generated/draft/subagent-results/marketing-approval-resume-builder.json`
  - `./generated/draft/subagent-logs/marketing-approval-resume-builder.md`

## What changed
- Added workflow spec for `marketing-approval-resume` webhook (`POST /marketing-approval-resume`).
- Implemented workflow logic to:
  - Validate `job_id` and `approval.decision=approved`.
  - Load `./generated/draft/marketing-jobs/{job_id}.json`.
  - Resume paused stages in explicit order: `research -> strategy -> production -> publish`.
  - Emit structured stage transition records (`from`, `to`, `reason`).
  - Persist structured status updates under `outputs.approval_resume`.
- Added bounded repair behavior for stage statuses only:
  - Initialize missing stage statuses to `paused`.
  - Coerce invalid/non-string stage statuses to `paused`.
  - Record each repair item for auditability.
- Added conditional publish resume behavior when `resume_publish_if_needed=true` and upstream stages are already done/queued/running.

## Runtime responses
- `200` on successful resume (`status: resumed`).
- `400` for invalid input.
- `404` when the job runtime file is missing.
- `409` when approval was not granted / no resume path.
- `500` for hard failure on invalid job runtime JSON.

## Compliance checks
- JSON parse validation passed for updated files.
- Node types are within allowlist:
  - `n8n-nodes-base.webhook`
  - `n8n-nodes-base.set`
  - `n8n-nodes-base.if`
  - `n8n-nodes-base.executeCommand`
  - `n8n-nodes-base.respondToWebhook`
