---
name: aries-rolling-system-reference
description: Refresh docs/SYSTEM-REFERENCE.md with current architecture, module inventory, cron jobs, runtime scripts, and known issues.
---

# Aries Rolling System Reference

Nightly refresh of the system reference document that captures architecture, file inventory, cron schedules, and known issues.

## Prerequisites
- `package.json` exists (source for runtime scripts)
- `scripts/automations/manifest.mjs` importable (source for cron job listing)
- Git history available for today's changes

## Steps

### Step 1: Capture today's changes
1. Run `git log --since=midnight --name-only` to list files changed today.
2. Deduplicate and take up to 30 file paths.

### Step 2: Build module inventory
1. Count files in each major directory: `app/`, `backend/`, `components/`, `hooks/`, `lib/`, `scripts/`, `skills/`, `workflows/`.
2. Report file count per directory.

### Step 3: Document active cron jobs
1. Import `automationJobs` from `manifest.mjs`.
2. List each job with name, cron schedule, timezone, and purpose.

### Step 4: Document runtime scripts
1. Parse `package.json` scripts section.
2. List each script name and command.

### Step 5: Append known issues
1. Include the hardcoded known-issues list (cron registration status, doc quality dependency, Mission Control shell status).

### Step 6: Capture working tree snapshot
1. Run `git status --short` and include up to 20 lines.

### Step 7: Write the reference document
1. Assemble all sections into `docs/SYSTEM-REFERENCE.md`.
2. Include generation timestamp and reference date.

## Validate
- [ ] `docs/SYSTEM-REFERENCE.md` was written
- [ ] Module inventory reflects current directory structure
- [ ] Cron jobs section matches `manifest.mjs`
- [ ] Summary includes: file path, changed files count, cron jobs documented

## Error Handling
- If `package.json` is missing: scripts section shows empty
- If no git activity today: changes section shows "No git-tracked file changes detected"
- If working tree is clean: snapshot shows "Working tree clean at refresh time"

## Output Rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Script
```bash
node scripts/automations/rolling-system-reference.mjs
```
