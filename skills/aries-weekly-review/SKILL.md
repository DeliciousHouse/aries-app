---
name: aries-weekly-review
description: Generate the Friday weekly review from live board, git, cron, backlog, and service-health truth, save markdown/html review artifacts, and optionally email the HTML version.
---

# Aries Weekly Review

Friday weekly review that resets project truth before the next week starts. It gathers live board, git, cron, backlog, and service-health evidence, writes the full review to `memory/reviews/`, and optionally emails the HTML version when delivery is configured.

## Prerequisites
- `memory/YYYY-MM-DD.md` exists for the current week's Monday through Friday when logging is healthy
- Project board available at `/home/node/.openclaw/projects/shared/team/execution-tasks.json` or via `EXECUTION_TASKS_PATH`
- Git history available for the last 7 days
- `openclaw` CLI available for live cron health
- `docker compose` available if repo service-health checks are expected
- Optional email delivery env:
  - `ARIES_WEEKLY_REVIEW_EMAIL`
  - `ARIES_WEEKLY_REVIEW_EMAIL_SCRIPT` (defaults to `~/scripts/gmail-send.py`)

## Steps

### Step 1: Gather live weekly sources
1. Read the current week's Monday through Friday daily memory files.
2. Load the live board source and classify shipped, in-progress, blocked, and stale work.
3. Pull `git log --oneline --since="7 days ago"` and weekly file-change counts.
4. Pull live cron health from the current OpenClaw cron state.
5. Check repo service health from current runtime commands, not memory.

### Step 2: Build the weekly review
1. Generate the review in the required structure:
   - Shipped This Week
   - In Progress (Carrying Over)
   - Stale Items (Action Required)
   - Cron Health
   - Metrics Snapshot
   - Next Week Focus
2. Keep the review under 800 words.
3. Use live metrics when available; if a live metric surface is unavailable, say so plainly.
4. Do not claim deployment unless live deployment truth is actually verified.

### Step 3: Save review artifacts
1. Write markdown to `memory/reviews/week-of-<YYYY-MM-DD>.md`.
2. Write matching HTML to `memory/reviews/week-of-<YYYY-MM-DD>.html`.
3. Include any daily-log gaps or backlog-surface gaps explicitly in the saved review.

### Step 4: Deliver
1. If `ARIES_WEEKLY_REVIEW_EMAIL` and the configured mailer script both exist, email the HTML review.
2. If email delivery is not configured, keep the saved files and report email as skipped.
3. Let cron announce delivery carry the short summary message instead of duplicating notification logic in the skill.

## Validate
- [ ] Review markdown written to `memory/reviews/`
- [ ] Matching HTML written to `memory/reviews/`
- [ ] Review stays under 800 words
- [ ] Cron health uses live cron state, not old memory notes
- [ ] Service health uses a live command result or says unavailable
- [ ] Email delivery is either confirmed sent or explicitly marked skipped

## Error Handling
- If one or more Mon-Fri daily files are missing: record the gap and continue
- If `BACKLOG.md` is missing: say the backlog file is missing and fall back to board staleness only
- If cron state cannot be loaded: mark cron health unavailable instead of guessing
- If service-health commands fail: mark service health unavailable instead of guessing
- If email delivery is not configured: save the review and mark email skipped

## Output Rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Script
```bash
node scripts/automations/weekly-review.mjs
```
