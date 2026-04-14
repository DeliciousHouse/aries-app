---
name: aries-daily-brief
description: Generate the morning daily brief with priorities, overnight git activity, pending action items, and working tree status.
---

# Aries Daily Brief

Morning briefing document that aggregates priorities, overnight activity, pending actions, and workspace state into a single markdown file.

## Required procedure
1. Work in `/home/node/openclaw/aries-app`.
2. Run:
   - `node scripts/automations/daily-brief.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Steps

### Step 1: Gather priorities
1. Read `PRIORITIES.md` and extract up to 5 unchecked checkbox items.
2. These become the "Priorities for today" section.

### Step 2: Gather overnight activity
1. Run `git log --since=24 hours ago` to capture up to 8 recent commits.
2. Format as commit hash, subject, and relative time.

### Step 3: Gather pending action items
1. Read `ROADMAP.md` and `HEARTBEAT.md`.
2. Extract unchecked checkbox items from both, deduplicate, take up to 8.

### Step 4: Capture workspace state
1. Run `git status --short` and capture up to 10 lines of uncommitted changes.

### Step 5: Check overnight automation notes
1. Read `memory/<YYYY-MM-DD>.md` if it exists.
2. Extract the last 6 lines as the overnight automation note.

### Step 6: Generate and save the brief
1. Assemble all sections into a markdown document.
2. Write to `docs/briefs/<YYYY-MM-DD>-brief.md`.

## Validate
- [ ] Brief file was written to `docs/briefs/`
- [ ] All sections populated (empty sections get explicit "none found" messages)
- [ ] Summary includes: file path, priority count, overnight item count, pending action count

## Error Handling
- If `PRIORITIES.md` is missing: section shows "No open priority bullets found"
- If no git activity in 24 hours: section shows "No git activity recorded"
- If `ROADMAP.md` or `HEARTBEAT.md` missing: pending actions section shows "No open backlog items"
- If memory file missing: overnight note shows "No overnight memory note found"

## Output Rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Script
```bash
node scripts/automations/daily-brief.mjs
```
