# Feature evaluation rubric

Score every feature request before deciding.

## Effort hours
Estimate the likely implementation time for one focused delivery pass.
- 1-2: tiny copy/state tweak
- 3-6: bounded UI or backend change
- 7-16: multi-file feature slice
- 17+: broad or risky initiative

## Impact score (1-5)
- 1: niche ask, very small audience
- 2: helpful but limited reach
- 3: meaningful improvement for an active user segment
- 4: strong user or operator value
- 5: large user impact or major business leverage

## Alignment score (1-5)
Judge against the current repo priorities.
- 1: conflicts with the roadmap or widens unsupported surface
- 2: weak fit, likely distraction
- 3: neutral fit
- 4: supports current execution direction
- 5: directly advances the current priority stack

## Approval guidance
Prefer `rejected` when any of these are true:
- the request expands stubbed or unsupported routes
- it competes with the current contract-freeze priority
- the impact is low and alignment is weak

Prefer `approved` when all of these are true:
- alignment is strong
- the scope is bounded enough to build safely
- staging review will create a clear decision point for Brendan

## Reasoning rule
The approval or rejection reason should mention the roadmap fit, not just the implementation cost.
