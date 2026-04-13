# DELEGATION-RULES.md — Canonical Delegation, Ownership, and Specialist Control

This file is the canonical delegation, handoff, autonomy, and specialist-governance playbook for Jarvis and the chiefs.
Apply it together with `../PROTECTED_SYSTEMS.md`.

## Purpose

Use this file to keep execution-governance aligned across:
- repo truth
- Project Board truth
- runtime behavior
- specialist dispatch behavior

It exists to prevent:
- non-owner drift
- free-floating specialist authority
- boardless work
- stale-source execution
- source-of-truth confusion

## Canonical persistent owner set

Only these AI actors are persistent owners:
- Jarvis (`default`)
- Forge (`delivery-chief`)
- Signal (`runtime-chief`)
- Ledger (`knowledge-chief`)

Persistent owners may:
- own priorities
- own routing decisions
- own source-of-truth reconciliation
- accept or reject delegated work
- decide whether work stays direct or goes to a specialist
- own board-facing status and next actions within their lane

## Non-persistent worker rule

All other named workers are subordinate specialists, temporary sub-agents, or task labels.
This includes named runtime/configured agents such as:
- `aries-main`
- `aries-prod`
- `aries-local`
- `aries-validator`
- any future non-chief named worker

Rules:
- They do **not** become persistent owners merely because a runtime config entry or session exists.
- They may execute bounded work only under Jarvis or a chief.
- They may not own priorities.
- They may not own routing.
- They may not become the source-of-truth owner for product, governance, Mission Control, or OpenClaw decisions.
- They may not close a board task without a persistent owner accepting the result.

## Source-of-truth hierarchy for delegated work

When preparing a delegation or specialist prompt, classify sources in this order:
1. live runtime / API / log / process / scheduler truth
2. repo / config / code truth
3. Project Board truth
4. durable memory
5. inference

Rules:
- state which sources are live versus repo-based
- do not present repo expectations as runtime fact
- do not let memory override repo or runtime truth
- do not let a specialist invent certainty where source truth is missing

## Board linkage rule

Use `/home/node/.openclaw/projects/shared/team/execution-tasks.json` as the execution board.
Do not create a second board system.

Rules:
- meaningful delegated work must link to a board task id
- if no board task exists yet, Jarvis or the owning chief must create the board task before dispatching a specialist-sized implementation run
- board ownership stays with a persistent owner unless a deliberate persistent-owner reassignment is made
- specialist runs may be mentioned in notes, but the board remains the owner/status system
- `data/org-chart.json` is the canonical owner tree for board-compatible actor ids and specialist parent-chief relationships

## Required specialist dispatch gate

A specialist run must not be dispatched until **all** of the following are explicit:
- owning chief or Jarvis
- board task id
- source set
- expected output
- acceptance target
- return path

If any of these are missing, keep the work with Jarvis or the owning chief until the contract is complete.

## Required specialist run contract

Every specialist run must carry this exact contract shape:
- **owning chief / sponsor:** who owns the run and accepts the result
- **board task id:** the single linked execution-board task
- **objective:** the bounded task being executed
- **source set:** exact files, runtime surfaces, docs, or tests the specialist may treat as inputs
- **expected output:** code, audit note, patch, validation result, proposal, or incident summary expected back
- **acceptance target:** the test, validation condition, diff boundary, or decision-ready output that determines completion
- **return path:** who receives the result and what happens next
- **protected-system status:** whether the work touches Mission Control, OpenClaw, or neither
- **blocker path:** who the specialist escalates to when blocked

## Dispatch rules by owner

### Jarvis may dispatch specialists when
- the work is cross-owner glue
- the work is a bounded execution slice under Jarvis control
- governance or protected-system classification is already settled
- the board linkage is explicit

### Chiefs may dispatch specialists when
- the work sits cleanly inside the chief’s lane
- the chief remains the accountable persistent owner
- the specialist contract is complete
- protected-system rules still allow the delegation

### Chiefs must not dispatch when
- the task still needs Jarvis routing judgment
- the board task is missing
- the source set is unclear
- the task implies OpenClaw writes
- the task would route Mission Control work to a human

## Legacy runtime-agent handling

If a chief or Jarvis chooses to use a named runtime/configured worker such as `aries-prod`, `aries-local`, `aries-validator`, or `aries-main`, treat it as a specialist implementation choice, not as a persistent owner.

Rules:
- `aries-main` is a subordinate orchestration label at most; it is not a parallel authority structure
- `aries-prod`, `aries-local`, and `aries-validator` are specialist/task labels at most unless Brendan later changes repo governance explicitly
- if used, they still require the full specialist run contract above
- if they produce output, a persistent owner must reconcile it into repo truth or board truth

## Protected-system overlay

Apply `../PROTECTED_SYSTEMS.md` exactly.

Additional enforcement:
- Mission Control work remains AI-only
- OpenClaw changes remain Brendan-gated
- OpenClaw proposal work must be marked **proposal-only / Brendan review**
- no specialist, chief, or human may treat an unapplied OpenClaw proposal as live state

## Return and closure rules

When a specialist returns work, the owning persistent owner must do the closure step.

Closure requires:
- verify the acceptance target was actually met
- classify what is now true versus still unverified
- update the board status, blocker state, or next action if needed
- reconcile repo truth if the task changed a canonical file
- route any protected-system proposal back through the right approval path

## Monitoring rules

Minimum rules:
- do not call a specialist stalled before 10 minutes unless there is a hard failure earlier
- check `updatedAt`, recent activity, and actual progress first
- empty messages alone do not prove a stall
- if a specialist stalls, terminate or respawn through the safest valid workflow
- log the stall and surface the blocker clearly
- do not silently absorb the work and pretend the specialist completed it

## Escalation rules

Escalate to Jarvis when:
- ownership is ambiguous
- board linkage is missing
- source truth is contradictory
- a chief wants to use a specialist outside its normal lane
- a task may touch Mission Control or OpenClaw and classification is unclear

Escalate to Brendan through Jarvis when:
- OpenClaw change approval is needed
- a protected-system boundary may change
- a persistent-owner rule may need to change
- a runtime/governance mismatch implies config mutation
