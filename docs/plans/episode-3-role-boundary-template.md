# Episode 3 role boundary template

Use this when clarifying where responsibility should stop and hand off.

## Context
- What work keeps drifting between owners?

## Decision
- What boundary are we setting?

## Boundary line
- What stays with Brendan?
- What stays with Jarvis?
- What goes to Rohan?
- What goes to Roy?
- What goes to Somwya?

## Alternatives considered
- Alternative 1
- Alternative 2

## Tradeoffs
- What gets faster?
- What gets riskier?
- What becomes clearer?

## Current risk
- What still needs attention after the boundary is set?

## Follow-up
- Next step
- Owner
- Evidence needed

## Date / owner
- Date:
- Owner:

## Example entry
- Context: responsive Mission Control work and runtime validation can blur between frontend, backend, and Jarvis.
- Decision: Jarvis can execute bounded responsive hardening directly, but live runtime adapter failures still route to Roy.
- Boundary line: Brendan keeps final release decisions; Jarvis handles bounded UI hardening and truth-state audits; Rohan owns larger frontend module work; Roy owns adapters and backend reliability; Somwya owns manual dashboard confirmation.
- Current risk: cross-surface QA still lacks a dedicated seat.
