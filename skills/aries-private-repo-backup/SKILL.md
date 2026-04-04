---
name: aries-private-repo-backup
description: Run the Aries private GitHub backup automation and return only its concise operational summary. Use when asked to run the private repo backup manually or from cron.
---

# Aries Private Repo Backup

Use this skill when the Aries private backup should run on demand or from cron.

## Required procedure
1. Work in `/app/aries-app`.
2. Run:
   - `node scripts/automations/private-repo-backup.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Output rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.
