---
name: aries_integrations_sync
description: Run the Aries integrations sync workflow from the repo, then return a concise operational summary for cron delivery.
---

# Aries Integrations Sync

## Use when
Use this skill when asked to run the Aries integrations synchronization pipeline on demand or from cron.

## Launcher entrypoint
Use the repo workflow launcher via the `lobster` tool:
- pipeline: `workflows/openclaw/integrations-sync.json`
- cwd: `.`

Equivalent local launcher intent:
- run the repo-managed workflow definition for `integrations_sync_pipeline`
- do **not** treat the workflow definition file as a cron record

## Required procedure
1. Run the `lobster` tool with:
   - `action: "run"`
   - `pipeline: "workflows/openclaw/integrations-sync.json"`
   - `cwd: "."`
   - `argsJson: "{}"`
2. If the launcher returns an error or non-ok result, fail loudly with the root cause.
3. Return a concise operational summary only.
4. Do not send a separate message with the `message` tool when cron announce delivery is already enabled.

## Response format
Return only:
- `status:` success or failed
- `actions:` short bullet or one-line summary
- `errors:` `none` or the root cause
- `next_step:` `none` or the specific operator follow-up needed
