#!/usr/bin/env python3
"""Agent-Reach cookie-session freshness prober.

Answers one question per platform — "is the logged-in session on this VM still
alive?" — and writes the answer to a state file. It sends nothing, alerts
nobody, and touches no app state.

WHY THE PROBE AND THE ALERT ARE SEPARATE PROGRAMS
-------------------------------------------------
ops/aries-pipeline-monitor.py is the operator-alerting path and is deliberately
read-only and network-free: it reads run docs and runs SELECTs, so a bug in it
can never wedge the pipeline or hang on a socket. Probing a cookie session
means network I/O against Instagram/X/Reddit/Facebook, which can block, retry,
rate-limit, or (worst case) trip a platform's automation heuristics.

So the split is: this script owns the network probe and owns the state file;
the monitor reads that state file and owns the Telegram alert (its COOKIE_STALE
detector). A hung probe delays a state file. It cannot delay an alert tick, and
it cannot touch the app.

WHY `agent-reach doctor` AND NOT HAND-ROLLED PER-PLATFORM READS
---------------------------------------------------------------
`doctor` is Agent-Reach's own documented health surface ("checks each channel's
operational status"). Hand-rolling a logged-in-only read per platform (an X
self/home fetch, `rdt-cli me`, an IG own-profile read) would depend on CLI
sub-surfaces that are not verified against this tool AND would generate traffic
patterns unlike a normal read. `doctor` is the call the tool makes about itself;
it is the most boring thing we can send.

THE UNKNOWN RULE (borrowed verbatim from the monitor's empty-max(started_at)
reasoning): a timeout, a missing binary, an unparseable answer, or a platform
`doctor` did not mention are all UNKNOWN — never STALE. "The session is dead"
is precisely the conclusion that cannot be drawn from an absence of
information, and an alert nobody can act on is worse than none.

NO CREDENTIAL EVER REACHES THE STATE FILE. Every `detail` string is redacted
(see redact()) before it is written, pinned by a self-test scenario.

Single file, python3 stdlib only. Modes: --cron (default), --status,
--self-test, with --dry-run available on all of them.

Install: see ops/agent-reach/README.md.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

FRESH = "fresh"
STALE = "stale"
UNKNOWN = "unknown"

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _env_str(name: str, default: str) -> str:
    return os.environ.get(f"ARPROBE_{name}", default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(f"ARPROBE_{name}")
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Only the cookie-authenticated channels are tracked. The zero-config ones
# (web, youtube, rss, v2ex…) have no session that can go stale, so probing them
# would only add noise.
PLATFORMS = [
    p.strip().lower()
    for p in _env_str("PLATFORMS", "twitter,reddit,instagram,facebook").split(",")
    if p.strip()
]
AGENT_REACH_BIN = _env_str("BIN", str(Path.home() / ".local/bin/agent-reach"))
STATE_PATH = Path(
    _env_str("STATE", str(Path.home() / ".local/state/agent-reach-prober/state.json"))
).expanduser()
PROBE_TIMEOUT_S = _env_int("TIMEOUT_S", 90)


@dataclasses.dataclass
class Config:
    bin: str = AGENT_REACH_BIN
    state_path: Path = dataclasses.field(default_factory=lambda: STATE_PATH)
    platforms: list = dataclasses.field(default_factory=lambda: list(PLATFORMS))
    timeout_s: int = PROBE_TIMEOUT_S
    dry_run: bool = False
    # Self-test hook only. Production never sets this.
    # callable(argv: list[str]) -> (returncode, stdout, stderr) | raises
    run_stub = None


CFG = Config()


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime) -> str:
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"{iso(now())} {msg}")


# ===========================================================================
# Redaction — nothing credential-shaped may reach the state file
# ===========================================================================

# Named cookie/token fields, whatever the separator. The name is kept (it is
# useful: "auth_token expired" is actionable), the VALUE never is.
_KV = re.compile(
    r"\b(auth_token|ct0|sessionid|session|xs|c_user|csrftoken|token|cookie|password|secret|bearer)"
    r"\s*[:=]\s*\S+",
    re.IGNORECASE,
)
# Any bare high-entropy-looking run. Deliberately aggressive: a redacted word in
# an operator note costs nothing, a leaked session cookie costs the account.
_BLOB = re.compile(r"\b[A-Za-z0-9_\-]{24,}\b")

MAX_DETAIL = 160


def redact(text) -> str:
    """Make an arbitrary CLI string safe to persist and to show an operator."""
    if not isinstance(text, str):
        text = str(text)
    text = " ".join(text.split())
    text = _KV.sub(lambda m: f"{m.group(1)}=<redacted>", text)
    text = _BLOB.sub("<redacted>", text)
    return text[:MAX_DETAIL]


# ===========================================================================
# Classification
# ===========================================================================

# Ordered STALE-first: "not logged in" contains "logged in", and a status of
# "login required" must never be read as healthy.
_STALE_MARKERS = (
    "login required", "login_required", "not logged in", "not_logged_in",
    "unauthenticated", "unauthorized", "401", "expired", "re-login", "relogin",
    "needs login", "logged out", "invalid cookie", "cookie expired",
    "auth failed", "auth_failed", "forbidden", "403",
)
_FRESH_MARKERS = (
    "ok", "ready", "healthy", "authenticated", "logged in", "logged_in",
    "active", "pass", "available", "configured",
)


def classify(text) -> str:
    """fresh / stale / unknown from a status word or a whole line.

    Anything that matches neither vocabulary is UNKNOWN. Guessing FRESH would
    hide a dead session; guessing STALE would page the operator over a wording
    change upstream.
    """
    if text is None:
        return UNKNOWN
    if isinstance(text, bool):
        return FRESH if text else STALE
    low = str(text).strip().lower()
    if not low:
        return UNKNOWN
    for marker in _STALE_MARKERS:
        if marker in low:
            return STALE
    for marker in _FRESH_MARKERS:
        if re.search(rf"(?<![a-z]){re.escape(marker)}(?![a-z])", low):
            return FRESH
    return UNKNOWN


def _status_fields(entry: dict):
    """Yield the plausible status-carrying values of a channel object.

    `agent-reach doctor --json` has no published schema, so the parser reads
    several plausible key names rather than betting on one. Unread shapes fall
    through to UNKNOWN by construction.
    """
    for key in ("status", "state", "health", "auth", "ok", "healthy", "available"):
        if key in entry:
            yield entry[key]


def _detail_of(entry: dict) -> str:
    for key in ("detail", "message", "note", "reason", "error", "hint"):
        value = entry.get(key)
        if value:
            return redact(value)
    return ""


def parse_doctor_json(payload):
    """{platform: (status, detail)} from a parsed `doctor --json` document.

    Tolerates the two shapes such a document plausibly takes: a list of channel
    objects, or a mapping keyed by channel name. Unknown shapes yield nothing,
    which the caller turns into UNKNOWN for every platform.
    """
    out: dict = {}

    def take(name, entry):
        name = str(name).strip().lower()
        if name not in CFG.platforms:
            return
        if isinstance(entry, dict):
            status = UNKNOWN
            for value in _status_fields(entry):
                status = classify(value)
                if status != UNKNOWN:
                    break
            out[name] = (status, _detail_of(entry))
        else:
            out[name] = (classify(entry), "")

    if isinstance(payload, dict):
        for container_key in ("channels", "platforms", "results", "checks"):
            container = payload.get(container_key)
            if isinstance(container, list):
                for entry in container:
                    if isinstance(entry, dict):
                        take(entry.get("name") or entry.get("channel") or entry.get("platform"), entry)
                return out
            if isinstance(container, dict):
                for name, entry in container.items():
                    take(name, entry)
                return out
        # Flat mapping: {"twitter": {...}, …}
        for name, entry in payload.items():
            take(name, entry)
        return out

    if isinstance(payload, list):
        for entry in payload:
            if isinstance(entry, dict):
                take(entry.get("name") or entry.get("channel") or entry.get("platform"), entry)
    return out


def parse_doctor_text(text: str):
    """{platform: (status, detail)} from plain `agent-reach doctor` output.

    One line per platform, matched on the platform name. A platform that is not
    mentioned is simply absent from the result → UNKNOWN, never STALE.
    """
    out: dict = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        for platform in CFG.platforms:
            if platform in out:
                continue
            if re.search(rf"(?<![a-z0-9]){re.escape(platform)}(?![a-z0-9])", low):
                # Classify the remainder of the line, not the platform name
                # itself (some platform names contain fresh/stale substrings).
                remainder = re.sub(rf"(?<![a-z0-9]){re.escape(platform)}(?![a-z0-9])", " ", low, count=1)
                out[platform] = (classify(remainder), redact(line))
    return out


# ===========================================================================
# Probe
# ===========================================================================


def _run(argv):
    """(rc, stdout, stderr). Raises nothing the caller cannot handle."""
    if CFG.run_stub is not None:
        return CFG.run_stub(argv)
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=CFG.timeout_s)
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def probe():
    """{platform: {"status", "detail"}} for every configured platform.

    Tries `doctor --json` first, falls back to plain `doctor`. Every failure
    mode — binary missing, non-zero exit with no parseable body, timeout,
    unparseable output — resolves to UNKNOWN for every platform.
    """
    results = {p: {"status": UNKNOWN, "detail": "no answer from agent-reach doctor"}
               for p in CFG.platforms}

    parsed: dict = {}
    note = ""
    try:
        rc, out, err = _run([CFG.bin, "doctor", "--json"])
        if out.strip():
            try:
                parsed = parse_doctor_json(json.loads(out))
            except ValueError:
                parsed = {}
        if not parsed:
            # No --json support, or a shape the parser does not read. Plain
            # doctor is the documented surface; the JSON attempt is the bonus.
            rc, out, err = _run([CFG.bin, "doctor"])
            parsed = parse_doctor_text(out)
            if not parsed and rc != 0:
                note = redact(err or out or f"doctor exited {rc}")
    except subprocess.TimeoutExpired:
        note = f"doctor timed out after {CFG.timeout_s}s"
    except OSError as exc:
        # Binary absent / not executable. UNKNOWN, emphatically not STALE: an
        # uninstalled tool is not an expired cookie, and alerting on it here
        # would duplicate the install runbook's job.
        note = f"cannot run agent-reach: {type(exc).__name__}"
    except Exception as exc:  # noqa: BLE001 — a prober crash must not lose the state file
        note = f"probe error: {type(exc).__name__}"

    for platform, (status, detail) in parsed.items():
        results[platform] = {"status": status, "detail": detail}
    if note:
        for platform, entry in results.items():
            if entry["status"] == UNKNOWN:
                entry["detail"] = note
    return results


# ===========================================================================
# State
# ===========================================================================


def load_state() -> dict:
    try:
        data = json.loads(CFG.state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def atomic_write_json(path: Path, obj: dict) -> None:
    """0600 temp file in the same 0700 directory, fsync, rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(path.parent, 0o700)
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
    with contextlib.suppress(OSError):
        os.chmod(path, 0o600)


