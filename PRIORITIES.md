# PRIORITIES.md

This file is the canonical short priority list for `aries-app`.
Use it for daily brief generation and repo-scoped execution only.

## Current priorities

- [ ] Keep `aries-app` boundary-safe and prevent sibling-project drift.
- [ ] Reconcile docs, routes, and tests against executable `aries-app` truth.
- [ ] Strengthen marketing flow runtime validation and approval safety.
- [ ] Improve local setup clarity for Postgres and OpenClaw-backed development.
- [ ] Keep automation scripts fast, truthful, and scoped to this repository.

## Working rules

- Prefer live validation and current repo files over remembered context.
- Do not add cross-project governance, deployment, or dashboard instructions here.
- Treat this file as a concise execution surface, not a historical archive.

## Escalate before

- production deploys
- destructive data changes
- auth or credential changes
- database schema changes
- irreversible or high-risk operations
