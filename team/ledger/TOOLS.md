# TOOLS.md — Ledger

## Purpose

This file records the practical environment Ledger should use for Operations & Knowledge work.
Separate verified facts from assumptions.
Do not promote an assumption into truth.

## Verified environment facts
- Workspace root: `/app/aries-app`
- Chief workspace: `/app/aries-app/team/ledger`
- Root policy file: `/app/aries-app/PROTECTED_SYSTEMS.md`
- Jarvis routing file: `/app/aries-app/AGENTS.md`
- Root memory file: `/app/aries-app/MEMORY.md`
- Priority source: `/app/aries-app/PRIORITIES.md`
- Runtime rules: `/app/aries-app/RUNTIME.md`
- Org-chart planning worksheet exists: `/app/aries-app/docs/plans/mission-control-org-chart-episode-1-worksheet.md`
- validated artifacts exist under `/app/aries-app/generated/validated`
- local Mission Control scratch path exists: `/app/mission-control`
- verified Project Board JSON path: `/app/mission-control/server/data/execution-tasks.json`
- verified Project Board API surface: `GET /api/pm-board`, `POST /api/pm-board`, `PATCH /api/pm-board/:id`
- verified Command board route in the local Mission Control app: `/#/command`

## Working assumptions
- Main dashboard surfaces are evolving around Command, Knowledge, Build Lab, Runtime, and Org Chart based on Brendan’s stated operating context.
- A separate live Mission Control source path may exist outside this repo, but it is not verified here as active truth.

## Do not assume without verification
- that any summary equals live runtime truth
- that `/app/mission-control` is the live source serving `control.sugarandleather.com`
- that a remembered host path is active if it is unavailable in this environment
- that manual follow-through is visible unless it has been written down

## Project Board first-check rule
- On startup / standup, check the Project Board in Command first before summarizing Operations & Knowledge work.
- Board JSON source: `/app/mission-control/server/data/execution-tasks.json`
- Board API endpoints: `GET /api/pm-board`, `POST /api/pm-board`, `PATCH /api/pm-board/:id`
- This path is verified locally; it is not a claim about the live hosted source for `control.sugarandleather.com`.

## Useful source files
- `AGENTS.md`
- `MEMORY.md`
- `PRIORITIES.md`
- `RUNTIME.md`
- `README-runtime.md`
- `docs/plans/mission-control-org-chart-episode-1-worksheet.md`
- `generated/validated/project-progress.json`
- `generated/validated/repo-audit-summary.md`

## Documentation and runtime sources
- use local docs first
- use runtime evidence before memory when discussing current state
- use protected-system policy before convenience when documenting ownership

## Protected-system access policy
- Mission Control access policy: via Jarvis delegation only
- OpenClaw access policy: read-only visibility only; no writes
- do not hardcode unverified paths or behavior as facts

## Environment dependencies
- current repo docs and validated artifacts
- evidence from Jarvis, Forge, and Signal handoffs
- any OpenClaw-facing evidence must remain read-only unless Brendan explicitly authorizes Jarvis for a specific change
