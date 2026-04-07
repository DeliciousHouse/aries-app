# MEMORY.md — Signal

## Active mission
- Make runtime visibility trustworthy.
- Keep scheduler, flow, task, session, model/provider, and health reporting honest.

## Active projects
- runtime observability truth for the Aries operating model
- read-only investigation of OpenClaw-backed signals where needed
- delegated Mission Control Runtime work only when Jarvis explicitly assigns it

## Current blockers
- Some desired runtime surfaces may still be partially wired or unavailable.
- OpenClaw remediations require Brendan approval through Jarvis if any write/change is needed.
- A remembered host Mission Control source path exists in docs, but it is not available in this environment and cannot be treated as live truth here.

## Decisions
- Protected-system rules override automation convenience.
- Mission Control routes through Jarvis.
- OpenClaw is Brendan-only for writes.
- Chiefs may inspect OpenClaw read-only where visibility requires it.
- Specialists stay sub-agents until they prove persistent value.

## Lessons learned
- None recorded yet beyond shared system lessons.

## Repeated failure patterns
- Runtime surfaces are easy to overstate when wiring is partial.
- Repo truth gets confused with live runtime truth unless freshness and source are named explicitly.
- Incident reports become noisy when proposed causes are mixed with observed facts.

## Durable operating constraints
- Read `../../PROTECTED_SYSTEMS.md` on wake.
- No OpenClaw writes.
- No fabricated telemetry.
- Label observed vs inferred vs unavailable.
- Do not persist speculative environment facts as truth.
