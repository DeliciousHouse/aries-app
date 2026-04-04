# Episode 3 org design decision template

Use this when making a real team-architecture decision for internal engineering execution.

## Context
- What current operating problem or repeated pattern prompted the decision?

## Decision
- What are we deciding?

## Alternatives considered
- Option A
- Option B
- Option C

## Tradeoffs
- Speed impact
- Reliability impact
- Scope impact
- Coordination impact

## Current risk
- What risk remains even after the decision?

## Follow-up
- Next action
- Owner
- Timing

## Date / owner
- Date:
- Owner:

## Example entry
- Context: Mission Control runtime surfaces keep needing cross-surface QA before release.
- Decision: Introduce a future QA / handoff validation seat once repeated release risk justifies it.
- Alternatives considered: keep all validation on Brendan; split validation ad hoc between Rohan and Roy; assign Jarvis as interim coordinator only.
- Tradeoffs: adding a seat reduces blocker blindness but increases coordination overhead until the lane is mature.
- Current risk: release-readiness proof still depends on informal verification.
- Follow-up: keep a handoff risk register in Command and revisit after another release cycle.
- Date / owner: 2026-04-03 / Brendan
