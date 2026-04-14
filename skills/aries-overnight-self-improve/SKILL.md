---
name: aries-overnight-self-improve
description: Run the Aries overnight self-improvement automation and return only its concise operational summary. Use when asked to run the overnight self-improvement pass manually or from cron.
---

# Aries Overnight Self-Improve

Use this skill when the Aries overnight self-improvement pass should run on demand or from cron.

## Required procedure
1. Work in `/home/node/openclaw/aries-app`.
2. Run:
   - `node scripts/automations/overnight-self-improve.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Output rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.
