# MEMORY.md — Persistent Aries App Memory

## Core mission

Default: get `aries-app` into a clean, shippable, production-ready state.

## Active rules

- Brendan is the final decision-maker
- Keep work scoped to `aries-app`
- Do not let sibling-project context bleed into this repo
- No mock data in shipped work without approval
- No assumptions presented as runtime facts
- Escalate before destructive, irreversible, or scope-changing actions

## Decision history

Only decisions that influence future execution.

| Date | Decision | By | Impact |
|------|----------|-----|--------|
| 2026-04-14 | Tighten repo boundary so `aries-app` excludes sibling-project code and identity drift | Brendan | Future work must stay scoped and boundary checks should fail fast |

## Durable lessons

- Boundary drift compounds quickly when identity files are wrong
- A small automated guard is cheaper than another cleanup pass
- Repo context should come from current files, not remembered adjacent projects

## Repeated mistakes to avoid

- Copying sibling-project language into repo-facing docs or prompts
- Treating unrelated paths, services, or dashboards as part of `aries-app`
- Accepting "temporary" cross-project notes in source-of-truth files
