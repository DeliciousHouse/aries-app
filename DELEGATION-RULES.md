# DELEGATION-RULES.md — Aries App Delegation Rules

Use this file to keep delegated work inside the `aries-app` repo boundary.

## Core rules

- Delegate only bounded `aries-app` work.
- Name the acceptance target before dispatching work.
- Use current repo files and live validation as the source of truth.
- If a task belongs to another project, stop and route it elsewhere instead of blending it into this repo.

## Required handoff fields

Every non-trivial delegation should include:
- objective
- allowed source files or directories
- expected output
- validation target
- blocker path

## Closure rules

Before calling delegated work done:
- verify the requested files changed
- verify the acceptance target passed or clearly failed
- state what is now true versus still unverified

## Never do this

- use sibling-project docs as source-of-truth for `aries-app`
- leave cross-project notes in repo-facing context files
- claim completion without validation
