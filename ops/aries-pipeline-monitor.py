#!/usr/bin/env python3
"""Aries pipeline monitor.

Cron-driven watchdog for the two failure classes that currently die in
silence: a weekly content run that fails generation, and an insights sync
that degrades to permanently-partial. Alerts on Telegram through
`hermes send`, the same transport the hermes-auth-sentinel already uses.

WHY A HOST SCRIPT AND NOT AN IN-APP OUTBOX
------------------------------------------
One of the conditions being alerted on is "the app is dead or wedged". An
in-app outbox cannot report its own absence, and would need a new secret, a
new table, a new worker and new deploy env to report strictly less. The
Telegram bot token and the `hermes` binary already live on this host, and
the sentinel's cron pattern is proven here. Alerting from outside the app
also means an alerting bug cannot break the pipeline.

INPUTS (both read-only)
-----------------------
  * Run docs:  $PIPEMON_DATA_ROOT/generated/draft/marketing-jobs/*.json —
               the bind-mounted marketing job state written by the app.
  * Postgres:  docker exec <container> psql -U "$POSTGRES_USER" -d <db> -tA
               — the exact idiom scripts/09_pg_monitor.sh already runs every
               5 minutes. SELECTs only.

SECURITY: no token, credential, caption, or DB password is ever placed in a
message, a log line, or a command line. The DB password is never passed at
all — psql runs inside the container as the postgres superuser via peer auth,
exactly as the existing monitor does.

Single file, python3 stdlib only. Modes: --cron (default), --digest,
--status, --self-test, with --dry-run available on all of them.

Install: see ops/README-aries-pipeline-monitor.md.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

# ===========================================================================
# SECTION A: config, logging, IO
# ===========================================================================


def _env_str(name: str, default: str) -> str:
    return os.environ.get(f"PIPEMON_{name}", default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(f"PIPEMON_{name}")
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


DATA_ROOT = Path(_env_str("DATA_ROOT", "/home/node/aries-data")).expanduser()
STATE_DIR = Path(
    _env_str("STATE_DIR", str(Path.home() / ".local/state/aries-pipeline-monitor"))
).expanduser()
HERMES_BIN = _env_str("HERMES_BIN", "/home/node/.local/bin/hermes")
TELEGRAM_TARGET = _env_str("TELEGRAM_TARGET", "telegram")
PG_CONTAINER = _env_str("PG_CONTAINER", "n8n-postgres")
DB_NAME = _env_str("DB_NAME", "aries_auth")

# A failed run doc older than this is history, not news. 26 h (not 24) so a
# daily-cadence failure is never missed by clock drift between ticks.
LOOKBACK_HOURS = _env_int("LOOKBACK_HOURS", 26)
# An unresolved condition re-alerts at this cadence — loud enough not to be
# forgotten, quiet enough not to be muted.
RE_ALERT_HOURS = _env_int("RE_ALERT_HOURS", 6)
# SYNC_DEGRADED: this many non-ok runs with ZERO ok runs in 24 h. 6 ≈ 3 h at
# the worker's 30-minute cadence.
DEGRADED_MIN_BAD = _env_int("DEGRADED_MIN_BAD", 6)
# SYNC_SILENT: no insights_sync_runs row started within this many hours.
SILENT_AFTER_HOURS = _env_int("SILENT_AFTER_HOURS", 2)
# TRIGGER_SILENCE: schedules enabled but no run doc created in this many days.
TRIGGER_SILENCE_DAYS = _env_int("TRIGGER_SILENCE_DAYS", 8)
# Hard caps so a monitor bug can never produce a giant message or a giant query.
MAX_NAMED_ITEMS = _env_int("MAX_NAMED_ITEMS", 5)
MAX_ROWS = _env_int("MAX_ROWS", 200)
PSQL_TIMEOUT_S = _env_int("PSQL_TIMEOUT_S", 20)
# Bootstrap-armed fingerprints are pruned once they age out entirely.
STATE_PRUNE_DAYS = _env_int("STATE_PRUNE_DAYS", 30)

FAILED_STATUSES = {"failed", "failed_stale"}

# ---------------------------------------------------------------------------
# Provider-auth suppression.
#
# The hermes-auth-sentinel OWNS dead provider OAuth grants: it detects them,
# mints a device-login link, alerts, promotes the fresh grant and restarts the
# gateways. Every marketing run in flight during such an outage also fails,
# with the provider-auth error copied verbatim into last_error.message. Without
# this rule the two monitors alert on the same incident from opposite ends and
# the operator learns to ignore both.
#
# Matched against last_error.message + last_error.code, on the same strings the
# outage actually produces (verified against the live run docs, 2026-08-10):
#   "⚠️ Provider authentication failed: Codex token refresh failed: Could not
#    validate your refresh token. Please try signing in again."
#   "Hermes gateway returned HTTP 401 on /v1/runs."
# These are demoted to DIGEST-ONLY: counted in --digest and --status, never
# immediately alerted.
# ---------------------------------------------------------------------------
AUTH_SIGNATURE = re.compile(
    r"provider authentication failed"
    r"|token refresh failed"
    r"|could not validate your refresh token"
    r"|re-?authenticate"
    r"|\bHTTP 401\b"
    r"|\b401 unauthorized\b",
    re.IGNORECASE,
)


@dataclasses.dataclass
class Config:
    data_root: Path = dataclasses.field(default_factory=lambda: DATA_ROOT)
    state_dir: Path = dataclasses.field(default_factory=lambda: STATE_DIR)
    hermes_bin: str = HERMES_BIN
    telegram_target: str = TELEGRAM_TARGET
    pg_container: str = PG_CONTAINER
    db_name: str = DB_NAME
    dry_run: bool = False
    # Self-test hooks. Production never sets either.
    psql_stub = None          # callable(sql) -> list[list[str]] | None
    capture_sends: bool = False


CFG = Config()
SENT: list = []


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime) -> str:
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    """Parse an ISO-8601 timestamp, tolerating a trailing Z and a space
    separator (Postgres renders the latter). Returns None on anything
    unparseable — a bad timestamp must never crash a tick."""
    if not isinstance(s, str) or not s.strip():
        return None
    text = s.strip().replace("Z", "+00:00")
    if len(text) > 10 and text[10] == " ":
        text = text[:10] + "T" + text[11:]
    try:
        d = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def _ensure_state_dir() -> None:
    CFG.state_dir.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(CFG.state_dir, 0o700)


def log(msg: str) -> None:
    """Append to STATE_DIR/monitor.log and print. Never raises."""
    line = f"{iso(now())} {msg}"
    print(line)
    try:
        _ensure_state_dir()
        path = CFG.state_dir / "monitor.log"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        os.chmod(path, 0o600)
    except OSError:
        pass


def atomic_write_json(path: Path, obj: dict) -> None:
    """0600 temp file in the same directory, fsync, rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise


