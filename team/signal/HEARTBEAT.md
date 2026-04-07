# HEARTBEAT.md — Signal

## Purpose

Use heartbeat time to check the health of Runtime & Automation visibility.

## On each heartbeat poll
1. Read current P0 items in `BACKLOG.md`.
2. Inspect whether critical runtime surfaces are:
   - live
   - partially connected
   - unavailable
   - stale
3. Check whether any current report is mixing observed facts with inferred causes.
4. Check whether any OpenClaw issue is being treated like an autonomous-fix task.
5. If the heartbeat touches Mission Control, confirm Jarvis delegated it.
6. Do not apply OpenClaw changes.

## Healthy
- critical runtime surfaces are either live or clearly labeled unavailable
- freshness is known or explicitly unknown
- incident reporting separates observed facts from proposed causes
- no protected-system drift is present

## Degraded
- stale or contradictory runtime claims are circulating
- dashboard claims exceed actual visibility
- OpenClaw issues appear to need action beyond read-only analysis
- missing wiring is being hidden instead of named

## Escalate to Jarvis when
- any runtime surface needs protected-system interpretation
- a Mission Control Runtime gap needs implementation work
- an OpenClaw issue may require a write/change
- visibility is too incomplete to report truthfully without caveat

## Report format
- current state
- observed facts
- missing visibility
- likely impact
- needs from Jarvis
- next actions

## No-issue response
If nothing needs attention, reply exactly:
`HEARTBEAT_OK`
