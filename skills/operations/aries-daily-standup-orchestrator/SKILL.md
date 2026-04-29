---
name: aries-daily-standup-orchestrator
description: Run the Aries daily standup orchestration and return only its concise operational summary. Use when asked to run the daily standup manually or from cron, especially when transcript and chief report artifacts must be written to the shared teams workspace.
---

# Aries Daily Standup Orchestrator

Use this skill when the Aries standup should run on demand or from cron.

## Required procedure
1. Work in `/home/node/aries-app`.
2. Run:
   - `node scripts/automations/daily-standup.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Output rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Path rule
The standup artifacts must write to the shared teams workspace, not repo-local `team/...` paths and not the deprecated singular `shared/team/...` standup paths.
