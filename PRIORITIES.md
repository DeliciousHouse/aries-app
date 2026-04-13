# PRIORITIES.md

This is the canonical priority document for Aries AI.
It is the single source of truth for near-term blocker order, persistent-owner accountability, execution-governance focus, and next actions.
Jarvis owns keeping it current.

## Priority stack

1. **Ship `aries-app`**
2. **Keep Mission Control trustworthy**
3. **Stabilize automation reliability**

## Current source set

Use these sources in this order when reconciling priority truth:
- live runtime / validation evidence when available
- `generated/validated/project-progress.json`
- `/home/node/.openclaw/projects/shared/team/execution-tasks.json` for live board task state
- `data/org-chart.json` for board actor ids and assignee validation
- `AGENTS.md`
- `PROTECTED_SYSTEMS.md`
- `DELEGATION-RULES.md`

## Current operating state

- **State:** active remediation and execution-governance correction
- **Phase:** `freeze-production-contract`
- **Validated next persistent owner from `generated/validated/project-progress.json`:** `jarvis`
- **Validated subordinate execution label from `generated/validated/project-progress.json`:** `aries-prod`
- **Governance interpretation:** `aries-prod` is not a persistent owner. Under current repo governance it is, at most, a subordinate specialist/task label that must run under Jarvis or a chief.

## Active work

1. Freeze the production workflow and route contract.
2. Remove or demote unsupported stubbed routes from the supported surface.
3. Reconcile route/manifests/docs with executable truth.
4. Recover local Lobster fallback integrity after the production contract is frozen.
5. Improve Lobster history visibility only after a real source is verified.
6. Keep execution-governance aligned across repo truth, board truth, and runtime behavior.
7. Recover the timed-out cron summary jobs so automation reliability matches the stated priority stack.

## Active blocker focus order

### 1) `workflow-target-contract-drift`
- **Why it matters:** The workflow catalog and the tested marketing pipeline contract disagree. Shipping against a split contract invites bad routing, false completion, and incorrect automation behavior.
- **System affected:** `aries-app` workflow targets, marketing pipeline contract, automation entrypoints
- **Assigned persistent owner:** Jarvis
- **Category:** contract blocker
- **Done means:**
  - one canonical production workflow-target mapping is frozen
  - tested marketing pipeline behavior matches the documented contract
  - unsupported workflow mappings are removed, demoted, or clearly marked unsupported
  - manifests/docs/routes agree with the tested execution path
- **Must not regress:**
  - no supported workflow route may point at an unverified target
  - no manifest/doc may contradict the tested production contract
  - no specialist may treat stale workflow mappings as source-of-truth

### 2) `stub-routes-still-exposed`
- **Why it matters:** UI-facing stub routes make the supported surface look broader than it really is. That weakens integrity and creates false expectations for onboarding, publish, calendar, and integration flows.
- **System affected:** `aries-app` route surface, supported product contract, UI integrity
- **Assigned persistent owner:** Jarvis
- **Category:** contract blocker
- **Done means:**
  - unsupported parity/stub routes are either implemented, hidden, or explicitly demoted from the supported production surface
  - route exposure matches what the product can actually execute
  - user-facing navigation and manifests no longer imply stubbed capability is production-ready
- **Must not regress:**
  - no stub route may remain exposed as a supported path without explicit approval
  - no UI copy or manifest may imply production support where only parity scaffolding exists

### 3) `route-and-doc-drift`
- **Why it matters:** Route manifests and runtime docs that lag the executable app erode code integrity and make handoffs, audits, and validation unreliable.
- **System affected:** route manifests, runtime docs, support docs, repo contract clarity
- **Assigned persistent owner:** Jarvis
- **Category:** integrity blocker
- **Done means:**
  - route/manifests/docs are reconciled against the executable app and current tests
  - supported surfaces, unsupported surfaces, and deferred surfaces are documented consistently
  - heartbeat and audit flows can rely on repo truth without inheriting stale route claims
