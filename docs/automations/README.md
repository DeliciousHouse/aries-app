# Aries automation runbook

This workspace now includes runtime-error intake/repair automation alongside the other repo automations plus a ready-to-apply OpenClaw cron installer. The jobs are designed to run as **isolated cron agent turns** so each execution stays separate from the main conversation.

**Production VM release** (GHCR image publish, then `master` push, GitHub Actions deploy) is **not** part of this cron runbook. See repository **`DOCKER.md`** (*Production release*) and **`docs/SYSTEM-REFERENCE.md`** (*Production release (operational)*).

## Files added

- `scripts/automations/manifest.mjs` — canonical job schedule + purpose list
- `scripts/automations/install-openclaw-crons.mjs` — prints or applies `openclaw cron add` commands
- `scripts/automations/verify-automations.mjs` — dry-run verification across the automation scripts
- `scripts/automations/private-repo-backup.mjs`
- `scripts/automations/overnight-self-improve.mjs`
- `scripts/automations/daily-brief.mjs`
- `scripts/automations/feedback-connector.mjs`
- `scripts/automations/feedback-daily-summary.mjs`
- `scripts/automations/runtime-error-intake.mjs`
- `scripts/automations/lib/runtime-errors.mjs`
- `scripts/automations/staging-deploy.mjs`
- `scripts/automations/rolling-system-reference.mjs`
- `docs/SYSTEM-REFERENCE.md` — living architecture reference updated by automation 4
- `docs/briefs/*.md` — morning brief outputs written by automation 3
- `data/runtime-error-incidents.json` — normalized runtime incident log used by the intake and repair loop

## Automation inventory

### 1) Private repo backup

- **Schedule:** `15 */6 * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/private-repo-backup.mjs`
- **What it does:** stages changes, creates a timestamped backup commit message, pushes to the configured GitHub remote, and fails loudly if the push cannot complete.
- **Required config:**
  - `ARIES_BACKUP_REMOTE` (defaults to `origin`)
  - `ARIES_BACKUP_BRANCH` (defaults to current branch)
  - Git credentials already configured for a **private GitHub repo**

### 2) Overnight self-improvement

- **Schedule:** `30 1 * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/overnight-self-improve.mjs`
- **What it does:** rotates across docs drift, backlog hygiene, broken links, stale files, and weak prompts; applies low-risk markdown whitespace cleanup; appends results to `memory/YYYY-MM-DD.md`.

### 3) Daily brief

- **Schedule:** `0 8 * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/daily-brief.mjs`
- **What it does:** writes `docs/briefs/YYYY-MM-DD-brief.md` with priorities, overnight activity, pending actions, and needs-attention items.
- **Optional delivery:** install cron with `--announce` plus `ARIES_CRON_CHANNEL` / `ARIES_CRON_TARGET` to deliver the brief summary to a messaging channel.

### 4) Rolling OS documentation

- **Schedule:** `45 21 * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/rolling-system-reference.mjs`
- **What it does:** refreshes `docs/SYSTEM-REFERENCE.md` with same-day changes, architecture overview, module inventory, cron jobs, and known issues.

### 5) GitHub feedback connector

- **Schedule:** `0 7 * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/feedback-connector.mjs sync`
- **What it does:** pulls open GitHub issues, classifies each as bug or feature, and seeds the pending work queue in `data/feedback-processing-log.json`.
- **Workflow routing:** pending bugs are handled by `skills/bug-triage/SKILL.md`; pending features are handled by `skills/feature-pipeline/SKILL.md`.

### 6) GitHub feedback daily summary

- **Schedule:** `0 18 * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/feedback-daily-summary.mjs --mark-sent`
- **What it does:** batches non-critical processed feedback items into a single delivery summary and clears their `summaryPending` flag.

### 7) Runtime error intake

- **Schedule:** `5,35 * * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/runtime-error-intake.mjs scan`
- **What it does:** runs bounded health checks, opens or reopens runtime incidents in `data/runtime-error-incidents.json`, auto-resolves incidents that no longer reproduce, and emits a concise incident summary for announce delivery.

### 8) CI watcher dispatcher

- **Schedule:** `*/15 * * * *` `America/Los_Angeles`
- **Script:** `node scripts/automations/ci-watcher-dispatch.mjs`
- **What it does:** queries open GitHub issues labeled `ci-watcher` in `DeliciousHouse/aries-app`, inspects existing `ao` sessions for the `aries-app` project, and runs `ao spawn <issue-number>` for every ci-watcher issue that does **not** already have a matching session. Every action (spawned / skipped / errored) is appended to `data/ci-watcher-dispatch-log.json`.
- **De-duplication:** matches by issue number against `session.issueId` across **all** sessions returned by `ao session ls -p aries-app --json`, regardless of status. Once `ao session cleanup` removes a terminal session the issue becomes eligible to spawn again (e.g. when CI is reopened after a merge).
- **Fail-safe:** `gh` or `ao` errors are logged and the script exits `0` so the cron never gets taken down by transient API blips.
- **Complementary to the remote CI watcher trigger:** the remote trigger files ci-watcher issues; this dispatcher is the local side that assigns an ao worker to each one.

