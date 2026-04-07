# HEARTBEAT — Default

Use the default heartbeat behavior for this workspace.

## Rules
- Do not infer or repeat stale tasks from prior chats.
- Use current workspace/repo/runtime truth when available.
- Treat `PRIORITIES.md` as part of the active workspace contract and check it on heartbeat.
- If `PRIORITIES.md` is stale against current board or validated progress truth, report that drift instead of ignoring it.

## On each heartbeat poll
1. Read `PRIORITIES.md` along with current workspace/runtime truth.
2. Check whether anything in the current workspace needs immediate attention.
3. If nothing needs attention, reply exactly:
   `HEARTBEAT_OK`
4. If something does need attention, reply with concise alert text describing the issue.
5. Do not include `HEARTBEAT_OK` in an alert response.

## Notes
- This default heartbeat replaces the prior stale phase-machine heartbeat design.
- `PRIORITIES.md` is now a heartbeat input, not an optional planning artifact.
- The old `generated/validated/*` roadmap artifact contract is not active for this workspace unless a current file is explicitly being used as a verified source.
