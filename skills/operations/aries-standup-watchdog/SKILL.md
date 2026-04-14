---
name: aries-standup-watchdog
description: Run the Aries standup watchdog and return only its concise operational summary. Use when asked to verify that daily standup artifacts were written to the shared teams workspace, or from cron after a standup run to detect missing artifacts or forbidden path drift.
---

# Aries Standup Watchdog

Use this skill when the Aries standup outputs need a fast integrity check.

## Required procedure
1. Work in `/home/node/openclaw/aries-app`.
2. Run:
   - `node skills/operations/aries-standup-watchdog/scripts/run-watchdog.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Output rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Integrity rule
Treat repo-local `team/...` standup artifacts and deprecated singular `shared/team/...` standup artifacts as failures, not acceptable fallbacks.
