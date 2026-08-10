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
| `COOKIE_STALE` | an Agent-Reach cookie session is `stale` in a prober state file newer than `COOKIE_STATE_MAX_AGE_H` (12) | `$PIPEMON_COOKIE_STATE` (written by `ops/agent-reach/cookie-prober.py`) |

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

**What the suppression does NOT cover:** per-profile Hermes *gateway* keys. The
sentinel owns provider OAuth grants; a gateway that 401s because
`HERMES_<PROFILE>_API_SERVER_KEY` never landed is a deploy misconfiguration
nobody else is watching. The app therefore fails that submission as
`hermes_gateway_key_misconfigured`, with wording that deliberately avoids the
suppressed strings, so it alerts like any other stage failure. If you ever
widen `AUTH_SIGNATURE`, keep that message outside it.

## COOKIE_STALE: why this monitor does not probe

`COOKIE_STALE` reads a **file** and makes no network call, unlike every other
way you might check whether a cookie session is alive.

Probing Instagram / X / Reddit / Facebook means network I/O that can block,
rate-limit, or trip an automation heuristic. This monitor is deliberately
read-only and network-free so that an alerting bug can never wedge the pipeline
it watches. So the work is split:

* `ops/agent-reach/cookie-prober.py` (its own cron, every 4 h) owns the probe —
  it runs `agent-reach doctor`, classifies each platform `fresh` / `stale` /
  `unknown`, and writes `~/.local/state/agent-reach-prober/state.json` (0600).
* this monitor owns the **operator alert** and only ever reads that file.

A hung probe delays a state file. It cannot delay an alert tick.

Three things are deliberately **silent**, all the same rule as the empty
`max(started_at)` case — an absence of information is not an incident:

| Situation | Why silent |
| --- | --- |
| state file missing / unreadable / wrong shape | the prober may simply not be installed; that is the runbook's job, not a page |
| `"status": "unknown"` | the prober emits it for a timeout, a missing binary, an unparseable answer, or a platform `doctor` did not mention — none of which mean the cookie is dead |
| state file older than `COOKIE_STATE_MAX_AGE_H` | a three-day-old verdict is not a verdict; it means the *prober* is dead, which `--digest`/`--status` reports as `NOTE: prober state is older than …` instead of paging |

A stale session resolves like any other condition: once the cookie is refreshed
the finding disappears and one `✅ Resolved — 🍪 Agent-Reach session stale` note
is sent. If it **never** clears, the account is probably suspended rather than
logged out: the fix is to re-mint the throwaway, not to refresh it (see
`ops/agent-reach/README.md`).

Nothing from this path may carry cookie material into a message, and that is
enforced **twice on purpose**. The prober redacts on write; the monitor redacts
again in `detect_cookie_stale` before the string can become a Telegram message,
because the state file is plain JSON it does not own — a prober regression, an
older build, or the hand-edit the verification runbook asks for can all put a
live value there. Two scenarios pin it: `no_secret_material_in_messages` (an
already-redacted detail is not un-redacted downstream) and
`cookie_detail_is_redacted_by_the_monitor_itself` (a **raw** `auth_token=…`
planted in the state file never reaches the alert or the digest).

## Arming (read before the first real run)

There are ~100 historical failed run docs on the host. The **first real run**
records every currently-failing fingerprint as already-seen and sends a single
line saying so. It never fans out. Deleting `state.json` **re-arms** rather than
re-alerts, by design.

After arming: a new fingerprint alerts once; an unresolved condition re-alerts
every `RE_ALERT_HOURS` (6); a cleared condition that had actually been alerted
sends one `✅ Resolved …` note. A condition that was only armed (never alerted)
disappears quietly.

Armed-at-bootstrap entries carry `"bootstrap": true` in `state.json`. That flag
is what separates "known, deliberately quiet" from "first send failed and is
still pending": a finding whose first `hermes send` fails (Telegram outage,
timeout) is **retried on the next tick** instead of being silenced until it
resolves. Entries written before the flag existed are read as bootstrap-armed,
so upgrading in place never fans out.

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
| `PIPEMON_COOKIE_STATE` | `~/.local/state/agent-reach-prober/state.json` |
| `PIPEMON_COOKIE_STATE_MAX_AGE_H` | `12` |

State lives at `$PIPEMON_STATE_DIR/{state.json,monitor.log,tick.lock,cron.log}`,
`0600` inside a `0700` directory, written atomically. Ticks are `flock`-guarded;
a busy lock skips rather than piles up.

## Removal

```bash
crontab -e            # delete the two lines
rm -rf ~/.local/state/aries-pipeline-monitor
```

No app impact — the monitor only ever reads.
