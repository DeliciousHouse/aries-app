# PRIORITIES.md

This is the canonical priority document for Aries AI.
It is the single source of truth for roadmap state, active work, blockers, delegated work, decisions, and next actions.
Jarvis owns keeping it current.

## Priority stack

1. **Aries AI** — default top priority unless human explicitly reprioritizes
2. **Future client work** — important, but should be organized through Aries AI rather than displacing it by accident
3. **Future products** — supported as they emerge, without fragmenting the core system

## Strategic operating objective

Build Aries AI into the operating system for managing Aries AI itself, future clients, and future products.
Keep execution honest, organized, delegated where useful, and aligned across product, workflows, integrations, and production.

## Current roadmap source

- Primary roadmap structure: `ROADMAP.md`
- Heartbeat controller: `HEARTBEAT.md`
- Reconciled progress state: `generated/validated/project-progress.json`
- Reconciliation audit summary: `generated/validated/repo-audit-summary.md`

## Current roadmap status

**State:** complete with re-audit required
**Roadmap mode:** historically completed phase machine, but current working tree has drift and needs fresh validation
**Current known phase target:** no active historical phase; current need is repo re-audit against the present working tree

## Active work

- Maintain Jarvis operating identity and authority boundaries
- Maintain the canonical operating structure for the future multi-agent team
- Maintain this canonical priority document
- Reconcile historical roadmap-completion evidence against the current repo working tree
- Keep Aries AI as the explicit center of gravity for execution decisions

## Delegated work

### Mission Control frontend shell
- **Owner:** delegated subagent (`mission-control-builder`), reviewed and patched by Jarvis
- **Live deploy source path:** `/home/node/openclaw/projects/mission-control-builder/mission-control`
- **Local scratch path used during this container session:** `/app/mission-control`
- **Status:** live runtime-backed data layer added in the local scratch project, but the domain-backed service is mounted from the host path above and must be patched there to affect production-facing UI
- **Scope:** separate Aries AI Mission Control project with Ops / Brain / Lab, module runtime adapters, drill-down routes, and Mission Control status driven by real sessions + cron state
- **Constraint:** no writes inside `/app/aries-app`
- **Rule:** no mock data
- **Deploy rule:** when asked to change the live Mission Control served at `control.sugarandleather.com`, treat `/home/node/openclaw/projects/mission-control-builder/mission-control` as the source of truth unless the human explicitly changes the compose mount
- **Verification:** the live domain is only updated when the host-mounted source path above is rebuilt/restarted; local `/app/mission-control` build verification alone is not sufficient

## Blockers

- Current repo working tree is dirty relative to the historical validated-completion artifacts
- Historical roadmap baseline in `ROADMAP.md` is stale relative to later validated artifacts
- Aries Calendar Sync cron remains disabled until a concrete tenant target and valid delivery target are configured

## Recent decisions

### Decision 1
- **Decision:** Treat Aries AI as the default top priority unless human explicitly reprioritizes.
- **Why:** Human set this as standing instruction.
- **Status:** locked in

### Decision 2
- **Decision:** Default to delegating cleanly parallelizable and larger/longer tasks.
- **Why:** Human wants Jarvis to operate as an executive assistant and orchestrator, not a solo bottleneck.
- **Status:** locked in

### Decision 3
- **Decision:** Make ambiguous decisions autonomously, then report them.
- **Why:** Human wants execution speed without unnecessary stalls.
- **Status:** locked in

### Decision 4
- **Decision:** Auto-escalate production deploys, client-facing messages, spending, credential/auth changes, deleting data, database schema changes, downtime-risking infra changes, external publishing, legal/financial commitments, and anything irreversible or high-risk.
- **Why:** These actions carry meaningful external consequence.
- **Status:** locked in

### Decision 5
- **Decision:** Start with a lean multi-agent structure and expand only when actual workload justifies it.
- **Why:** Avoid premature complexity while preserving scalability.
- **Status:** locked in

### Decision 6
- **Decision:** Reconcile the missing heartbeat source-of-truth file by restoring `generated/validated/project-progress.json` with explicit contradiction notes instead of pretending the repo is clean.
- **Why:** The repo contains historical completion evidence, but the current working tree has drift that must be acknowledged honestly.
- **Status:** completed

### Decision 7
- **Decision:** Isolate Mission Control into a separate delegated project under `/app/projects/mission-control-builder/mission-control` instead of placing it in `/app/aries-app`.
- **Why:** Human explicitly reserved `aries-app` for the main OpenClaw agent workspace and wants Mission Control isolated.
- **Status:** completed

## Validation state

- Identity/profile alignment: established
- Canonical operating structure: established
- Canonical priority document: established
- Historical roadmap completion evidence: established
- Restored progress-state file: established
- Current working-tree validation: not yet complete
- Mission Control delegated project: in progress

## Next actions

1. Continue repo audit against the current working tree to determine which historical validation claims still hold now.
2. Wait for the delegated Mission Control build to complete and review the output.
3. Decide whether stale heartbeat instructions should be patched after current audit conclusions are complete.
4. Keep `PRIORITIES.md` current as execution state changes.

## Standing escalation list

Always escalate to human before action when work involves:
- Production deploys
- Client-facing messages
- Spending
- Credential or auth changes
- Deleting data
- Database schema changes
- Infra changes that can cause downtime
- External publishing
- Legal or financial commitments
- Anything irreversible or high-risk

## Maintenance rule

Update this file whenever any of the following changes:
- Priority order
- Roadmap phase or execution state
- Active work
- Delegated work
- Blockers
- Recent decisions
- Validation status
- Next actions