def build_state(results: dict, previous: dict, reference=None) -> dict:
    """Fold this probe into the persisted shape the monitor reads.

    `since` carries forward while a status is unchanged, so an operator (and the
    monitor's alert line) can see how long a session has been dead without the
    monitor having to keep its own history.
    """
    ref = reference or now()
    prev_platforms = previous.get("platforms") if isinstance(previous.get("platforms"), dict) else {}
    platforms = {}
    for name, entry in sorted(results.items()):
        prev = prev_platforms.get(name) if isinstance(prev_platforms.get(name), dict) else {}
        since = prev.get("since") if prev.get("status") == entry["status"] else None
        platforms[name] = {
            "status": entry["status"],
            "checked_at": iso(ref),
            "since": since or iso(ref),
            "detail": redact(entry.get("detail", "")),
        }
    return {"generated_at": iso(ref), "platforms": platforms}


def run_probe(reference=None) -> int:
    state = build_state(probe(), load_state(), reference)
    summary = ", ".join(f"{k}={v['status']}" for k, v in sorted(state["platforms"].items()))
    if CFG.dry_run:
        log(f"DRY-RUN would write {CFG.state_path}: {summary}")
        return 0
    atomic_write_json(CFG.state_path, state)
    log(f"probe: {summary}")
    return 0


