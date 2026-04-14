# PROTECTED_SYSTEMS.md — Aries App Protected Surface Notes

For this repository, the protected external system is OpenClaw.

## OpenClaw rule

- Read-only inspection is fine when needed for `aries-app` diagnosis.
- Writes, config changes, cron changes, restarts, or other runtime mutations need Brendan's explicit approval.
- Do not treat proposed OpenClaw changes as live state until they are actually applied.

## Repo-boundary rule

`aries-app` must not absorb implementation notes, prompts, routes, or deployment rules for sibling projects.
If a request belongs elsewhere, keep this repo unchanged and say so explicitly.
