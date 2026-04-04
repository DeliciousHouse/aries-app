# RUNTIME.md — Mission Control Runtime Visibility Rules

## Purpose

This file defines how Jarvis should think about live OpenClaw operational visibility.

Its purpose is to prevent:
- fake telemetry
- stale runtime assumptions
- overconfident status reporting
- confusion between repo truth and live system truth

Mission Control should be honest about what it can see, what it cannot see, and what still needs wiring.

---

## 1) What Mission Control needs to show

Mission Control should eventually expose live operational views for:

- active chat sessions
- agent / sub-agent sessions
- running tasks
- queued tasks
- completed tasks
- failed tasks
- Lobster workflow runs
- scheduler / cron state
- model / provider usage
- system health

These are target visibility categories.
Their inclusion here is not a claim that all are currently wired.

---

## 2) Source-of-truth rules for runtime status

When reporting runtime status, use this trust order:

1. live runtime / API / event / log / process / database truth
2. repo / config truth
3. durable memory
4. inference

Rules:
- Runtime claims should come from live sources whenever possible.
- Repo/config can define expected behavior, not guaranteed current runtime behavior.
- Memory can preserve durable context, not replace live checks.
- Inference should be used carefully and labeled as inference.

If live runtime data is unavailable:
- say unavailable
- say disconnected
- say not yet wired
- do not fill the gap with plausible wording

---

## 3) Connected vs disconnected behavior

### Connected
If a runtime source is connected:
- report from the live source
- include freshness if known
- distinguish current state from historical memory

### Partially connected
If only part of the surface is connected:
- report what is live
- report what is missing
- do not imply full visibility

### Disconnected
If a runtime surface is not connected:
- say it is not connected
- identify the missing wiring if known
- do not fabricate status, counts, health, or activity

---

## 4) Telemetry categories

## Sessions
Mission Control should show:
- active chat sessions
- session ownership/type if available
- agent/sub-agent session visibility
- session state freshness if available

## Tasks
Mission Control should show:
- running tasks
- queued tasks
- completed tasks
- failed tasks
- owner or workflow linkage if available

## Lobster flows
Mission Control should show:
- active Lobster workflow runs
- completed/failed runs
- basic run state and timing if available
- missing wiring truthfully if not exposed

## Scheduler / cron
Mission Control should show:
- enabled jobs
- recent runs
- failures
- disabled jobs if relevant
- next-run visibility if available

## Models / providers
Mission Control should show:
- current model/provider in use where available
- usage or routing state if exposed
- failures or auth/billing issues if exposed
- absence of visibility if not connected

## Health
Mission Control should show:
- service health
- obvious failures
- degraded states
- unavailable dependencies
- what is observable versus what is not

---

## 5) Freshness expectations

Runtime status should include freshness expectations when possible.

Preferred behavior:
- current/active surfaces should be near-live
- task/session/health views should reflect recent state, not stale memory
- if freshness timestamp is available, expose it
- if freshness is unknown, say freshness unknown

Do not present stale data as current runtime truth.

---

## 6) Failure reporting rules

When reporting failures:
- name the failing surface
- state what is known
- state what is unavailable
- state likely impact
- separate observed failure from inferred cause

Preferred failure format:
- surface
- observed state
- last known good / unknown
- impact
- missing visibility
- next verification step

Do not over-diagnose when visibility is incomplete.

---

## 7) No mock telemetry rule

No mock telemetry.

Do not fabricate:
- active session counts
- task counts
- health state
- cron state
- model usage
- workflow runs
- connectivity state

If the system does not expose a surface yet:
- say it does not expose it yet
- note it as a wiring gap
- do not generate stand-in telemetry for presentation purposes

---

## 8) Fallback behavior when sources are not yet wired

If runtime sources are not yet wired:

1. state the surface is not yet wired or unavailable
2. fall back to repo/config truth only for expected behavior
3. label any remembered context as remembered, not live
4. identify what source would need to be connected for real visibility
5. avoid numerical or status claims that cannot be verified

Example fallback language:
- “Scheduler wiring is not connected, so current cron state is unavailable.”
- “Repo config suggests this service should exist, but live health is not currently visible.”
- “Memory indicates this path may be relevant, but it has not been verified as the active runtime source.”

---

## 9) Relationship between runtime truth and planning

Mission Control planning can proceed with incomplete runtime visibility, but reporting must remain truthful.

That means:
- planning may use repo truth and durable context
- runtime reporting must use live visibility when available
- missing observability should be surfaced as a delivery gap, not hidden

---

## 10) Operational reliability rule

Prefer truthful incompleteness over polished falsehood.

A useful runtime panel can say:
- connected
- partially connected
- unavailable
- unknown
- stale
- not yet wired

It must not imply certainty that the system does not have.