def run_status() -> int:
    state = load_state()
    if not state:
        print(f"no state at {CFG.state_path} — the prober has not run yet")
        return 0
    print(f"agent-reach cookie sessions — probed {state.get('generated_at', '?')}")
    for name, entry in sorted((state.get("platforms") or {}).items()):
        detail = f" — {entry.get('detail')}" if entry.get("detail") else ""
        print(f"  {name:<10} {entry.get('status', '?'):<8} since {entry.get('since', '?')}{detail}")
    return 0


# ===========================================================================
# SECTION T: self-test
# ===========================================================================

_SCENARIOS: list = []


def scenario(fn):
    _SCENARIOS.append((fn.__name__, fn))
    return fn


@contextlib.contextmanager
def fixture(run_stub=None, platforms=None):
    prev = (CFG.state_path, CFG.run_stub, CFG.dry_run, CFG.platforms)
    tmp = Path(tempfile.mkdtemp(prefix="arprobe-selftest-"))
    CFG.state_path = tmp / "state" / "state.json"
    CFG.run_stub = run_stub
    CFG.dry_run = False
    CFG.platforms = platforms or ["twitter", "reddit", "instagram", "facebook"]
    try:
        yield tmp
    finally:
        (CFG.state_path, CFG.run_stub, CFG.dry_run, CFG.platforms) = prev


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def json_doctor(name):
    """A stub whose `doctor --json` answers with a fixture file."""
    body = fixture_text(name)

    def run(argv):
        if "--json" in argv:
            return 0, body, ""
        return 0, "", "unsupported"
    return run


