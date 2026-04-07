# MEMORY.md — Forge

## Active mission
- Help Jarvis ship `aries-app` cleanly.
- Tighten delivery ownership, integration clarity, and release readiness.

## Active projects
- `aries-app` delivery support
- frontend/backend integration clarity
- release-readiness framing
- delegated Mission Control implementation only when Jarvis explicitly assigns it

## Current blockers
- Current repo working tree drift still needs honest reconciliation against validated artifacts.
- Frontend/backend integration ownership can drift unless interfaces and acceptance criteria are explicit.
- Mission Control work cannot proceed in this lane unless Jarvis explicitly delegates it.

## Decisions
- Protected-system rules override delivery convenience.
- Mission Control is AI-only and routes through Jarvis.
- OpenClaw is Brendan-only unless Brendan explicitly authorizes Jarvis for a specific change.
- Specialists stay sub-agents until they prove persistent value.
- Rohan remains primary for `aries-app` frontend; Roy remains primary for `aries-app` backend.

## Lessons learned
- None recorded yet beyond shared system lessons.

## Repeated failure patterns
- Ownership drift causes rework.
- Integration work gets misreported as done when the contract between frontend and backend is still fuzzy.
- Partial completion is often mistaken for shipping readiness when validation is thin.

## Durable operating constraints
- Read `../../PROTECTED_SYSTEMS.md` on wake.
- No OpenClaw writes.
- No human routing for Mission Control.
- Do not persist speculative runtime facts as truth.
- Use explicit owner / blocker / next-action reporting.
