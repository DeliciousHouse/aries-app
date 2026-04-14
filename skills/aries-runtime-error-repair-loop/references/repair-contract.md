# Repair-loop contract

Use the repair loop only for incidents opened by `scripts/automations/runtime-error-intake.mjs`.

## Safe repair sequence

1. Read the highest-priority pending incidents.
2. Build a bounded batch for this run, usually up to 5 incidents.
3. Collapse obvious duplicate/root-cause families before deep investigation.
4. Write the plan into the incident log before editing files for each incident you will touch.
5. Apply one bounded repair attempt to the representative issue.
6. Run the representative incident's `validationCommand`.
7. Run a fresh intake scan so the incident log reflects current truth.
8. Mark every incident touched in the batch as resolved, retryable, or escalated.
9. When the evidence shows the remaining siblings share the same root cause or same successful fix, bulk-apply the same status and summary instead of leaving them untouched.

## Source-specific hints

- `workspace-verify`
  - Check `scripts/verify-canonical-workspace.mjs`
  - Check renamed or missing repo-root files
- `runtime-precheck`
  - Check `scripts/runtime-precheck.mjs`
  - Prefer fixing missing files or mismatched package script contracts
- `automation-verify`
  - Check `scripts/automations/verify-automations.mjs`
  - Then inspect the automation script named in the failing output
- `build`
  - Use the first concrete compiler/build error as the primary root-cause candidate

## Bulk-handle instead of one-by-one when

- several incidents have the same `source` and nearly identical `errorMessage`
- several incidents share the same missing binary/path/runtime dependency
- one validation run proves the fix or blocker for the whole family
- the remaining work would otherwise just repeat the same escalation or resolution note across siblings

## Escalate instead of forcing a fix when

- the repair would require credentials or provider secrets
- the repair would change production infra or external systems
- the repair would require a broad refactor instead of a bounded patch
- three attempts have already failed