class LockTimeout(Exception):
    pass


@contextlib.contextmanager
def file_lock(lock_path: Path, timeout: float = 15.0):
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise LockTimeout(f"timed out acquiring {lock_path}")
                time.sleep(0.05)
        try:
            yield
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _fresh_state() -> dict:
    return {"armed_at": None, "seen": {}, "last_tick_at": None, "digest": {}}


def load_state() -> dict:
    _ensure_state_dir()
    path = CFG.state_dir / "state.json"
    if not path.exists():
        return _fresh_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("state.json root is not an object")
    except (OSError, ValueError):
        log("state corrupt; rebuilding (this re-arms the monitor)")
        return _fresh_state()
    fresh = _fresh_state()
    for key, value in fresh.items():
        data.setdefault(key, value)
    if not isinstance(data.get("seen"), dict):
        data["seen"] = {}
    return data


def save_state(state: dict) -> None:
    if CFG.dry_run:
        return
    _ensure_state_dir()
    path = CFG.state_dir / "state.json"
    atomic_write_json(path, state)
    with contextlib.suppress(OSError):
        os.chmod(path, 0o600)


# ===========================================================================
# SECTION B: inputs — run docs and Postgres
# ===========================================================================


def read_run_docs() -> list:
    """Every marketing job doc, parsed. Unreadable/!JSON files are skipped
    silently — a half-written doc is normal, not an incident."""
    root = CFG.data_root / "generated" / "draft" / "marketing-jobs"
    docs = []
    try:
        names = sorted(p for p in root.iterdir() if p.suffix == ".json")
    except OSError:
        return docs
    for path in names:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict):
            docs.append(doc)
    return docs


