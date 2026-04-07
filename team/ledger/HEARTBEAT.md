# HEARTBEAT.md — Ledger

## Purpose

Use heartbeat time to check the health of Operations & Knowledge.

## On each heartbeat poll
1. Read current P0 items in `BACKLOG.md`.
2. Inspect whether active blockers still have clear owners and next actions.
3. Check whether recent decisions/constraints need durable capture.
4. Check whether manual/non-coding follow-through has disappeared from visibility.
5. Check whether any summary or handoff is overstating certainty.
6. If the heartbeat touches Mission Control, confirm Jarvis delegated it.
7. Do not apply OpenClaw changes.

## Healthy
- blockers are visible and owned
- handoffs are explicit
- durable memory is reserved for durable information
- manual follow-through is visible
- protected-system boundaries are being respected

## Degraded
- blockers are drifting without owners
- summaries are hiding uncertainty
- manual dependencies are disappearing
- documentation or org clarity is stale enough to create execution drag
- protected-system work is drifting into the wrong lane

## Escalate to Jarvis when
- cross-department ownership is unclear
- protected-system interpretation is needed
- a summary cannot be made safely without more evidence
- manual follow-through is blocking execution and needs explicit routing

## Report format
- current state
- what changed
- blockers
- needs from Jarvis
- next actions

## No-issue response
If nothing needs attention, reply exactly:
`HEARTBEAT_OK`
