---
name: aries-runtime-error-repair-loop
description: Triage and repair open Aries runtime incidents from the runtime incident log, using a bounded fix loop with before/after validation and concise summary output for cron delivery. Use when an aries-app runtime or automation error has been logged and should be planned, fixed if safe, validated, and reported back to the AI engineering lane.
---

# Aries Runtime Error Repair Loop

Use this skill to work the next repairable incidents from `data/runtime-error-incidents.json`.

## Read this when needed

- Incident lifecycle and field meanings: `references/repair-contract.md`

## Required inputs

- Repo root: `/home/node/openclaw/aries-app`
- Incident log: `data/runtime-error-incidents.json`

## Required procedure

1. Load the repair queue:
   - `node scripts/automations/runtime-error-intake.mjs pending --json`
2. If there are no pending incidents, return a no-op summary.
3. Process a bounded batch, not just one incident:
   - default target: up to 5 incidents per run
   - prioritize highest severity, then lowest attempt count
   - if several incidents clearly share the same root cause, investigate one representative first and then bulk-handle the matching incidents in the same run
4. Group obvious duplicates before doing deep work. Treat incidents as the same root-cause family when they share most of:
   - `source`
   - same failing stage or validation command
   - same missing binary/path pattern
   - same gateway/runtime failure signature
   - same actionable fix or same escalation reason
5. Record a repair plan before editing anything for every incident you intend to touch in this run:
   - update the incident with `status: repair_planned`
   - write `planSummary`
   - increment `attemptCount`
   - set `lastRepairAttemptAt`
   - use `node scripts/automations/runtime-error-intake.mjs mark --incident <id> --patch-json '<json>'`
6. Investigate the representative root cause using the incident fields:
   - `source`
   - `errorMessage`
   - `details`
   - `validationCommand`
   - `repairHints`
7. Apply the smallest safe fix when a real repo/runtime fix exists.
8. Run the representative incident's `validationCommand`.
9. Run `node scripts/automations/runtime-error-intake.mjs scan --json` after the targeted validation so the log reflects the latest truth.
10. After the scan, update every incident you touched this run:
   - if the root cause is fixed and the incident is no longer pending, mark `resolved`
   - if validation still fails but another bounded retry is safe, mark `retryable`
   - if the issue is unsafe, broad, external, or blocked, mark `escalated`
11. When a whole family shares the same external blocker or same successful fix, bulk-apply the same summary to every matching incident in that family during the same run instead of leaving siblings untouched.
12. If more pending incidents remain after the bounded batch, say so explicitly in `next_step`.

## Guardrails

- Maximum 3 repair attempts per incident.
- Maximum 5 incidents touched per run unless a bulk status update is being applied to clearly identical incidents after one investigation.
- Do not run an infinite repair loop.
- Do not make destructive auth, credential, production deploy, or schema changes without approval.
- Prefer the smallest reversible patch.
- Bulk-escalate or bulk-resolve only when the shared root cause is explicit from evidence. Say when you are inferring a family match.
- Do not claim success without a passing validation command and a fresh intake scan.

## Output format

Return only:
- `status:` success, retryable, escalated, or no-op
- `incidents:` one incident id, a comma-separated list, or `none`
- `severity:` highest severity handled this run, or `none`
- `source:` primary source handled this run, or `none`
- `plan:` one line, including whether this was a single-incident fix or grouped/bulk handling
- `fix:` one line
- `validation:` one line
- `next_step:` one line or `none`
