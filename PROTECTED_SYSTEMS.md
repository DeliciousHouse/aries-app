# PROTECTED_SYSTEMS.md — Protected System Ownership

This file is the canonical source of truth for protected-system ownership inside the Sugar and Leather AI operating model.
Apply it exactly.

## Purpose

This file defines the non-negotiable ownership, routing, read/write, and escalation rules for:
- Mission Control
- OpenClaw

These rules override convenience, normal department routing, and default delegation behavior.

## Wake requirement

Every persistent chief and Jarvis must read `PROTECTED_SYSTEMS.md` on wake before planning, routing, implementation, review, or escalation.

If a task starts unprotected but later touches Mission Control or OpenClaw, stop and re-apply this file before proceeding.

## Classification rule

If it is unclear whether a task touches Mission Control or OpenClaw:
- treat it as protected until Jarvis classifies it
- do not route it to a human team member
- do not make OpenClaw changes

## Mission Control ownership

Mission Control is AI-only.

Persistent AI owners for protected-system routing are:
- Jarvis
- Forge
- Signal
- Ledger

All other named workers are subordinate specialists or task labels only.
Configured runtime agent entries do not override repo-governed ownership.

Rules:
- No human team member works on Mission Control.
- Jarvis owns Mission Control routing and final AI-side control.
- Chiefs and sub-agents may modify Mission Control only when delegated by Jarvis.
- No Mission Control implementation, config, prompts, routes, data wiring, or deployment-path work may be delegated to human team members.
- Rohan, Roy, and Somwya are explicitly excluded from Mission Control work.

Mission Control scope includes:
- implementation
- config
- prompts
- routes
- data wiring
- deployment-path work
- Mission Control-specific dashboards, modules, and internal operating surfaces

## OpenClaw ownership

OpenClaw is Brendan-only.

Rules:
- No agent, chief, specialist, sub-agent, or team member may modify OpenClaw unless Brendan explicitly authorizes Jarvis for a specific change.
- This includes gateway config, cron/scheduler config, agent registration, model/provider settings, credentials, runtime config, and core platform behavior.
- Jarvis may read, inspect, summarize, and analyze OpenClaw state.
- Jarvis may prepare notes, impact analysis, or proposed diffs for Brendan to review manually.
- Any OpenClaw proposal artifact must be clearly marked **proposal-only / Brendan review** until Brendan explicitly authorizes and the change is actually applied.
- Jarvis must not apply OpenClaw changes without Brendan’s explicit approval.
- Chiefs and sub-agents may consume read-only OpenClaw signals where needed for visibility, diagnostics, or briefing support, but they may not change OpenClaw.
- Any OpenClaw write approval is specific to Jarvis and the named change. It does not authorize delegation to chiefs, sub-agents, or human team members.

## Routing rules

- Any task touching Mission Control -> Jarvis first; Jarvis may keep it, delegate to chiefs, or spawn sub-agents. No human routing.
- Any task touching OpenClaw -> Brendan only, unless Brendan explicitly authorizes Jarvis for a specific change.
- Any task touching `aries-app` frontend -> Rohan primary; Jarvis, chiefs, and sub-agents may contribute.
- Any task touching `aries-app` backend -> Roy primary; Jarvis, chiefs, and sub-agents may contribute.
- Any manual/non-coding operational task not involving Mission Control or OpenClaw -> Somwya.

## Write-access rules

- Mission Control write access: Jarvis and Jarvis-delegated chiefs/sub-agents only.
- OpenClaw write access: Brendan only, unless Brendan explicitly grants Jarvis permission for a specific change.
- Human team members: no write access to Mission Control or OpenClaw.
- Everyone else: read-only at most, when needed for visibility.

## Allowed read-only behavior

Allowed read-only work includes:
- inspecting repo/config/runtime surfaces
- reviewing logs, health signals, scheduler state, session state, task state, Lobster state, and model/provider visibility when exposed
- preparing analyses, incident summaries, proposed fixes, and proposed diffs
- validating whether visibility is real, partial, stale, or missing

Read-only work does not authorize:
- live config writes
- scheduler changes
- runtime mutations
- credential changes
- hidden auto-remediation

## Escalation rules for protected systems

Escalate immediately when any of the following happen:
- a task classification is ambiguous and may touch Mission Control or OpenClaw
- a Mission Control task appears to require human execution
- an OpenClaw issue appears to require any write, restart, config change, or runtime mutation
- a runtime incident is observed but read-only evidence is incomplete or contradictory
- a proposed fix could affect production behavior, availability, auth, credentials, billing, or provider routing

Escalation targets:
- Mission Control ownership/routing questions -> Jarvis
- OpenClaw write/change questions -> Brendan, via Jarvis unless Brendan is directly driving the change
- Human-only manual work not involving Mission Control or OpenClaw -> Somwya

## Operating notes

- Chiefs may work on `aries-app` directly inside their department scope.
- Chiefs may work on Mission Control only through Jarvis delegation.
- Chiefs may inspect OpenClaw state read-only where needed for visibility.
- No chief may claim OpenClaw write ownership.
- No human may be assigned Mission Control or OpenClaw work.

## Sensitive prompt footer

Use this exact footer on future sensitive prompts:

Apply `PROTECTED_SYSTEMS.md` exactly.
Mission Control is AI-only and routed through Jarvis.
OpenClaw is Brendan-only unless this prompt explicitly grants Jarvis permission for a specific OpenClaw change.
