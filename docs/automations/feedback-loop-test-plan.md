# GitHub feedback loop test plan

Use this plan to validate the new bug + feature automation loop end to end.

## Prerequisites
- `gh auth status` succeeds for `DeliciousHouse/aries-app`
- staging hook configured:
  - `ARIES_STAGING_DEPLOY_COMMAND`
  - optional `ARIES_STAGING_VERIFY_URL`
  - optional `ARIES_STAGING_VERIFY_TEXT`
- cron delivery target configured if you want announcements outside the CLI run

## Recommended seed issues
Create two temporary GitHub issues in `DeliciousHouse/aries-app`:

### 1. Bug issue
- title like `Bug: dashboard crashes when ...`
- add the `bug` label
- include clear repro steps and expected vs actual behavior

### 2. Feature issue
- title like `Feature request: add ...`
- add the `enhancement` label
- include the user value and rough acceptance criteria

## Step 1. Sync and classify
```bash
node scripts/automations/feedback-connector.mjs sync --json
node scripts/automations/feedback-connector.mjs pending --type bug --json
node scripts/automations/feedback-connector.mjs pending --type feature --json
cat data/feedback-processing-log.json
```

Validate:
- both issues appear in the log
- the bug is classified as `bug`
- the feature is classified as `feature`
- both are `pending`

## Step 2. Dry-run staging hook
```bash
node scripts/automations/staging-deploy.mjs --issue 999 --branch test-branch --dry-run
```

Validate:
- the configured deploy command is shown
- the verify URL is shown when configured

## Step 3. Manual workflow run via cron payloads
Run the connector job once after install:
```bash
openclaw cron list
openclaw cron run <connector-job-id>
```

Then run the summary job:
```bash
openclaw cron run <summary-job-id>
```

Validate:
- connector processes pending issues and updates the log
- bug records include severity, branch, root cause, before/after validation, and staging URL
- feature records include effort, impact, alignment, decision, and staging URL or rejection reason
- non-critical items remain `summaryPending: true` until the summary job runs
- after the summary job, summarized items flip to `summaryPending: false`

## Step 4. Re-run the connector with no new issues
```bash
node scripts/automations/feedback-connector.mjs sync
```

Validate:
- no duplicate work is created
- unchanged issues are not requeued

## Step 5. Requeue behavior
Edit one of the GitHub issues, then run:
```bash
node scripts/automations/feedback-connector.mjs sync --json
```

Validate:
- the updated issue is moved back to `pending`
- the log history records `issue-updated-requeued`

## Step 6. Automated regression test
```bash
./node_modules/.bin/tsx --test tests/feedback-connector.test.ts
```

Validate:
- classification and daily-summary formatting tests pass

## Cleanup
- close or delete the temporary test issues
- remove any temporary staging branch/PR created during the validation run