def statuses():
    return {k: v["status"] for k, v in (load_state().get("platforms") or {}).items()}


@scenario
def json_doctor_all_ok_is_fresh():
    with fixture(run_stub=json_doctor("doctor-all-fresh.json")):
        run_probe()
        assert statuses() == {p: FRESH for p in CFG.platforms}, statuses()


@scenario
def json_doctor_login_required_is_stale():
    with fixture(run_stub=json_doctor("doctor-twitter-stale.json")):
        run_probe()
        got = statuses()
        assert got["twitter"] == STALE, got
        assert got["reddit"] == FRESH and got["instagram"] == FRESH and got["facebook"] == FRESH, got
        # A channel doctor reports but we do not track must not appear.
        assert "github" not in got, got


@scenario
def text_doctor_fallback_classifies_and_unmentioned_is_unknown():
    """No --json support → plain doctor. facebook is absent from that output;
    absent must be UNKNOWN, never STALE."""
    body = fixture_text("doctor-text-mixed.txt")

    def run(argv):
        if "--json" in argv:
            return 2, "", "unrecognized arguments: --json"
        return 0, body, ""

    with fixture(run_stub=run):
        run_probe()
        got = statuses()
        assert got["twitter"] == STALE, got
        assert got["reddit"] == FRESH, got
        assert got["instagram"] == FRESH, got
        assert got["facebook"] == UNKNOWN, f"an unmentioned platform must be unknown, got {got}"


@scenario
def missing_binary_is_unknown_not_stale():
    def run(argv):
        raise FileNotFoundError(argv[0])

    with fixture(run_stub=run):
        run_probe()
        got = statuses()
        assert set(got.values()) == {UNKNOWN}, f"a missing CLI is unknown, not dead: {got}"


@scenario
def timeout_is_unknown_not_stale():
    def run(argv):
        raise subprocess.TimeoutExpired(cmd=argv, timeout=CFG.timeout_s)

    with fixture(run_stub=run):
        run_probe()
        got = statuses()
        assert set(got.values()) == {UNKNOWN}, got
        detail = (load_state()["platforms"]["twitter"]["detail"] or "").lower()
        assert "timed out" in detail, detail


@scenario
def malformed_json_falls_back_to_text():
    text = "twitter ok\nreddit ok\ninstagram ok\nfacebook ok\n"

    def run(argv):
        if "--json" in argv:
            return 0, "{not json at all", ""
        return 0, text, ""

    with fixture(run_stub=run):
        run_probe()
        assert statuses() == {p: FRESH for p in CFG.platforms}, statuses()


