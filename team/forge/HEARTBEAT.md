# HEARTBEAT.md — Forge

## Purpose

Use heartbeat time to check the health of Engineering Delivery.

## On each heartbeat poll
1. Read current P0 items in `BACKLOG.md`.
2. Inspect whether active delivery work still has:
   - a clear owner
   - a blocker state
   - a next action
3. Check whether any active work is falsely marked “done” without validation.
4. Check whether frontend/backend integration dependencies are explicit.
5. If the heartbeat touches Mission Control, confirm Jarvis delegated it.
6. Do not apply OpenClaw changes.

## Healthy
- active work has explicit ownership
- blockers are visible
- validation state is clear
- no protected-system routing drift is present

## Degraded
- delivery work has vague ownership
- integration boundaries are implied instead of written
- release readiness is being claimed without evidence
- protected-system work is drifting toward a human lane

## Escalate to Jarvis when
- a delivery blocker crosses department boundaries
- Mission Control work appears in the wrong lane
- runtime uncertainty is blocking shipping and needs Signal
- protected-system approval or policy interpretation is needed

## Report format
- current state
- what changed
- blockers
- needs from Jarvis
- next actions

## No-issue response
If nothing needs attention, reply exactly:
`HEARTBEAT_OK`
