# video-workflow-builder log

## Scope
Created/updated only the requested bounded files for n8n video orchestration and subagent outputs.

## What was implemented

1. `n8n/video-job-intake.workflow.json`
   - Validates required inputs (`jobId`, `prompt`, `aspectRatio`, `durationSec`)
   - Normalizes payload for downstream Veo execution
   - Attaches bounded repair policy defaults
   - Sets approval requirement (`pending`)

2. `n8n/video-generate.workflow.json`
   - Executes intake workflow first
   - Calls Veo skill **request** endpoint to start generation
   - Normalizes operation id and emits `generation_requested`

3. `n8n/video-poll.workflow.json`
   - Calls Veo skill **poll** endpoint
   - Routes success vs in-progress state
   - Marks generated outputs as awaiting approval

4. `n8n/video-approve.workflow.json`
   - Explicit decision gate (`approvalDecision == approved`)
   - Approve path marks final accepted
   - Reject path marks rejected with reason

5. `n8n/video-repair.workflow.json`
   - Enforces bounded retry ceiling (`maxAttempts`)
   - Applies constrained repair edits (prompt trim, duration clamp)
   - Regenerates only when within bounds; otherwise terminal fail

## Design notes
- Kept implementation independent of onboarding/marketing validated artifacts.
- Used modular workflow separation so orchestration can be wired as intake → generate → poll → approve/repair.
- Veo request/poll logic represented as dedicated HTTP nodes intended to target Veo skill endpoints.