### 9) Runtime error repair loop

- **Schedule:** `10,40 * * * *` `America/Los_Angeles`
- **Skill:** `skills/aries-runtime-error-repair-loop/SKILL.md`
- **What it does:** pulls the highest-priority repairable incident from `data/runtime-error-incidents.json`, records a repair plan, applies a bounded fix, validates the result, refreshes the incident log, and emits a concise resolved/retryable/escalated summary.

## Install

### 1. Verify local prerequisites

```bash
cd /home/node/openclaw/aries-app
node scripts/automations/verify-automations.mjs
```

### 2. Configure environment

Minimum for backup:

```bash
export ARIES_BACKUP_REMOTE=origin
export ARIES_BACKUP_BRANCH=main
```

Optional message delivery for cron announce mode:

```bash
export ARIES_CRON_CHANNEL=slack
export ARIES_CRON_TARGET=channel:C1234567890
```

GitHub feedback + staging:

```bash
export ARIES_GITHUB_REPO=DeliciousHouse/aries-app
export ARIES_STAGING_DEPLOY_COMMAND='your staging deploy command here'
export ARIES_STAGING_VERIFY_URL='https://your-staging-url'
# optional
export ARIES_STAGING_VERIFY_TEXT='expected staging marker'
```

### 3. Review generated cron commands

```bash
node scripts/automations/install-openclaw-crons.mjs
```

This prints exact `openclaw cron add ... --session isolated ...` commands for all configured jobs.

### 4. Apply the jobs when ready

No delivery:

```bash
node scripts/automations/install-openclaw-crons.mjs --apply
```

With announce delivery to a configured channel target:

```bash
node scripts/automations/install-openclaw-crons.mjs --apply --announce
```

## Example cron specs

These are the schedules encoded in `scripts/automations/manifest.mjs`:

- `15 */6 * * *` — private repo backup
- `30 1 * * *` — overnight self-improvement
- `0 8 * * *` — daily brief
- `0 7 * * *` — GitHub feedback connector
- `0 18 * * *` — GitHub feedback daily summary
- `5,35 * * * *` — runtime error intake
- `10,40 * * * *` — runtime error repair loop
- `*/15 * * * *` — ci watcher dispatcher
- `45 21 * * *` — rolling OS documentation

## Verification commands

Dry runs:

```bash
node scripts/automations/private-repo-backup.mjs --dry-run
node scripts/automations/overnight-self-improve.mjs --dry-run
node scripts/automations/daily-brief.mjs --dry-run
node scripts/automations/feedback-connector.mjs sync --dry-run
node scripts/automations/feedback-daily-summary.mjs --dry-run
node scripts/automations/runtime-error-intake.mjs scan --dry-run
node scripts/automations/ci-watcher-dispatch.mjs --dry-run
node scripts/automations/rolling-system-reference.mjs --dry-run
```

Feedback loop validation plan:

```bash
cat docs/automations/feedback-loop-test-plan.md
```

Cron visibility:

```bash
openclaw cron list
openclaw cron runs --id <job-id>
openclaw cron run <job-id>
```

## Failure and retry behavior

### Cron-level retries

OpenClaw already retries transient cron failures with exponential backoff. These jobs are intentionally configured for **isolated** execution so retries stay out of the main session.

### Script-level failure behavior

- **Backup:** retries `git push` up to 3 attempts inside the script and exits non-zero on failure.
- **Self-improvement:** writes a concise audit summary and exits non-zero if the filesystem operation fails.
- **Daily brief:** regenerates the markdown output every run; failure is isolated to the brief file.
- **Feedback connector:** fails loudly if GitHub access is missing or if the feedback log cannot be updated.
- **Feedback daily summary:** emits a no-op summary when there is nothing to send.
- **System reference:** rewrites the living reference file from current repo state each run.

### Concise alert output

Each script prints a short final summary like:

- `BACKUP OK`
- `SELF-IMPROVE OK`
- `DAILY BRIEF OK`
- `SYSTEM REFERENCE OK`

That summary is what the isolated cron session should return if `--announce` delivery is enabled.

## Rollback / recovery

### Undo a bad backup commit

```bash
git reset --soft HEAD~1
```

### Remove or disable cron jobs

```bash
openclaw cron list
openclaw cron edit <job-id> --disable
openclaw cron remove <job-id>
```

### Revert automation-generated docs

```bash
git checkout -- docs/SYSTEM-REFERENCE.md docs/briefs
```

### Recover from a bad overnight cleanup

Review the diff first, then revert specific files:

```bash
git diff
# then restore targeted files
git checkout -- <file>
```

## Pending user configuration

These jobs are prepared but **not auto-registered** by default because safe activation still depends on user-specific runtime configuration:

- backup remote + credentials must point at a private GitHub repo
- optional announce delivery needs a real channel/target
- if you want a dedicated cron agent, set `ARIES_CRON_AGENT`
