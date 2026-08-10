# aries-pipeline-monitor

Host-side watchdog for the two Aries failure classes that currently die in
silence: a **weekly content run that fails generation**, and an **insights sync
that degrades to permanently-partial**. Alerts on Telegram via `hermes send`.

`ops/` holds host-operational tooling. Nothing in this directory is built,
imported, or executed by the app — it is not on the TypeScript path and is
outside both repo guards (`check-repo-boundary.mjs`, `check-banned-patterns.mjs`).

## Why a host script rather than an in-app outbox

One of the conditions being alerted on is *"the app is dead or wedged"*. An
in-app outbox cannot report its own absence. It would also need a new secret, a
new table, a new worker, and new deploy env to report strictly less than this
does. The Telegram bot token and the `hermes` binary already live on the host,
the `hermes-auth-sentinel` cron pattern is proven here, and alerting from
outside the app means an alerting bug cannot break the pipeline.

## What it watches

| Detector | Fires when | Source |
| --- | --- | --- |
| `STAGE_FAILURE` | a run doc is `failed`/`failed_stale` and was updated within `LOOKBACK_HOURS` (26) | `$PIPEMON_DATA_ROOT/generated/draft/marketing-jobs/*.json` |
| `SYNC_DEGRADED` | an account has ≥ `DEGRADED_MIN_BAD` (6) non-`ok` sync runs and **zero** `ok` runs in 24 h | `insights_sync_runs` |
| `SYNC_SILENT` | no sync run started in `SILENT_AFTER_HOURS` (2) | `insights_sync_runs` |
| `TRIGGER_SILENCE` | ≥1 enabled `marketing_schedule` row but no run doc created in `TRIGGER_SILENCE_DAYS` (8) | `marketing_schedule` + run docs |

Database reads go through `docker exec <container> psql -U "$POSTGRES_USER" -d
<db> -tA` — the same idiom `scripts/09_pg_monitor.sh` has run every 5 minutes
since the Postgres consolidation. Every statement is a read-only `SELECT`, each
capped by `LIMIT` and by `MAX_ROWS`, with a `PSQL_TIMEOUT_S` subprocess timeout.
**No password is ever passed or printed**, and no token, credential, or caption
ever reaches a message (pinned by a self-test scenario).

## Provider-auth suppression (do not remove)

The `hermes-auth-sentinel` **owns** dead provider OAuth grants — it detects
them, mints a device-login link, alerts, promotes the fresh grant, and restarts
the gateways. Every marketing run in flight during such an outage also fails,
with the provider-auth error copied verbatim into `last_error.message`. Six of
the six run-doc failures in the last 26 h on this host are exactly that.

Those run docs are **demoted to digest-only**: counted in `--digest` and
`--status` as `provider-auth failures: N (covered by hermes-auth-sentinel)`,
never immediately alerted. Without this the two monitors alert on the same
incident from opposite ends and the operator learns to ignore both.

## Arming (read before the first real run)

There are ~100 historical failed run docs on the host. The **first real run**
records every currently-failing fingerprint as already-seen and sends a single
line saying so. It never fans out. Deleting `state.json` **re-arms** rather than
re-alerts, by design.

After arming: a new fingerprint alerts once; an unresolved condition re-alerts
every `RE_ALERT_HOURS` (6); a cleared condition that had actually been alerted
sends one `✅ Resolved …` note. A condition that was only armed (never alerted)
disappears quietly.

When Postgres is unreachable, the run-doc detector still runs and the digest
says `db unavailable` — and DB-backed conditions are **not** resolved that tick,
so an outage can never be misread as a recovery.

## Install

```bash
REPO=/home/node/openclaw-n8n-stack/.claude/worktrees/aries-app-auto-posting-09bf54/…/aries-growth

# 1. Read the output before arming. Twice.
python3 "$REPO/ops/aries-pipeline-monitor.py" --cron --dry-run
python3 "$REPO/ops/aries-pipeline-monitor.py" --status

# 2. Confirm the fixture suite passes on this host's python.
python3 "$REPO/ops/aries-pipeline-monitor.py" --self-test

# 3. First real run — this ARMS the monitor and sends one line.
python3 "$REPO/ops/aries-pipeline-monitor.py" --cron
```

Then `crontab -e` for user `node`, mirroring the sentinel's absolute-path
convention (cron's `PATH` carries neither `hermes` nor `docker` usefully; the
script resolves both by absolute path):

```cron
# aries-pipeline-monitor (worktree path until the branch merges — then repoint)
*/15 * * * * /usr/bin/python3 <repo>/ops/aries-pipeline-monitor.py --cron   >> /home/node/.local/state/aries-pipeline-monitor/cron.log 2>&1
15 9   * * * /usr/bin/python3 <repo>/ops/aries-pipeline-monitor.py --digest >> /home/node/.local/state/aries-pipeline-monitor/cron.log 2>&1
```

09:15 is deliberately offset from the sentinel's 09:00 digest.

> **Path caveat** (same as the sentinel's crontab comment): these lines point at
> a worktree. Repoint them the moment this branch merges, or the monitor keeps
> running a stale copy.

## Configuration

All `PIPEMON_*`, all with working defaults — override in the crontab line only
if the deploy moves.

| Variable | Default |
| --- | --- |
| `PIPEMON_DATA_ROOT` | `/home/node/aries-data` |
| `PIPEMON_STATE_DIR` | `~/.local/state/aries-pipeline-monitor` |
| `PIPEMON_HERMES_BIN` | `/home/node/.local/bin/hermes` |
| `PIPEMON_TELEGRAM_TARGET` | `telegram` |
| `PIPEMON_PG_CONTAINER` | `n8n-postgres` |
| `PIPEMON_DB_NAME` | `aries_auth` |
| `PIPEMON_LOOKBACK_HOURS` | `26` |
| `PIPEMON_RE_ALERT_HOURS` | `6` |
| `PIPEMON_DEGRADED_MIN_BAD` | `6` |
| `PIPEMON_SILENT_AFTER_HOURS` | `2` |
| `PIPEMON_TRIGGER_SILENCE_DAYS` | `8` |

State lives at `$PIPEMON_STATE_DIR/{state.json,monitor.log,tick.lock,cron.log}`,
`0600` inside a `0700` directory, written atomically. Ticks are `flock`-guarded;
a busy lock skips rather than piles up.

## Removal

```bash
crontab -e            # delete the two lines
rm -rf ~/.local/state/aries-pipeline-monitor
```

No app impact — the monitor only ever reads.
