# marketing-publish-workflow-builder

## Summary
Built the marketing publish workflow and companion spec using the marketing job contract, canonical runtime schemas, and production-output consumption requirements.

## Scope
- Updated only the four allowed files:
  - `./specs/marketing_publish_workflow_spec.v1.json`
  - `./n8n/marketing-publish.workflow.json`
  - `./generated/draft/subagent-results/marketing-publish-workflow-builder.json`
  - `./generated/draft/subagent-logs/marketing-publish-workflow-builder.md`

## Inputs used
- `./specs/marketing_job_contract_spec.v1.json`
- `./specs/tenant_runtime_state_schema.v1.json`
- `./specs/job_runtime_state_schema.v1.json`
- `./generated/validated/{tenant}/workspaces/marketing/*` (as production output shape consumed via request payload)
- `./skills/n8n-local-runtime/contract.json` (allowlist)

## What changed
- Added new n8n workflow spec for `marketing-publish` webhook.
- Added runnable n8n workflow at `./n8n/marketing-publish.workflow.json`.
- Enforced shared-schema hard-failure checks (missing/invalid JSON) before publish execution.
- Implemented explicit stage transitions in persisted runtime state:
  - `queued`
  - `validating_inputs`
  - `publishing`
  - `publish_completed`
- Implemented safe publish defaults:
  - `paused` behavior for target publish actions
  - `activate_after_publish: false`
  - `dry_run` default `true`
- Implemented bounded repair:
  - only repairs malformed/empty `publish_targets`
  - repairs to `['meta_ads']`
  - max attempts set to 3
- Implemented structured result persistence:
  - publish result JSON at `./generated/draft/marketing-publish/{job_id}.publish-result.json`
  - runtime state JSON at `./generated/draft/marketing-publish/{job_id}.job-runtime.json`

## Compliance checks
- Node types used are in allowlist:
  - `n8n-nodes-base.webhook`
  - `n8n-nodes-base.set`
  - `n8n-nodes-base.if`
  - `n8n-nodes-base.executeCommand`
  - `n8n-nodes-base.respondToWebhook`
- Updated files are valid JSON/Markdown.

## Runtime behavior notes
- If no production output file paths provided in input exist on disk, workflow returns structured failure and writes failed runtime/result artifacts.
- Success response is structured and returns tenant/job metadata, publish state, result path, targets, and bounded repair metadata.