- **Must not regress:**
  - docs must not outrun executable truth
  - route support claims must not be copied forward from stale artifacts without revalidation

### 4) `local-lobster-fallback-regression`
- **Why it matters:** The local fallback path is failing when the gateway is unavailable, which undermines local parity and makes integrity checks unreliable.
- **System affected:** local Lobster fallback behavior, local parity validation, marketing-pipeline resume path
- **Assigned persistent owner:** Signal
- **Category:** integrity blocker
- **Done means:**
  - the failing local fallback test passes without depending on gateway availability
  - the fallback path is verified against the intended local execution contract
  - the repaired path is documented clearly enough that future local validation does not guess at behavior
- **Must not regress:**
  - local fallback must not silently depend on gateway-only behavior
  - local validation must not report a clean state while the gateway-less fallback path is broken

### 5) `wire-lobster-monitor-history`
- **Why it matters:** Mission Control should not fabricate Lobster history. Visibility must stay truthful until a real history source is connected.
- **System affected:** Mission Control runtime visibility, Lobster/TaskFlow monitoring, operator trust
- **Assigned persistent owner:** Signal
- **Category:** visibility blocker
- **Done means:**
  - a real Lobster / TaskFlow history source is identified and verified
  - Mission Control renders that source truthfully, including empty/error states
  - board/runtime surfaces clearly distinguish real history from unavailable wiring
- **Must not regress:**
  - no fabricated Lobster history
  - no runtime panel may imply connected history when the source is still missing or empty-by-unknown-cause

### 6) `cron-summary-timeouts`
- **Why it matters:** Automation reliability is already a top-three priority, but key summary jobs are currently failing on timeouts. That hides state, weakens daily operating rhythm, and leaves backlog visibility stale.
- **System affected:** daily brief, daily standup, GitHub feedback daily summary, cron reliability
- **Assigned persistent owner:** Signal
- **Category:** automation blocker
- **Reality observed:** as of 2026-04-11, live cron state shows timeout failures on `Aries daily brief`, `Aries daily standup`, and `Aries GitHub feedback daily summary`
- **Done means:**
  - the timed-out summary jobs complete successfully within bounded runtimes
  - timeout causes are understood and documented
  - the repaired jobs resume delivering usable summaries on schedule
- **Must not regress:**
  - summary jobs must not silently fail for multiple runs in a row
  - backlog/briefing surfaces must not imply healthy automation when cron state is timing out

## Governance correction focus

The current governance correction is part of active execution, not a side note.

Required operating rule now:
- persistent AI owners only: Jarvis, Forge, Signal, Ledger
- all other named workers are subordinate specialists, temporary sub-agents, or task labels
- no non-chief agent may own priorities, routing, or source-of-truth decisions
- chief model normalization to `gpt-5.4` is desired policy, but any OpenClaw change remains Brendan-gated and proposal-only until explicitly approved

## Next actions

1. Freeze the canonical production workflow-target contract.
2. Remove or demote unsupported stub routes from the supported surface.
3. Reconcile route/manifests/docs with executable truth.
4. After the production contract freeze, repair the local Lobster fallback regression.
5. Verify a real Lobster history source before expanding Mission Control runtime history.
6. Keep `PRIORITIES.md`, `AGENTS.md`, `PROTECTED_SYSTEMS.md`, `DELEGATION-RULES.md`, and `data/org-chart.json` aligned.
7. Recover the timed-out summary cron jobs and verify they complete within their configured windows.

## Standing escalation list

Always escalate to Brendan before action when work involves:
- OpenClaw changes
- production deploys
- credential or auth changes
- deleting data
- database schema changes
- downtime-risking infra changes
- spending
- external publishing
- legal or financial commitments
- anything irreversible or high-risk

## Maintenance rule

Update this file whenever any of the following changes:
- blocker order
- persistent owner assignment
- supported production contract
- governance operating rule
- next-action sequence
- protected-system boundaries
