# TOOLS.md — Mission Control Operating Environment

## Purpose

This file records practical environment information for `aries-app` and Mission Control work.

It should contain:
- repo references
- useful commands
- service dependencies
- environment constraints
- known defaults
- places where human verification is still required

Do not use this file for generic tool explanations.
Do not treat likely defaults as verified runtime facts unless they have actually been checked.

---

## 1) Workspace and repo references

### Primary workspace
- Default working repo: `/app/aries-app`

This is the configured workspace in the current environment, not a claim about every runtime or deployment target.

### Related Mission Control code location
There is remembered context that live Mission Control work may involve a separate project path outside `/app/aries-app`.

Remembered path from prior context:
- `/home/node/openclaw/projects/mission-control-builder/mission-control`

Status:
- remembered context
- not freshly verified here as live deployment truth

Use this carefully:
- treat it as a likely relevant path if working on the standalone Mission Control deployment
- verify before treating it as the active live source of truth

---

## 2) Mission context

Primary mission:
- complete `aries-app`
- get it into a clean, shippable, production-ready state

Mission Control work should support:
- engineering coordination
- implementation tracking
- blocker visibility
- runtime observability
- delivery follow-through

This environment is for internal product delivery, not client-management workflows.

---

## 3) Team routing reference

- Brendan = final decision-maker
- Jarvis = coordination, routing, synthesis, follow-through, memory discipline
- Rohan = frontend owner
- Roy = backend owner
- Somwya = manual / non-coding / human-required tasks

These are durable role assignments unless Brendan changes them.

---

## 4) Repo and runtime truth rules

When describing environment behavior, distinguish between:
- **verified current state**
- **repo/config default**
- **remembered prior context**
- **inference**

Do not upgrade a likely default into runtime fact without checking.

Examples:
- a checked-in script is repo truth
- an observed running process is runtime truth
- a remembered deployment path is remembered context
- a guessed command is inference

---

## 5) Known development commands

The following are known useful commands from repo context and prior checked instructions.

### Install dependencies
```bash
NODE_ENV=development npm ci
```

Reason:
- there is prior repo context indicating system `NODE_ENV=production` can cause devDependencies to be skipped

Status:
- repo-context guidance
- use as known-good install pattern

### Start dev server
```bash
npx next dev -p 3000 --turbopack
```

Status:
- prior repo-context guidance
- likely correct for local dev in this workspace
- verify if package or framework configuration changes

### Typecheck
```bash
./node_modules/.bin/tsc --noEmit
```

### Run tests
```bash
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/**/*.test.ts
```

Status:
- prior repo-context guidance
- based on known test sensitivity to `APP_BASE_URL`
- treat as known-good test invocation unless the test suite changes

### Precheck
```bash
npm run precheck
```

### Database init
```bash
npm run db:init
```

---

## 6) Environment variable notes

There is prior repo context that system-level environment variables may override `.env`.

Remembered examples:
- `NODE_ENV=production`
- `DB_HOST=...`
- `APP_BASE_URL=...`

Status:
- remembered/repo-context guidance
- not a guaranteed statement about every current runtime without checking

Known useful local override pattern:
```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
```

Treat this as a practical default for local development, not universal runtime truth.

---

## 7) Database notes

There is prior repo context indicating local development may use PostgreSQL 16.

Remembered commands/defaults:
```bash
sudo pg_ctlcluster 16 main start
```

Remembered likely local DB values:
- DB name: `aries_dev`
- DB user: `aries_user`
- DB password: `aries_pass`

Status:
- remembered/repo-context defaults
- verify before treating as current runtime truth

---

## 8) Documentation sources

Use local docs first when available.

Known documentation sources:
- `/app/aries-app/docs`
- `README.md`
- `README-runtime.md`
- `SETUP.md`
- `team/DELEGATION-RULES.md` — canonical delegation, handoff, autonomy, and escalation playbook for Jarvis and the chiefs

OpenClaw references:
- docs mirror: `https://docs.openclaw.ai`
- source: `https://github.com/openclaw/openclaw`

Status:
- these are known source references, not guarantees that every file remains unchanged

---

## 9) Workflow and safety constraints

Do not take these actions without Brendan’s approval:
- production deploys
- auth/credential changes
- schema changes
- deleting data
- infra changes with downtime risk
- external publishing
- spending
- irreversible actions

Do not use mock data in shipped work unless explicitly approved.

Do not mark work complete unless there is:
- a concrete implementation result
- a validation result
- or a clearly stated reason validation is unavailable

---

## 10) Bootcamp-following execution notes

When work originates from a bootcamp/tutorial/reference:
- treat the tutorial as input, not runtime truth
- extract the intended feature or implementation pattern
- map it to `aries-app`
- separate tutorial scaffolding from production requirements
- define frontend/backend/manual tasks
- note what still requires verification

Useful structure:
- source lesson
- intended outcome
- what can be copied directly
- what must be adapted
- what should be ignored
- owner mapping
- blockers / open verification points

---

## 11) Human verification still required

Expect human verification for:
- live deployment targets not yet inspected
- account/dashboard states
- external service credentials and permissions
- manual steps outside repo/runtime visibility
- anything Somwya owns
- final approval for deploys or other high-risk changes
- ambiguous tutorial interpretation when intended product behavior is unclear

When human verification is needed, state:
- what must be verified
- who should verify it
- what evidence confirms it
- what can still proceed meanwhile

---

## 12) Runtime observability note

Mission Control should eventually expose live operational visibility, but do not assume that visibility already exists.

Runtime visibility should be treated as:
- connected and live
- partially connected
- disconnected / unavailable

If disconnected:
- say disconnected
- identify missing wiring if known
- do not fabricate telemetry
