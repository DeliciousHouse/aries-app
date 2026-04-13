---
name: aries-github-feedback-connector
description: Sync GitHub issues, classify as bug or feature, route each pending item through bug-triage or feature-pipeline skills, and update the processing log.
---

# Aries GitHub Feedback Connector

Syncs open GitHub issues, classifies them as bugs or features, routes each pending item to the appropriate triage/pipeline skill, and updates the processing log.

## Prerequisites
- `gh` CLI authenticated with access to the feedback repo
- `scripts/automations/feedback-connector.mjs` and `lib/github-feedback.mjs` exist
- `data/feedback-processing-log.json` exists or will be created
- `bug-triage` skill available for bug items
- `feature-pipeline` skill available for feature items

## Steps

### Step 1: Sync GitHub issues
1. Run `node scripts/automations/feedback-connector.mjs sync --json`.
2. This fetches open issues from the configured GitHub repo and classifies them.
3. Capture the JSON output with stats and pending items.

### Step 2: Process each pending item
For each pending item returned by the sync:
1. **If type is bug:** Use the `bug-triage` skill to triage the issue.
2. **If type is feature:** Use the `feature-pipeline` skill to evaluate the feature.
3. Record the processing result for each item.

### Step 3: Update the processing log
After each item is processed:
1. Run `node scripts/automations/feedback-connector.mjs mark --number <issue> --patch-json <json>`.
2. This marks the item as processed in `data/feedback-processing-log.json`.
3. Include the triage/pipeline result in the patch JSON.

### Step 4: Compile summary
1. Count: bugs processed, features processed, errors encountered.
2. Note any items batched for the daily summary.

## Validate
- [ ] All pending items were routed to the correct skill (bug-triage or feature-pipeline)
- [ ] Processing log was updated for each processed item
- [ ] No items were silently skipped
- [ ] Summary includes: status, critical_alerts, bugs_processed, features_processed, batched_for_summary, errors

## Error Handling
- If GitHub sync fails: report sync failure and exit — do not process stale data
- If a single item fails triage/pipeline: log the error, continue processing remaining items
- If `mark` command fails: log the error, continue — do not block remaining items
- If bug-triage or feature-pipeline skill is unavailable: report which skill is missing

## Output Rule
Return only: status, critical_alerts, bugs_processed, features_processed, batched_for_summary, errors.