@scenario
def unreadable_status_vocabulary_is_unknown():
    """Upstream rewording must degrade to UNKNOWN, not to a guess either way."""
    def run(argv):
        if "--json" in argv:
            return 0, json.dumps({"channels": [{"name": "twitter", "status": "flibbertigibbet"}]}), ""
        return 0, "", ""

    with fixture(run_stub=run, platforms=["twitter"]):
        run_probe()
        assert statuses() == {"twitter": UNKNOWN}, statuses()


@scenario
def state_is_0600_inside_a_0700_dir():
    with fixture(run_stub=json_doctor("doctor-all-fresh.json")):
        run_probe()
        assert oct(CFG.state_path.stat().st_mode & 0o777) == "0o600", oct(CFG.state_path.stat().st_mode)
        assert oct(CFG.state_path.parent.stat().st_mode & 0o777) == "0o700", \
            oct(CFG.state_path.parent.stat().st_mode)


@scenario
def no_cookie_material_reaches_the_state_file():
    """The stale fixture's detail carries a cookie-shaped value on purpose."""
    with fixture(run_stub=json_doctor("doctor-twitter-stale.json")):
        run_probe()
        blob = CFG.state_path.read_text(encoding="utf-8")
        for needle in ("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "auth_token=a"):
            assert needle not in blob, f"{needle} leaked into the state file"
        assert "<redacted>" in blob, "the redaction path did not fire at all"
        # The FIELD NAME is deliberately kept — "auth_token=<redacted> expired"
        # is what makes the alert actionable.
        assert "auth_token=<redacted>" in blob, blob


@scenario
def since_carries_forward_while_status_is_unchanged():
    with fixture(run_stub=json_doctor("doctor-twitter-stale.json")):
        run_probe(reference=now() - dt.timedelta(hours=5))
        first = load_state()["platforms"]["twitter"]
        run_probe()
        second = load_state()["platforms"]["twitter"]
        assert second["since"] == first["since"], "an unchanged status must keep its since"
        assert second["checked_at"] != first["checked_at"], "checked_at must advance every probe"


@scenario
def since_resets_when_status_changes():
    with fixture(run_stub=json_doctor("doctor-twitter-stale.json")) as _tmp:
        run_probe(reference=now() - dt.timedelta(hours=5))
        stale_since = load_state()["platforms"]["twitter"]["since"]
        CFG.run_stub = json_doctor("doctor-all-fresh.json")
        run_probe()
        entry = load_state()["platforms"]["twitter"]
        assert entry["status"] == FRESH, entry
        assert entry["since"] != stale_since, "a recovered session must restart its clock"


@scenario
def dry_run_writes_no_state():
    with fixture(run_stub=json_doctor("doctor-all-fresh.json")):
        CFG.dry_run = True
        run_probe()
        assert not CFG.state_path.exists(), "dry-run must not persist state"


@scenario
def probe_never_raises_on_a_broken_stub():
    """A prober crash would leave the monitor reading an ever-staler file while
    everything looks fine. Any unexpected exception must land as UNKNOWN."""
    def run(argv):
        raise RuntimeError("upstream exploded")

    with fixture(run_stub=run):
        run_probe()
        assert set(statuses().values()) == {UNKNOWN}, statuses()


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
# CLI
# ===========================================================================


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Agent-Reach cookie-session freshness prober (writes state; never alerts).",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--cron", action="store_true", help="probe and write the state file (default)")
    mode.add_argument("--status", action="store_true", help="print the last probe result")
    mode.add_argument("--self-test", action="store_true", help="run the in-script fixture suite")
    parser.add_argument("--dry-run", action="store_true", help="probe and print; write no state")
    return parser


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)
    CFG.dry_run = bool(args.dry_run)
    if args.self_test:
        return run_self_test()
    if args.status:
        return run_status()
    try:
        return run_probe()
    except Exception as exc:  # noqa: BLE001 — a prober crash must be loud, not silent
        log(f"probe crashed: {type(exc).__name__}: {exc}")
        for line in traceback.format_exc().rstrip().splitlines():
            log(f"  {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
