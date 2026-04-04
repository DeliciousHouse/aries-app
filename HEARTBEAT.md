# HEARTBEAT — Default

Use the default heartbeat behavior for this workspace.

## Rules
- Do not infer or repeat stale tasks from prior chats.
- Use current workspace/repo/runtime truth when available.
- Do not depend on external planning artifacts unless they are explicitly part of the current workspace contract.

## On each heartbeat poll
1. Check whether anything in the current workspace needs immediate attention.
2. If nothing needs attention, reply exactly:
   `HEARTBEAT_OK`
3. If something does need attention, reply with concise alert text describing the issue.
4. Do not include `HEARTBEAT_OK` in an alert response.

## Notes
- This default heartbeat replaces the prior stale phase-machine heartbeat design.
- The old `generated/validated/*` roadmap artifact contract is not active for this workspace.
