# Aries automation runbook

This runbook documents the cron automation surface under `scripts/automations/` and the installer in `scripts/automations/install-openclaw-crons.mjs`.

Cron jobs are registered as OpenClaw **isolated sessions** and point to skill prompts generated from `scripts/automations/manifest.mjs`.

Production VM release flow is out of scope for this page. See `DOCKER.md` and `docs/SYSTEM-REFERENCE.md`.

## Canonical sources

- `scripts/automations/manifest.mjs` is the source of truth for job IDs, schedules, and purposes.
- `scripts/automations/install-openclaw-crons.mjs` prints or applies `openclaw cron add/edit` commands from that manifest.
- `scripts/automations/verify-automations.mjs` runs preflight checks for all automation scripts and dry runs for the safe subset.

## Cron job inventory

All jobs below use timezone `America/Los_Angeles`.

| Job ID | Schedule | Skill | Script surface | Output / side effects |
| --- | --- | --- | --- | --- |
| `aries-private-repo-backup` | `15 */6 * * *` | `aries-private-repo-backup` | `scripts/automations/private-repo-backup.mjs` | Creates/updates backup branch + backup PR on GitHub, restores original workspace branch |
| `aries-overnight-self-improve` | `0 4 * * *` | `aries-overnight-self-improve` | `scripts/automations/overnight-self-improve.mjs` | Emits nightly context summary from build log, feedback log, and board |
| `aries-daily-brief` | `0 8 * * *` | `aries-daily-brief` | `scripts/automations/daily-brief.mjs` | Writes `docs/briefs/YYYY-MM-DD-brief.md` |
| `aries-github-feedback-connector` | `0 7 * * *` | `aries-github-feedback-connector` | `scripts/automations/feedback-connector.mjs sync` | Syncs/classifies GitHub issues into `data/feedback-processing-log.json` |
| `aries-github-feedback-daily-summary` | `0 18 * * *` | `aries-github-feedback-daily-summary` | `scripts/automations/feedback-daily-summary.mjs --mark-sent` | Builds daily feedback summary, optionally marks items sent |
| `aries-system-reference-rollup` | `45 21 * * *` | `aries-rolling-system-reference` | `scripts/automations/rolling-system-reference.mjs` | Rewrites `docs/SYSTEM-REFERENCE.md` |
| `aries-daily-standup` | `0 9 * * 1-5` | `aries-daily-standup` | `scripts/automations/daily-standup.mjs` | Writes board-derived standup transcript to shared meetings path |
| `aries-weekly-review` | `0 14 * * 5` | `aries-weekly-review` | `scripts/automations/weekly-review.mjs` | Writes weekly Markdown + HTML review under `memory/reviews/`; optional email delivery |

## Setup and install

### 1. Verify prerequisites

```bash
cd /app/aries-app
node scripts/automations/verify-automations.mjs
```

`verify-automations` executes:

- `--preflight` for all automation scripts (including backup and overnight self-improve).
- `--dry-run` for: `daily-brief`, `daily-standup`, `feedback-connector`, `feedback-daily-summary`, `rolling-system-reference`, and `weekly-review`.
- Mission Control smoke check JSON output via `skills/operations/mission-control-smoke-check/scripts/run-smoke-check.mjs --json`.

### 2. Configure environment

Baseline:

```bash
export ARIES_CRON_AGENT=default
```

Backup job:

```bash
export ARIES_BACKUP_REMOTE=origin
# optional if running from detached HEAD
export ARIES_BACKUP_BASE_BRANCH=master
# optional override; default is backup/<base-branch>
export ARIES_BACKUP_BRANCH=backup/master
```

Feedback jobs:

```bash
export ARIES_GITHUB_REPO=DeliciousHouse/aries-app
```

Weekly review optional email:

```bash
export ARIES_WEEKLY_REVIEW_EMAIL='team@example.com'
export ARIES_WEEKLY_REVIEW_EMAIL_SCRIPT="$HOME/scripts/gmail-send.py"
```

Optional announce delivery for cron messages:

```bash
export ARIES_CRON_CHANNEL=slack
export ARIES_CRON_TARGET=channel:C1234567890
```

### 3. Review generated cron commands

```bash
node scripts/automations/install-openclaw-crons.mjs
```

### 4. Apply cron jobs

```bash
node scripts/automations/install-openclaw-crons.mjs --apply
```

With announce delivery:

```bash
node scripts/automations/install-openclaw-crons.mjs --apply --announce
```

## Verification and troubleshooting

Useful dry runs:

```bash
node scripts/automations/private-repo-backup.mjs --dry-run
node scripts/automations/daily-brief.mjs --dry-run
node scripts/automations/daily-standup.mjs --dry-run
node scripts/automations/feedback-connector.mjs sync --dry-run
node scripts/automations/feedback-daily-summary.mjs --dry-run
node scripts/automations/rolling-system-reference.mjs --dry-run
node scripts/automations/weekly-review.mjs --dry-run
```

Cron runtime inspection:

```bash
openclaw cron list
openclaw cron runs --id <job-id>
openclaw cron run <job-id>
```

Feedback loop test plan:

```bash
less docs/automations/feedback-loop-test-plan.md
```

## Behavior and constraints

- Backup automation only accepts GitHub remotes and requires both `git` and `gh`.
- Backup pushes with `--force-with-lease`, retries push attempts internally up to 3 times, and updates or creates one open backup PR per backup branch.
- Daily standup is explicitly board-derived and may report `partial` when live runtime truth is unavailable.
- Weekly review pulls from board + git + cron + compose runtime surfaces and writes both Markdown and HTML artifacts.
- System reference rollup rebuilds `docs/SYSTEM-REFERENCE.md` from current repo/runtime state each run.

## Rollback / recovery

Disable or remove cron jobs:

```bash
openclaw cron list
openclaw cron edit <job-id> --disable
openclaw cron remove <job-id>
```

Revert generated documentation:

```bash
git checkout -- docs/SYSTEM-REFERENCE.md docs/briefs memory/reviews
```

Recover from a problematic run:

```bash
git diff
git checkout -- <file>
```
