---
name: aries-runtime-error-intake
description: Scan Aries runtime and automation health, normalize failures into the runtime incident log, and return only a concise operational summary for cron delivery. Use when asked to detect or log current aries-app runtime/automation errors, seed the repair queue, or announce new/resolved incidents into the AI engineering lane.
---

# Aries Runtime Error Intake

Run the runtime incident scan from the repo root `/home/node/aries-app`.

## Required execution pattern

Default scan:

```bash
node scripts/automations/runtime-error-intake.mjs scan
```

JSON output:

```bash
node scripts/automations/runtime-error-intake.mjs scan --json
```

Deeper manual scan with build validation:

```bash
node scripts/automations/runtime-error-intake.mjs scan --with-build --json
```

## What this skill does

- runs bounded health checks for `aries-app`
- opens or reopens incidents in `data/runtime-error-incidents.json`
- auto-resolves incidents that no longer reproduce on the latest scan
- leaves the fix work to the repair-loop skill

## Output rules

- Return only the emitted summary.
- Do not add extra explanation around the summary.
- Keep the summary concise so cron announce delivery can post it directly to Discord/Telegram.

## Notes

- The incident log is the source of truth for open runtime incidents.
- Use `--with-build` for manual deep scans, not the normal cron path, unless explicitly requested.
