# TOOLS.md — Forge

## Purpose

This file records the practical environment Forge should use for Engineering Delivery work.
Separate verified facts from assumptions.
Do not promote an assumption into truth.

## Verified environment facts
- Workspace root: `/app/aries-app`
- Chief workspace: `/app/aries-app/team/forge`
- Root policy file: `/app/aries-app/PROTECTED_SYSTEMS.md`
- Jarvis routing file: `/app/aries-app/AGENTS.md`
- Priority source: `/app/aries-app/PRIORITIES.md`
- Runtime visibility rules: `/app/aries-app/RUNTIME.md`
- Runtime architecture doc: `/app/aries-app/README-runtime.md`
- App/API code exists under `/app/aries-app/app` and `/app/aries-app/backend`
- Tests exist under `/app/aries-app/tests`
- Validated artifacts exist under `/app/aries-app/generated/validated`
- Local Mission Control scratch path exists: `/app/mission-control`
- Verified Project Board JSON path: `/app/mission-control/server/data/execution-tasks.json`
- Verified Project Board API surface: `GET /api/pm-board`, `POST /api/pm-board`, `PATCH /api/pm-board/:id`
- Verified Command board route in the local Mission Control app: `/#/command`

## Working assumptions
- Dashboard surfaces are evolving around Command, Knowledge, Build Lab, Runtime, and Org Chart based on Brendan’s stated operating context.
- A separate live Mission Control source path may exist outside this repo, but it is not verified here as the active source of truth.

## Do not assume without verification
- that `/app/mission-control` is the live source serving `control.sugarandleather.com`
- that OpenClaw runtime visibility is fully wired today
- that any human owns Mission Control or OpenClaw work
- that a repo script implies live runtime health

## Useful commands from `package.json`
```bash
npm run typecheck
npm run build
npm run test
npm run test:e2e
npm run precheck
npm run verify
npm run validate:public-routes
npm run validate:marketing-flow
```

## Project Board first-check rule
- On startup / standup, check the Project Board in Command first before summarizing current Engineering Delivery work.
- Board JSON source: `/app/mission-control/server/data/execution-tasks.json`
- Board API endpoints: `GET /api/pm-board`, `POST /api/pm-board`, `PATCH /api/pm-board/:id`
- This path is verified locally; it is not a claim about the live hosted source for `control.sugarandleather.com`.

## Relevant code and docs
- `app/api/*`
- `backend/*`
- `components/*`
- `generated/validated/project-progress.json`
- `generated/validated/repo-audit-summary.md`
- `generated/validated/canonical-roadmap-baseline.md`
- `docs/plans/mission-control-org-chart-episode-1-worksheet.md`

## APIs and runtime surfaces
- Public + internal Aries routes are documented in `README-runtime.md`
- Delivery-facing API handlers live under `app/api/*`
- Runtime truth must come from live signals first, repo truth second

## Protected-system access policy
- Mission Control access policy: via Jarvis delegation only
- OpenClaw access policy: read-only visibility only; no writes
- Human team members have no Mission Control or OpenClaw write lane

## Environment dependencies
- Next.js app runtime
- repo-local tests and validation scripts
- any live OpenClaw evidence must be treated as read-only unless Brendan explicitly authorizes Jarvis for a specific change
