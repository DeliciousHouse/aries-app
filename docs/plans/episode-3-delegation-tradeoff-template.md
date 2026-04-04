# Episode 3 delegation tradeoff template

Use this to decide whether Jarvis should execute directly or delegate.

## Context
- What is the work?
- Why is the delegation question coming up now?

## Decision
- Direct execution or delegation?

## Alternatives considered
- Jarvis does it directly
- Route to Rohan
- Route to Roy
- Route to Somwya
- Keep with Brendan

## Tradeoffs
- Speed impact
- Reliability impact
- Ownership clarity impact
- Validation impact

## Current risk
- What could still go wrong?

## Follow-up
- Next step
- Owner
- Acceptance criteria

## Date / owner
- Date:
- Owner:

## Example entry
- Context: cron failures need cleanup and the scheduler design is stale.
- Decision: Jarvis executes directly because the work is bounded, evidence-driven, and low-risk.
- Alternatives considered: route to Roy; wait for a later cleanup pass.
- Tradeoffs: faster closure now, but long-term scheduler ownership still needs to be explicit.
- Current risk: new cron jobs could drift again without a stable install/reset path.
