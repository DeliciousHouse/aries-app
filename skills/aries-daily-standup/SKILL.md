---
name: aries-daily-standup
description: Generate a board-based daily standup transcript with per-lane reports, workspace verification, blockers, and routing needs.
---

# Aries Daily Standup

Automated daily standup that reads the shared execution board, generates per-lane reports, runs workspace verification, and archives a standup transcript.

## Prerequisites
- Project board data available at `~/.openclaw/projects/shared/team/execution-tasks.json` or `EXECUTION_TASKS_PATH`
- `npm run workspace:verify` runnable (timeout: 2 minutes)
- `~/.openclaw/projects/shared/team/meetings/` directory exists for transcript archival

## Steps

### Step 1: Load project board
1. Read `execution-tasks.json` from the shared team path.
2. Extract the tasks array from the board payload.

### Step 2: Run workspace verification
1. Execute `npm run workspace:verify` with a 2-minute timeout.
2. Capture pass/fail status and any failure output.

### Step 3: Generate lane reports
For each lane (delivery, runtime, operations):
1. Filter board tasks by domain.
2. Sort tasks by status rank, priority rank, and blocked state.
3. Identify the top active task per lane.
4. List blocked items.
5. Include workspace verification status in each lane.
6. Runtime lane explicitly notes that live runtime truth is not re-verified by this board-based automation.

### Step 4: Compile top summary and blockers
1. Aggregate primary blockers across all lanes.
2. Determine overall standup status (complete vs partial).
3. Build the top summary with lane focus items.

### Step 5: Archive transcript
1. Write the full standup transcript to `~/.openclaw/projects/shared/team/meetings/<YYYY-MM-DD>-daily-standup.md`.
2. Include YAML frontmatter with standup metadata.

## Validate
- [ ] All 3 lanes reported (even if empty)
- [ ] Workspace verification result is included
- [ ] Transcript was written to the meetings directory
- [ ] Blocked items are surfaced clearly
- [ ] Summary includes: transcript path, workspace verify status, per-lane top task

## Error Handling
- If board data is unavailable: report failure, do not generate empty standup
- If workspace verification times out or fails: include failure in each lane report and in blockers
- If transcript directory doesn't exist: report failure
- If runtime lane has no live probe: explicitly label runtime detail as "not re-verified"

## Output Rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Script
```bash
node scripts/automations/daily-standup.mjs
```
