# TOOLS.md — Signal

## Purpose

This file records the practical environment Signal should use for Runtime & Automation work.
Separate verified facts from assumptions.
Do not promote an assumption into truth.

## Verified environment facts
- Workspace root: `/app/aries-app`
- Chief workspace: `/app/aries-app/team/signal`
- Root policy file: `/app/aries-app/PROTECTED_SYSTEMS.md`
- Runtime rules: `/app/aries-app/RUNTIME.md`
- Runtime architecture: `/app/aries-app/README-runtime.md`
- Priority source: `/app/aries-app/PRIORITIES.md`
- OpenClaw-related runtime interaction for Aries is described in `README-runtime.md`
- API handlers exist under `/app/aries-app/app/api`
- backend runtime logic exists under `/app/aries-app/backend`
- validated artifacts exist under `/app/aries-app/generated/validated`
- local Mission Control scratch path exists: `/app/mission-control`
- verified Project Board JSON path: `/app/mission-control/server/data/execution-tasks.json`
- verified Project Board API surface: `GET /api/pm-board`, `POST /api/pm-board`, `PATCH /api/pm-board/:id`
- verified Command board route in the local Mission Control app: `/#/command`
- the remembered host Mission Control path `/home/node/openclaw/projects/mission-control-builder/mission-control` is not present in this environment

## Working assumptions
- Mission Control Runtime and Org Chart surfaces are evolving but may not be fully wired yet.
- Some runtime visibility may depend on OpenClaw surfaces that are partially connected or unavailable here.

## Do not assume without verification
- that repo config equals live runtime state
- that session/task/cron/model visibility is complete
- that `/app/mission-control` is the live source serving `control.sugarandleather.com`
- that a remembered host path is active if it is not present in the current environment

## Useful commands from `package.json`
```bash
npm run precheck
npm run verify
npm run test
npm run test:e2e
npm run automation:verify
npm run automation:daily-brief
npm run automation:system-reference
```

## Project Board first-check rule
- On startup / standup, check the Project Board in Command first before summarizing Runtime & Automation work.
- Board JSON source: `/app/mission-control/server/data/execution-tasks.json`
- Board API endpoints: `GET /api/pm-board`, `POST /api/pm-board`, `PATCH /api/pm-board/:id`
- This path is verified locally; it is not a claim about the live hosted source for `control.sugarandleather.com`.

## Relevant files and runtime sources
- `RUNTIME.md`
- `README-runtime.md`
- `PRIORITIES.md`
- `generated/validated/project-progress.json`
- `generated/validated/repo-audit-summary.md`
- `app/api/*`
- `backend/*`

## APIs and dashboards
- internal API contract is documented in `README-runtime.md`
- Mission Control surfaces named in current operating context: Command, Knowledge, Build Lab, Runtime, Org Chart
- treat dashboard visibility claims as unverified until backed by live/runtime evidence

## Protected-system access policy
- Mission Control access policy: via Jarvis delegation only
- OpenClaw access policy: read-only visibility only; no writes
- do not hardcode live OpenClaw commands or paths as truth without verification

## Environment dependencies
- live runtime / API / event / log / process truth when available
- repo/config truth as fallback only
- any OpenClaw-facing analysis must remain read-only unless Brendan explicitly authorizes Jarvis for a specific change
