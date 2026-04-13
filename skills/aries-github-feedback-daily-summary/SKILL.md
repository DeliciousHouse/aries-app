---
name: aries-github-feedback-daily-summary
description: Deliver the daily batch summary for non-critical GitHub feedback items that were processed and logged.
---

# Aries GitHub Feedback Daily Summary

Generates and delivers the end-of-day summary of all GitHub feedback items that were processed during the day.

## Prerequisites
- `scripts/automations/feedback-daily-summary.mjs` and `lib/github-feedback.mjs` exist
- `data/feedback-processing-log.json` contains items processed today
- Items were previously processed by the `aries-github-feedback-connector` skill

## Steps

### Step 1: Generate the daily summary
1. Run `node scripts/automations/feedback-daily-summary.mjs --mark-sent`.
2. The script reads the processing log, compiles items processed since last summary, and generates a batch summary.
3. The `--mark-sent` flag marks summarized items so they are not included in future summaries.

### Step 2: Deliver the summary
1. Return the emitted summary text as the output.

## Validate
- [ ] Summary was generated from actual processed items (not stale or empty)
- [ ] Items included in the summary were marked as sent
- [ ] Output is the raw summary text — no extra wrapping

## Error Handling
- If no items to summarize: report clean empty state, do not fail
- If processing log is missing or corrupt: report failure with the error message
- If `--mark-sent` fails to update log: report the error alongside the summary

## Output Rule
Return only the emitted summary. Do not wrap it in extra commentary.

## Script
```bash
node scripts/automations/feedback-daily-summary.mjs --mark-sent
```