def psql_query(sql: str):
    """Run one read-only SELECT inside the Postgres container.

    Returns a list of rows (each a list of string fields), or None when the
    database could not be reached — the caller MUST treat None as "unknown",
    never as "zero". Unit-separator field delimiter so a message containing a
    pipe or comma cannot split a row.
    """
    if CFG.psql_stub is not None:
        return CFG.psql_stub(sql)
    try:
        who = subprocess.run(
            ["docker", "exec", CFG.pg_container, "sh", "-c", 'echo "$POSTGRES_USER"'],
            capture_output=True, text=True, timeout=PSQL_TIMEOUT_S,
        )
        if who.returncode != 0:
            return None
        user = (who.stdout or "").strip()
        if not user:
            return None
        proc = subprocess.run(
            ["docker", "exec", CFG.pg_container, "psql", "-U", user, "-d", CFG.db_name,
             "-tA", "-F", "\x1f", "-c", sql],
            capture_output=True, text=True, timeout=PSQL_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        log(f"psql failed rc={proc.returncode}: {(proc.stderr or '').strip()[:200]}")
        return None
    rows = []
    for line in (proc.stdout or "").splitlines():
        if not line.strip():
            continue
        rows.append(line.split("\x1f"))
        if len(rows) >= MAX_ROWS:
            break
    return rows


# ===========================================================================
# SECTION C: detectors
# ===========================================================================


@dataclasses.dataclass
class Finding:
    kind: str            # STAGE_FAILURE | SYNC_DEGRADED | SYNC_SILENT | TRIGGER_SILENCE
    fingerprint: str     # stable identity for dedup
    label: str           # one line naming this item in a grouped message
    detail: str = ""     # optional extra shown for the first named item


def _fp(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:16]


def detect_stage_failures(docs, reference=None):
    """Failed run docs updated within LOOKBACK_HOURS.

    Returns (findings, auth_suppressed_count, by_stage_code). Provider-auth
    failures are counted but NEVER returned as findings — the
    hermes-auth-sentinel owns that incident class end to end.
    """
    ref = reference or now()
    cutoff = ref - dt.timedelta(hours=LOOKBACK_HOURS)
    findings = []
    auth_suppressed = 0
    by_stage_code: dict = {}

    for doc in docs:
        status = doc.get("status") or doc.get("state")
        if status not in FAILED_STATUSES:
            continue
        updated = parse_iso(doc.get("updated_at")) or parse_iso(doc.get("created_at"))
        if updated is None or updated < cutoff:
            continue
        err = doc.get("last_error") if isinstance(doc.get("last_error"), dict) else {}
        code = str(err.get("code") or "unknown")
        stage = str(err.get("stage") or doc.get("current_stage") or "unknown")
        message = str(err.get("message") or "")
        tenant = str(doc.get("tenant_id") or "?")
        job_id = str(doc.get("job_id") or "?")

        key = f"{stage}/{code}"
        by_stage_code[key] = by_stage_code.get(key, 0) + 1

        if AUTH_SIGNATURE.search(message) or AUTH_SIGNATURE.search(code):
            auth_suppressed += 1
            continue

        findings.append(Finding(
            kind="STAGE_FAILURE",
            fingerprint=_fp(job_id, stage, code),
            label=f"tenant {tenant} · {stage}/{code}",
            detail=message[:160],
        ))
    return findings, auth_suppressed, by_stage_code


SQL_DEGRADED = f"""
SELECT tenant_id, account_id, platform,
       count(*) FILTER (WHERE status <> 'ok') AS bad,
       count(*) AS total,
       coalesce((array_agg(error_message ORDER BY started_at DESC)
                 FILTER (WHERE error_message IS NOT NULL))[1], '') AS last_err
  FROM insights_sync_runs
 WHERE started_at > now() - interval '24 hours'
 GROUP BY 1, 2, 3
HAVING count(*) FILTER (WHERE status = 'ok') = 0
   AND count(*) FILTER (WHERE status <> 'ok') >= {DEGRADED_MIN_BAD}
 ORDER BY bad DESC
 LIMIT 50
"""

SQL_LAST_SYNC = "SELECT coalesce(max(started_at)::text, '') FROM insights_sync_runs"

SQL_ENABLED_SCHEDULES = "SELECT count(*) FROM marketing_schedule WHERE enabled"

SQL_QUARANTINE = """
SELECT count(*) FILTER (WHERE metrics_unavailable_at IS NOT NULL),
       count(*) FILTER (WHERE comments_unavailable_at IS NOT NULL),
       count(*) FILTER (WHERE metrics_error_count > 0 AND metrics_unavailable_at IS NULL)
  FROM insights_posts
"""

SQL_DISABLED_ACCOUNTS = """
SELECT tenant_id, platform, coalesce(disabled_reason, '')
  FROM insights_accounts WHERE disabled_at IS NOT NULL ORDER BY 1, 2 LIMIT 50
"""


def detect_sync_degraded():
    """Accounts with only failing syncs for hours. None → db unavailable."""
    rows = psql_query(SQL_DEGRADED)
    if rows is None:
        return None
    findings = []
    for row in rows:
        if len(row) < 6:
            continue
        tenant, account, platform, bad, total, last_err = row[:6]
        findings.append(Finding(
            kind="SYNC_DEGRADED",
            fingerprint=_fp("degraded", tenant, account, platform),
            label=f"tenant {tenant} · {platform} (account {account}): {bad}/{total} runs bad, 0 ok",
            detail=last_err[:160],
        ))
    return findings


def detect_sync_silent(reference=None):
    """The sync worker has not started a run recently — it is dead or wedged.

    An EMPTY or NULL max(started_at) is explicitly NOT an alert. A fresh
    database, a table that has never been written, or a psql call that returned
    nothing all look identical here, and "the worker is dead" is the one
    conclusion that cannot be drawn from an absence of rows. Those degrade to
    the db-unavailable path instead.
    """
    rows = psql_query(SQL_LAST_SYNC)
    if rows is None:
        return None
    # `not rows` (no output at all), an empty first row, and an empty/NULL
    # first field are ALL the same answer: unknown. `str(...)` because a NULL
    # can reach here as None from a stub or a future driver — a crash in the
    # detector would take the whole tick, including the run-doc leg, with it.
    if not rows or not rows[0] or not str(rows[0][0] or "").strip():
        return None
    last = parse_iso(str(rows[0][0]))
    if last is None:
        return None
    ref = reference or now()
    if ref - last < dt.timedelta(hours=SILENT_AFTER_HOURS):
        return []
    hours = int((ref - last).total_seconds() // 3600)
    return [Finding(
        kind="SYNC_SILENT",
        fingerprint=_fp("sync_silent"),
        label=f"no insights sync run started in {hours} h (last {iso(last)})",
    )]


def detect_trigger_silence(docs, reference=None):
    """Schedules are enabled but nothing has been submitted in over a week."""
    rows = psql_query(SQL_ENABLED_SCHEDULES)
    if rows is None:
        return None
    try:
        enabled = int(rows[0][0]) if rows and rows[0] and rows[0][0].strip() else 0
    except ValueError:
        return None
    if enabled <= 0:
        return []
    ref = reference or now()
    newest = None
    for doc in docs:
        created = parse_iso(doc.get("created_at"))
        if created is not None and (newest is None or created > newest):
            newest = created
    if newest is not None and ref - newest < dt.timedelta(days=TRIGGER_SILENCE_DAYS):
        return []
    seen_text = f"last {iso(newest)}" if newest else "no run docs at all"
    return [Finding(
        kind="TRIGGER_SILENCE",
        fingerprint=_fp("trigger_silence"),
        label=f"{enabled} schedule(s) enabled but no weekly run submitted in {TRIGGER_SILENCE_DAYS}+ days ({seen_text})",
    )]


# ===========================================================================
# SECTION D: messages
# ===========================================================================

KIND_HEADLINE = {
    "STAGE_FAILURE": "⚠️ Aries weekly runs failing",
    "SYNC_DEGRADED": "⚠️ Insights sync degraded",
    "SYNC_SILENT": "⛔ Insights sync worker silent",
    "TRIGGER_SILENCE": "⚠️ Weekly trigger silent",
}


def format_group(kind: str, findings: list) -> str:
    """One message per kind, capped at MAX_NAMED_ITEMS named items."""
    head = KIND_HEADLINE.get(kind, kind)
    named = findings[:MAX_NAMED_ITEMS]
    extra = len(findings) - len(named)
    lines = [f"{head}: {len(findings)} item(s)."]
    for f in named:
        lines.append(f"• {f.label}")
    if extra > 0:
        lines.append(f"• +{extra} more")
    first_detail = next((f.detail for f in findings if f.detail), "")
    if first_detail:
        lines.append(f"Latest: {first_detail}")
    return "\n".join(lines)


def send_telegram(text: str) -> bool:
    """`hermes send --to <target>` over stdin. Never raises."""
    if CFG.capture_sends:
        SENT.append(text)
    if CFG.dry_run:
        print(f"DRY-RUN would send:\n{text}\n")
        return True
    try:
        result = subprocess.run(
            [CFG.hermes_bin, "send", "--to", CFG.telegram_target],
            input=text, capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        log("send_telegram: timed out after 60s")
        return False
    except OSError as exc:
        log(f"send_telegram: failed to spawn hermes: {exc}")
        return False
    if result.returncode != 0:
        log(f"send_telegram: hermes exited {result.returncode}: {(result.stderr or '').strip()[:200]}")
        return False
    return True


# ===========================================================================
# SECTION E: tick
# ===========================================================================


def collect(docs, reference=None):
    """Run every detector. Returns (findings, notes) where notes records
    which detectors could not run (db unavailable) and the suppressed count."""
    findings = []
    notes = {"db_unavailable": False, "auth_suppressed": 0, "by_stage_code": {}}

    stage, auth_suppressed, by_stage_code = detect_stage_failures(docs, reference)
    findings.extend(stage)
    notes["auth_suppressed"] = auth_suppressed
    notes["by_stage_code"] = by_stage_code

    for detector in (
        lambda: detect_sync_degraded(),
        lambda: detect_sync_silent(reference),
        lambda: detect_trigger_silence(docs, reference),
    ):
        result = detector()
        if result is None:
            notes["db_unavailable"] = True
            continue
        findings.extend(result)
    return findings, notes


def tick(reference=None) -> int:
    ref = reference or now()
    state = load_state()
    docs = read_run_docs()
    findings, notes = collect(docs, ref)
    present = {f.fingerprint: f for f in findings}
    seen = state["seen"]

    # ── Bootstrap arming ────────────────────────────────────────────────────
    # There are ~100 historical failed run docs on this host. The first real
    # run records everything currently failing as already-seen and sends ONE
    # line, so arming can never fan out into an alert storm. Deleting
    # state.json re-arms rather than re-alerts, by design.
    if not state.get("armed_at"):
        for fp, f in present.items():
            seen[fp] = {"kind": f.kind, "first_at": iso(ref), "last_alert_at": None, "label": f.label}
        state["armed_at"] = iso(ref)
        state["last_tick_at"] = iso(ref)
        save_state(state)
        send_telegram(
            f"✅ Aries pipeline monitor armed. {len(present)} pre-existing condition(s) "
            f"recorded as known and will not alert; {notes['auth_suppressed']} provider-auth "
            "failure(s) are covered by hermes-auth-sentinel."
        )
        log(f"armed with {len(present)} pre-existing conditions")
        return 0

    # ── New / re-alert ──────────────────────────────────────────────────────
    to_alert: dict = {}
    for fp, f in present.items():
        prev = seen.get(fp)
        if prev is None:
            to_alert.setdefault(f.kind, []).append(f)
            seen[fp] = {"kind": f.kind, "first_at": iso(ref), "last_alert_at": None, "label": f.label}
            continue
        prev["label"] = f.label
        last_alert = parse_iso(prev.get("last_alert_at"))
        if last_alert is None:
            # Armed at bootstrap and still true: known, deliberately quiet.
            continue
        if ref - last_alert >= dt.timedelta(hours=RE_ALERT_HOURS):
            to_alert.setdefault(f.kind, []).append(f)

    for kind, group in sorted(to_alert.items()):
        if send_telegram(format_group(kind, group)):
            for f in group:
                seen[f.fingerprint]["last_alert_at"] = iso(ref)

    # ── Resolved ────────────────────────────────────────────────────────────
    # Only conditions that were actually ALERTED get a resolution note; a
    # bootstrap-armed condition disappearing is not news. When the database is
    # unreachable its detectors returned nothing, which must not be read as
    # "everything recovered" — so DB-backed kinds are left alone that tick.
    db_kinds = {"SYNC_DEGRADED", "SYNC_SILENT", "TRIGGER_SILENCE"}
    resolved: dict = {}
    for fp in list(seen.keys()):
        entry = seen[fp]
        if fp in present:
            continue
        if notes["db_unavailable"] and entry.get("kind") in db_kinds:
            continue
        if entry.get("last_alert_at"):
            resolved.setdefault(entry.get("kind", "?"), []).append(entry.get("label", fp))
            del seen[fp]
        else:
            first = parse_iso(entry.get("first_at"))
            if first is None or ref - first > dt.timedelta(days=STATE_PRUNE_DAYS):
                del seen[fp]

    for kind, labels in sorted(resolved.items()):
        head = KIND_HEADLINE.get(kind, kind)
        shown = labels[:MAX_NAMED_ITEMS]
        extra = len(labels) - len(shown)
        text = f"✅ Resolved — {head}: {len(labels)} item(s) cleared.\n" + "\n".join(f"• {s}" for s in shown)
        if extra > 0:
            text += f"\n• +{extra} more"
        send_telegram(text)

    if notes["db_unavailable"]:
        log("db unavailable this tick — run-doc detectors ran, DB detectors skipped")
    state["last_tick_at"] = iso(ref)
    state["digest"] = {
        "auth_suppressed": notes["auth_suppressed"],
        "by_stage_code": notes["by_stage_code"],
        "db_unavailable": notes["db_unavailable"],
    }
    save_state(state)
    log(f"tick: {len(present)} active, {sum(len(v) for v in to_alert.values())} alerted, "
        f"{sum(len(v) for v in resolved.values())} resolved, "
        f"{notes['auth_suppressed']} auth-suppressed")
    return 0


# ===========================================================================
# SECTION F: digest / status
# ===========================================================================


def build_report(reference=None) -> str:
    ref = reference or now()
    state = load_state()
    docs = read_run_docs()
    findings, notes = collect(docs, ref)

    by_kind: dict = {}
    for f in findings:
        by_kind.setdefault(f.kind, []).append(f)

    lines = [f"📋 Aries pipeline digest — {iso(ref)}"]
    lines.append(f"armed: {state.get('armed_at') or 'not armed'} · last tick: {state.get('last_tick_at') or 'never'}")

    stage_counts = notes["by_stage_code"]
    if stage_counts:
        detail = ", ".join(f"{k}×{v}" for k, v in sorted(stage_counts.items(), key=lambda kv: -kv[1])[:MAX_NAMED_ITEMS])
        lines.append(f"run failures ({LOOKBACK_HOURS} h): {detail}")
    else:
        lines.append(f"run failures ({LOOKBACK_HOURS} h): none")
    lines.append(f"provider-auth failures: {notes['auth_suppressed']} (covered by hermes-auth-sentinel)")

    degraded = by_kind.get("SYNC_DEGRADED", [])
    lines.append(f"degraded sync accounts: {len(degraded)}")
    for f in degraded[:MAX_NAMED_ITEMS]:
        lines.append(f"  • {f.label}")

    for kind in ("SYNC_SILENT", "TRIGGER_SILENCE"):
        for f in by_kind.get(kind, []):
            lines.append(f"{kind}: {f.label}")

    quarantine = psql_query(SQL_QUARANTINE)
    if quarantine is None:
        lines.append("quarantined objects: db unavailable")
    elif quarantine and len(quarantine[0]) >= 3:
        m, c, striking = quarantine[0][:3]
        lines.append(f"quarantined objects: metrics={m} comments={c} (striking, not yet quarantined: {striking})")

    disabled = psql_query(SQL_DISABLED_ACCOUNTS)
    if disabled is None:
        lines.append("disabled insights accounts: db unavailable")
    else:
        lines.append(f"disabled insights accounts: {len(disabled)}")
        for row in disabled[:MAX_NAMED_ITEMS]:
            if len(row) >= 3:
                lines.append(f"  • tenant {row[0]} {row[1]} — {row[2]}")

    if notes["db_unavailable"]:
        lines.append("NOTE: db unavailable — DB-backed sections above are incomplete.")
    return "\n".join(lines)


def run_digest() -> int:
    send_telegram(build_report())
    return 0


def run_status() -> int:
    print(build_report())
    return 0


# ===========================================================================
# SECTION T: self-test
# ===========================================================================

_SCENARIOS: list = []


def scenario(fn):
    _SCENARIOS.append((fn.__name__, fn))
    return fn


@contextlib.contextmanager
def fixture(docs=None, psql=None, armed=True):
    """Throwaway state dir + fixture run docs + a stubbed psql, with sends
    captured instead of delivered."""
    prev = (CFG.data_root, CFG.state_dir, CFG.psql_stub, CFG.capture_sends, CFG.dry_run)
    tmp = Path(tempfile.mkdtemp(prefix="pipemon-selftest-"))
    CFG.data_root = tmp / "data"
    CFG.state_dir = tmp / "state"
    jobs = CFG.data_root / "generated" / "draft" / "marketing-jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    for i, doc in enumerate(docs or []):
        (jobs / f"job{i}.json").write_text(json.dumps(doc), encoding="utf-8")
    CFG.psql_stub = psql if psql is not None else (lambda sql: [])
    CFG.capture_sends = True
    CFG.dry_run = False
    SENT.clear()
    if armed:
        st = _fresh_state()
        st["armed_at"] = iso(now() - dt.timedelta(days=1))
        _ensure_state_dir()
        atomic_write_json(CFG.state_dir / "state.json", st)
    try:
        yield tmp
    finally:
        CFG.data_root, CFG.state_dir, CFG.psql_stub, CFG.capture_sends, CFG.dry_run = prev
        SENT.clear()


def failed_doc(job_id, tenant, code, message, stage="strategy", age_hours=1):
    at = iso(now() - dt.timedelta(hours=age_hours))
    return {
        "job_id": job_id, "tenant_id": str(tenant), "state": "failed", "status": "failed",
        "current_stage": stage, "created_at": at, "updated_at": at,
        "last_error": {"code": code, "message": message, "stage": stage, "at": at},
    }


def no_db(sql):
    return None


@scenario
def bootstrap_arming_suppresses_preexisting():
    docs = [failed_doc(f"mkt_{i}", 15, "hermes_run_failed", "boom") for i in range(7)]
    with fixture(docs=docs, armed=False):
        tick()
        assert len(SENT) == 1, f"arming must send exactly one line, got {len(SENT)}"
        assert "armed" in SENT[0], SENT[0]
        assert "7 pre-existing" in SENT[0], SENT[0]
        SENT.clear()
        tick()
        assert SENT == [], f"an armed pre-existing failure must stay quiet, got {SENT}"


@scenario
def new_failure_alerts_once_then_dedupes():
    docs = [failed_doc("mkt_new", 70, "hermes_run_failed", "Hermes run failed without an error message.")]
    with fixture(docs=docs):
        tick()
        assert len(SENT) == 1, f"expected one alert, got {SENT}"
        assert "weekly runs failing" in SENT[0], SENT[0]
        assert "tenant 70" in SENT[0], SENT[0]
        SENT.clear()
        tick()
        assert SENT == [], f"the same failure must not re-alert within the cadence, got {SENT}"


@scenario
def resolved_note_after_alert():
    docs = [failed_doc("mkt_gone", 15, "hermes_run_failed", "boom")]
    with fixture(docs=docs) as tmp:
        tick()
        assert len(SENT) == 1
        SENT.clear()
        for p in (tmp / "data" / "generated" / "draft" / "marketing-jobs").iterdir():
            p.unlink()
        tick()
        assert len(SENT) == 1, f"expected one resolution note, got {SENT}"
        assert SENT[0].startswith("✅ Resolved"), SENT[0]


@scenario
def provider_auth_failures_are_digest_only():
    """Reviewer requirement: the sentinel owns provider-auth outages. An
    auth-signature doc must never alert; a non-auth doc alongside it must."""
    auth = failed_doc(
        "mkt_auth", 15, "hermes_run_failed",
        "⚠️ Provider authentication failed: Codex token refresh failed: Could not "
        "validate your refresh token. Please try signing in again.",
    )
    gateway_401 = failed_doc("mkt_401", 69, "auto_advance_submit_failed",
                             "Hermes gateway returned HTTP 401 on /v1/runs.")
    real = failed_doc("mkt_real", 70, "hermes_video_artifact_ingest_failed",
                      "Hermes completed video rendering without any ingestible artifacts.",
                      stage="production")
    with fixture(docs=[auth, gateway_401, real]):
        tick()
        assert len(SENT) == 1, f"exactly one alert (the non-auth one), got {SENT}"
        body = SENT[0]
        assert "tenant 70" in body, body
        assert "tenant 15" not in body, "provider-auth doc leaked into an alert: " + body
        assert "tenant 69" not in body, "gateway 401 doc leaked into an alert: " + body
        report = build_report()
        assert "provider-auth failures: 2 (covered by hermes-auth-sentinel)" in report, report


@scenario
def sync_degraded_fires_from_stubbed_psql():
    def psql(sql):
        if "insights_sync_runs" in sql and "GROUP BY" in sql:
            return [["15", "3", "facebook", "12", "12", "fetchPostMetrics(1_2): (#100) object"]]
        if "max(started_at)" in sql:
            return [[iso(now())]]
        return [["0"]]
    with fixture(psql=psql):
        tick()
        assert len(SENT) == 1, SENT
        assert "Insights sync degraded" in SENT[0], SENT[0]
        assert "tenant 15" in SENT[0], SENT[0]


@scenario
def sync_silent_fires_when_stale():
    stale = iso(now() - dt.timedelta(hours=5))
    def psql(sql):
        if "max(started_at)" in sql:
            return [[stale]]
        return [["0"]]
    with fixture(psql=psql):
        tick()
        assert len(SENT) == 1, SENT
        assert "sync worker silent" in SENT[0], SENT[0]


@scenario
def sync_silent_never_fires_on_empty_or_null_max():
    """Reviewer requirement: a fresh DB / an empty psql result is 'unknown',
    not 'the worker is dead'."""
    # "", no rows at all, and a literal NULL field — all must be silent.
    for empty in ([[""]], [], [[None]], [["   "]]):
        def psql(sql, empty=empty):
            if "max(started_at)" in sql:
                return empty
            return [["0"]]
        with fixture(psql=psql):
            tick()
            assert SENT == [], f"empty max(started_at) must not alert, got {SENT}"


@scenario
def db_unavailable_still_runs_run_doc_detector():
    docs = [failed_doc("mkt_dbdown", 70, "marketing_job_stalled", "stalled")]
    with fixture(docs=docs, psql=no_db):
        tick()
        assert len(SENT) == 1, f"the run-doc detector must still alert, got {SENT}"
        assert "weekly runs failing" in SENT[0], SENT[0]
        report = build_report()
        assert "db unavailable" in report, report


@scenario
def db_unavailable_does_not_resolve_db_backed_conditions():
    """A DB outage must not be read as 'the degraded account recovered'."""
    def psql(sql):
        if "insights_sync_runs" in sql and "GROUP BY" in sql:
            return [["15", "3", "facebook", "12", "12", "err"]]
        if "max(started_at)" in sql:
            return [[iso(now())]]
        return [["0"]]
    with fixture(psql=psql):
        tick()
        assert len(SENT) == 1, SENT
        SENT.clear()
        CFG.psql_stub = no_db
        tick()
        assert SENT == [], f"a db outage must not emit a resolution note, got {SENT}"


@scenario
def trigger_silence_fires_when_schedules_enabled_but_no_runs():
    old = failed_doc("mkt_old", 15, "x", "y", age_hours=24 * 30)
    old["status"] = "completed"
    old["state"] = "completed"
    def psql(sql):
        if "marketing_schedule" in sql:
            return [["4"]]
        if "max(started_at)" in sql:
            return [[iso(now())]]
        return []
    with fixture(docs=[old], psql=psql):
        tick()
        assert len(SENT) == 1, SENT
        assert "Weekly trigger silent" in SENT[0], SENT[0]


@scenario
def dry_run_sends_nothing_and_writes_no_state():
    docs = [failed_doc("mkt_dry", 15, "hermes_run_failed", "boom")]
    with fixture(docs=docs, armed=False):
        CFG.dry_run = True
        tick()
        assert not (CFG.state_dir / "state.json").exists(), "dry-run must not persist state"


@scenario
def message_caps_named_items():
    docs = [failed_doc(f"mkt_cap{i}", i, "hermes_run_failed", "boom") for i in range(12)]
    with fixture(docs=docs):
        tick()
        assert len(SENT) == 1, SENT
        bullets = [ln for ln in SENT[0].splitlines() if ln.startswith("• ")]
        assert len(bullets) == MAX_NAMED_ITEMS + 1, bullets
        assert bullets[-1] == f"• +{12 - MAX_NAMED_ITEMS} more", bullets[-1]


@scenario
def no_secret_material_in_messages():
    """Nothing the monitor emits may carry a credential-shaped string."""
    docs = [failed_doc("mkt_sec", 15, "hermes_run_failed", "boom")]
    def psql(sql):
        if "max(started_at)" in sql:
            return [[iso(now())]]
        return [["0"]]
    with fixture(docs=docs, psql=psql):
        tick()
        blob = "\n".join(SENT) + build_report()
        for needle in ("POSTGRES_PASSWORD", "HERMES_API_SERVER_KEY", "Bearer ", "password="):
            assert needle not in blob, f"{needle} leaked into monitor output"


def run_self_test() -> int:
    failures = []
    for name, fn in _SCENARIOS:
        try:
            fn()
        except AssertionError as exc:
            failures.append((name, str(exc)))
        except Exception as exc:  # noqa: BLE001 — report, don't abort the suite
            failures.append((name, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"))
    for name, msg in failures:
        print(f"SELF-TEST FAIL: {name}: {msg}")
    print(f"SELF-TEST: {len(_SCENARIOS)} scenarios, {len(failures)} failed")
    return 1 if failures else 0


# ===========================================================================
# SECTION G: CLI
# ===========================================================================


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Aries pipeline monitor — stage-failure and sync-degradation alerting.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--cron", action="store_true", help="run one detection tick (default)")
    mode.add_argument("--digest", action="store_true", help="send the daily digest")
    mode.add_argument("--status", action="store_true", help="print the digest without sending")
    mode.add_argument("--self-test", action="store_true", help="run the in-script fixture suite")
    parser.add_argument("--dry-run", action="store_true", help="print instead of sending; no state writes")
    return parser


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)
    CFG.dry_run = bool(args.dry_run)

    if args.self_test:
        return run_self_test()
    if args.status:
        return run_status()

    mode = "digest" if args.digest else "cron"
    lock = CFG.state_dir / "tick.lock"
    try:
        with file_lock(lock, timeout=5.0):
            return run_digest() if mode == "digest" else tick()
    except LockTimeout:
        log(f"{mode}: lock busy — skipping this run")
        return 0
    except Exception as exc:  # noqa: BLE001 — a monitor crash must not be silent
        log(f"{mode}: crashed: {type(exc).__name__}: {exc}")
        for line in traceback.format_exc().rstrip().splitlines():
            log(f"{mode}:   {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
