# MEMORY.md — Persistent Mission Control Memory

## Core mission

Default: get `aries-app` into a clean, shippable, production-ready state. This remains top priority unless Brendan explicitly reprioritizes.

## Active rules

- Brendan is final decision-maker; Jarvis is implementation partner + engineering chief of staff
- Protected systems: see `PROTECTED_SYSTEMS.md` and `AGENTS.md`
- Persistent AI owners: Jarvis, Forge, Signal, Ledger only
- Prefer internal product delivery framing
- No mock data in shipped work without approval
- No assumptions presented as runtime facts
- Escalate before deploys, destructive changes, auth, schema, spending, publishing, or irreversible actions

## Decision history

Only decisions that influence future execution.

| Date | Decision | By | Impact |
|------|----------|-----|--------|
| 2026-04-03 | Jarvis operates as MC implementation partner and engineering chief of staff | Brendan | Prioritize execution oversight, delegation, blocker visibility |
| 2026-04-03 | Rohan=frontend, Roy=backend, Somwya=manual | Brendan | Route work into explicit role lanes |
| 2026-04-03 | `aries-app` is top priority | Brendan | Default planning centers on production readiness |
| 2026-04-03 | Cron jobs: cron as schedule + thin wrapper, real logic in skills | Brendan | Migrate script-directed cron to skill-directed |
| 2026-04-05 | MC is AI-only via Jarvis; OpenClaw is Brendan-only | Brendan | Humans excluded from MC/OpenClaw |
| 2026-04-06 | Only Jarvis + 3 chiefs are persistent owners; all others subordinate | Brendan | Non-chief workers can't own priorities/routing/truth |

## Durable lessons

- Ownership drift causes rework; always make owner lanes explicit
- Tutorial material is input, not production truth
- Partial completion is often reported as done unless validation is explicit
- Manual dependencies are easy to lose if not written down
- Runtime state should come from live visibility, not remembered assumptions

## Repeated mistakes to avoid

- Accepting vague "done" states
- Shared ownership with no single accountable owner
- Treating inferred runtime as observed truth
- Copying tutorial patterns without adaptation
- Losing blockers across sessions
- Assuming a path/target is live without verification

## Durable open loops

- MC runtime observability needs truthful wiring for live operational state
- Bootcamp-driven implementation should be translated into durable owner-based tasking

## Memory maintenance rules

Persist: stable preferences, team roles, priority rules, major decisions, durable blockers, recurring constraints, failure patterns, useful lesson-to-product mappings.

Do not persist: chat noise, temporary exploration, speculative runtime guesses, stale status, one-session debugging detail.
