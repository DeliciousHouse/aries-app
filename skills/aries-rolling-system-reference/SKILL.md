---
name: aries-rolling-system-reference
description: Refresh the Aries rolling system reference and return only its concise operational summary. Use when asked to run the rolling system reference update manually or from cron.
---

# Aries Rolling System Reference

Use this skill when the Aries rolling system reference should run on demand or from cron.

## Required procedure
1. Work in `/home/node/openclaw/aries-app`.
2. Run:
   - `node scripts/automations/rolling-system-reference.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Output rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.
