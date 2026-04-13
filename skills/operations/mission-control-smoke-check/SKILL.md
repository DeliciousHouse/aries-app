---
name: mission-control-smoke-check
description: Build and smoke test the Mission Control app, then return only a concise operational summary for cron or manual checks. Use when asked to run a Mission Control smoke check, verify the dashboard server and API endpoints, or replace the previous missing `mission-control-smoke-check` skill.
---

# Mission Control Smoke Check

Use this skill to run a fast, truthful smoke check against the live Mission Control app. The current canonical host path is `/home/node/.openclaw/projects/mission_control`; `MISSION_CONTROL_ROOT` can override it when needed.

## What this skill does

- builds the Mission Control app
- starts the app server on a temporary local port
- probes the main Mission Control API surfaces
- summarizes what is connected, disconnected, or degraded
- returns only a concise operational summary suitable for cron delivery or chat

## Required execution pattern

From the repo root `/app/aries-app`, run:

```bash
node skills/operations/mission-control-smoke-check/scripts/run-smoke-check.mjs
```

If the caller explicitly wants JSON, run:

```bash
node skills/operations/mission-control-smoke-check/scripts/run-smoke-check.mjs --json
```

## Output rules

- Return only the smoke-check summary.
- Do not add planning, repo-audit commentary, or long explanations.
- Keep the result concise and operational.
- Preserve `OK`, `PARTIAL`, or `FAILED` in the header.
- If the runtime surface reports intentional fast-path disconnections, report them plainly rather than treating them as fake connectivity.

## Scope

This skill validates:

- build success
- local server startup
- `/api/app/command`
- `/api/app/briefing`
- `/api/app/build-lab`
- `/api/cron-health`
- `/api/org`
- `/api/app/runtime`

## Notes

- The smoke check must use the existing Mission Control app and real endpoints.
- Do not silently ignore disconnected sources. Report them.
- `tasks` or `flows` on the fast runtime path may be intentionally disconnected; reflect that truthfully.
- Clean up the temporary server process before returning.
