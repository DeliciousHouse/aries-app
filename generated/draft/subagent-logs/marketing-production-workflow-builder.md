# marketing-production-workflow-builder

## Summary
Built the marketing production n8n workflow artifacts with approval gating before publish, explicit state transitions, structured status updates, and bounded repair behavior.

## Scope
Updated only the four allowed files:
- `./specs/marketing_production_workflow_spec.v1.json`
- `./n8n/marketing-production.workflow.json`
- `./generated/draft/subagent-results/marketing-production-workflow-builder.json`
- `./generated/draft/subagent-logs/marketing-production-workflow-builder.md`

## Inputs consumed
- `./specs/marketing_job_contract_spec.v1.json`
- `./specs/tenant_runtime_state_schema.v1.json`
- `./specs/job_runtime_state_schema.v1.json`
- Strategy payload channels in request:
  - `request.strategy_outputs`
  - `request.strategy`

## Workflow behavior implemented
1. **Normalize + validate input** (`tenant_id`, `job_type`, `request`).
2. **Hard-failure schema guard** for canonical shared schemas (missing/invalid JSON => 500 structured hard failure).
3. **Production orchestration** creates runtime job record and consumes strategy outputs.
4. **Logical parallel branch statuses** for:
   - `ad-designer`
   - `scriptwriter`
   - `page-designer`
5. **Approval checkpoint before publish**:
   - If approval still required, return `awaiting_approval` and do not publish.
   - Publish path only executes when approval bypassed/approved.
6. **Bounded repair on publish failure**:
   - Publish attempt 1 can fail (including simulated failure).
   - If repair enabled, run one bounded repair cycle and publish attempt 2.
7. **Structured status updates** returned and persisted with explicit state transitions.

## State transitions represented
- `queued`
- `running`
- `production_parallelized`
- `awaiting_approval`
- `publishing`
- `repair_running`
- `completed`
- `failed`

## Validation checks
- JSON parse verified for updated spec/workflow/result files.
- Node types limited to allowlist-compatible set:
  - `n8n-nodes-base.webhook`
  - `n8n-nodes-base.set`
  - `n8n-nodes-base.if`
  - `n8n-nodes-base.executeCommand`
  - `n8n-nodes-base.respondToWebhook`
