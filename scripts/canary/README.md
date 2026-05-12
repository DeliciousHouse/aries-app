# Canary post-deploy monitoring

Aries uses gstack's `/canary` skill for post-deploy visual monitoring. The skill
takes screenshots of key pages, watches console errors, and alerts on
performance regressions against a captured baseline.

Configuration lives at `scripts/canary/config.json` (production URL, page list,
thresholds — versioned with the repo). The skill itself writes screenshots and
reports under `.gstack/canary-reports/` (gitignored — local per-machine state).

## Standard invocations

Capture a baseline **before** deploying (do this once per major UI change):

```
/canary https://aries.sugarandleather.com --baseline --pages /,/dashboard,/dashboard/posts,/marketing/new-job
```

Watch production for 10 minutes **after** deploy (the default for `/land-and-deploy`):

```
/canary https://aries.sugarandleather.com --duration 10m --pages /,/dashboard,/dashboard/posts,/marketing/new-job
```

Single-pass quick health check (no continuous monitoring):

```
/canary https://aries.sugarandleather.com --quick --pages /,/dashboard
```

The full canonical page list and the thresholds we alert on are in
`.gstack/canary-config.json`. Update that file if the canonical pages change;
the invocation examples above mirror it.

## Outputs

- `.gstack/canary-reports/baselines/<page>.png` — pre-deploy screenshots
- `.gstack/canary-reports/screenshots/<page>-<check-number>.png` — post-deploy snapshots
- `.gstack/canary-reports/<date>-canary.md` and `.json` — final report
- `~/.gstack/projects/<slug>/canary-log.jsonl` — JSONL history for trend tracking

## When to update the baseline

After a healthy `/canary` run reports `HEALTHY`, the skill offers to roll the
baseline forward. Accept that prompt only when the visual changes in this PR
are the new intended state; otherwise keep the old baseline so the next
deploy still has the right reference point.
