#!/usr/bin/env python3
"""Agent-Reach cookie drop-box ingest.

Installs a cookie store that the owner's LOCAL machine minted and pushed over
the tailnet. Runs from cron with no human present.

THE TRANSPORT, AND WHY
----------------------
Cookies are minted on the owner's residential machine (his browser, his IP,
throwaway accounts) and must reach this VM. Three properties are required: no
plaintext cookie may ever transit Telegram; nothing may listen on a new port;
and the whole thing must survive the desktop being offline for days.

  * PAYLOAD (local → VM): `scp` over Tailscale SSH into ~/.agent-reach-inbox/.
    In transit it is WireGuard (ChaCha20-Poly1305) between two devices that
    both authenticated to the tailnet; authorisation is the tailnet ACL plus
    the SSH key. No new service, no new bearer token to rotate, no new
    listening socket — the SSH daemon and the tailnet already exist and are
    already authenticated. An HTTP receiver would re-implement authentication
    the tailnet already performs and add attack surface for nothing.
  * AT REST: the blob is gpg-encrypted to a VM-only key BEFORE it leaves the
    local machine. So the file sitting in the inbox — and any copy of it that
    lands in an off-host backup — is useless without the VM private key. The
    private key is generated on the VM and never leaves it.
  * SIGNAL (VM → local): there is none, by design. See "PULL, NOT PUSH" in
    ops/local-cookie-agent/README.md — the desktop polls this VM's prober state
    over the tailnet, because a push to a machine that is offline for three
    days is a signal that gets lost. Telegram carries OPERATOR alerts only
    (the monitor's COOKIE_STALE), never machine-to-machine signalling and never
    cookie material.
  * LAST RESORT: if the tailnet is down entirely, the same gpg blob can be sent
    as a Telegram document attachment. Still ciphertext, still only openable by
    the VM key — the "never plaintext over Telegram" rule holds either way.

NON-INTERACTIVE DECRYPT (this is a real footgun)
------------------------------------------------
Cron has no TTY and no pinentry. `gpg --quick-generate-key … default default
never` will happily create a PASSPHRASE-PROTECTED key, and the first cron
decrypt then hangs or fails with "Inappropriate ioctl for device". The VM
ingest key must therefore be created UNPROTECTED (`--batch --passphrase ''`),
or a passphrase file must be supplied via ARINGEST_PASSPHRASE_FILE, which this
script feeds through `--pinentry-mode loopback`. Both invocations are exercised
by the self-test against a real, throwaway gpg keyring.

FULL-SNAPSHOT SEMANTICS
-----------------------
An installed payload REPLACES ~/.agent-reach/config.yaml wholesale. A payload
carrying only Instagram therefore drops the X/Reddit/Facebook sessions. That is
deliberate — merging YAML without a YAML parser guaranteed on the host is how
you silently corrupt a credential store — so the local generator always exports
a FULL snapshot, and the prober notices within one cycle if it did not.

VALIDATION IS STRUCTURAL, NOT SCHEMA-BASED
------------------------------------------
Upstream documents only Twitter's field names (auth_token, ct0). Reddit,
Instagram and Facebook are "browser login state" with unpublished key names. A
validator that insisted on guessed field names would silently reject real
payloads and starve the research stage of exactly the data this item exists to
provide. So the check is: it parses, it has at least one tracked top-level
platform key, its leaf values are non-empty, and it is not the placeholder
fixture.

Single file, python3 stdlib only (PyYAML is used when importable, never
required). Modes: --cron (default), --status, --self-test, plus --dry-run.

Install: see ops/agent-reach/README.md.
"""

from __future__ import annotations

import argparse
import builtins
import contextlib
import dataclasses
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

PLACEHOLDER = "PLACEHOLDER_NEVER_REAL"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _env_str(name: str, default: str) -> str:
    return os.environ.get(f"ARINGEST_{name}", default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(f"ARINGEST_{name}")
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclasses.dataclass
class Config:
    inbox: Path = dataclasses.field(
        default_factory=lambda: Path(_env_str("INBOX", str(Path.home() / ".agent-reach-inbox"))).expanduser())
    store: Path = dataclasses.field(
        default_factory=lambda: Path(_env_str("STORE", str(Path.home() / ".agent-reach/config.yaml"))).expanduser())
    state_path: Path = dataclasses.field(
        default_factory=lambda: Path(_env_str(
            "STATE", str(Path.home() / ".local/state/agent-reach-prober/ingest-state.json"))).expanduser())
    gpg_bin: str = _env_str("GPG", "gpg")
    passphrase_file: str = _env_str("PASSPHRASE_FILE", "")
    gnupghome: str = _env_str("GNUPGHOME", "")
    platforms: list = dataclasses.field(default_factory=lambda: [
        p.strip().lower() for p in _env_str("PLATFORMS", "twitter,reddit,instagram,facebook").split(",")
        if p.strip()])
    taildrop: bool = bool(_env_int("TAILDROP", 0))
    tailscale_bin: str = _env_str("TAILSCALE", "/usr/bin/tailscale")
    gpg_timeout_s: int = _env_int("GPG_TIMEOUT_S", 60)
    dry_run: bool = False


CFG = Config()


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"{iso(now())} ingest: {msg}")


# ===========================================================================
# Filesystem helpers
# ===========================================================================


def ensure_dir(path: Path, mode: int = 0o700) -> None:
    path.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(path, mode)


def atomic_install(path: Path, text: str) -> None:
    """Write `text` to `path` at 0600 via a same-directory temp file + rename.

    Same-directory so the rename is atomic (no cross-filesystem copy), and the
    temp file is created 0600 BEFORE any content is written, so the secret is
    never briefly world-readable.
    """
    ensure_dir(path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise
    with contextlib.suppress(OSError):
        os.chmod(path, 0o600)


def reject(blob: Path, reason: str) -> None:
    """Quarantine a blob so cron does not retry it forever.

    Leaving a bad blob in place would re-fail every few minutes; deleting it
    would destroy the evidence for why. `rejected/` does both jobs.
    """
    log(f"REJECT {blob.name}: {reason}")
    if CFG.dry_run:
        return
    quarantine = CFG.inbox / "rejected"
    ensure_dir(quarantine, 0o700)
    with contextlib.suppress(OSError):
        target = quarantine / f"{iso(now()).replace(':', '')}-{blob.name}"
        shutil.move(str(blob), str(target))
        os.chmod(target, 0o600)


# ===========================================================================
# Validation
# ===========================================================================


_TOP_LEVEL_KEY = re.compile(r"^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$")


def _structural_keys(text: str):
    """(top-level keys, leaf values under TRACKED platforms) from YAML-ish text.

    Only ever used when PyYAML is absent. It is not a YAML implementation and
    does not pretend to be — it is enough to answer "does this look like a
    populated store keyed by platform", which is all the validator asks.

    LEAVES ARE SCOPED TO TRACKED PLATFORMS, exactly like the PyYAML path.
    Counting leaves from every top-level section instead let a payload such as

        twitter:
        github:
          token: x

    validate on a bare host while the parser path correctly rejected it ("no
    values"). Since an install REPLACES the store wholesale, that divergence
    installed an empty twitter section over a live twitter session — a silent
    credential loss that only happened where PyYAML was missing.
    """
    top: list = []
    leaves: list = []
    section = None
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        match = _TOP_LEVEL_KEY.match(raw)
        if match and not raw[0].isspace():
            section = match.group(1).strip().lower()
            top.append(section)
            if section in CFG.platforms and match.group(2).strip():
                leaves.append(match.group(2).strip())
            continue
        indented = _TOP_LEVEL_KEY.match(raw.strip())
        if indented and indented.group(2).strip() and section in CFG.platforms:
            leaves.append(indented.group(2).strip())
    return top, leaves


def _flatten(value, out: list) -> None:
    if isinstance(value, dict):
        for item in value.values():
            _flatten(item, out)
    elif isinstance(value, list):
        for item in value:
            _flatten(item, out)
    elif value is not None:
        out.append(str(value))


def validate_store(text: str):
    """(ok, reason). Structural only — never a guessed per-platform schema."""
    if not text or not text.strip():
        return False, "payload is empty"
    if PLACEHOLDER in text:
        return False, "payload still contains placeholder values (this is the fixture, not a real store)"

    try:
        import yaml  # noqa: PLC0415 — optional; the fallback below is the contract
    except ImportError:
        yaml = None

    if yaml is not None:
        try:
            parsed = yaml.safe_load(text)
        except Exception as exc:  # noqa: BLE001 — any parse error is one answer
            return False, f"payload is not parseable YAML ({type(exc).__name__})"
        if not isinstance(parsed, dict):
            return False, "payload does not parse to a mapping"
        top = [str(k).strip().lower() for k in parsed.keys()]
        leaves: list = []
        for key in top:
            if key in CFG.platforms:
                _flatten(parsed[[k for k in parsed if str(k).strip().lower() == key][0]], leaves)
    else:
        top, leaves = _structural_keys(text)

    present = [p for p in CFG.platforms if p in top]
    if not present:
        return False, f"no tracked platform key present (want one of {', '.join(CFG.platforms)})"
    if not leaves or not any(str(v).strip() for v in leaves):
        return False, f"platform sections {present} carry no values"

    missing = [p for p in CFG.platforms if p not in top]
    if missing:
        # NOT an error: the owner may have only re-minted some accounts. But an
        # install REPLACES the store, so the omitted platforms lose their
        # session — say so loudly enough that it is never a surprise.
        log(f"note: payload omits {', '.join(missing)} — those sessions will be dropped by this install")
    return True, f"ok ({', '.join(present)})"


# ===========================================================================
# gpg
# ===========================================================================


def gpg_argv(blob: Path):
    """The exact non-interactive decrypt invocation, in one place.

    --batch --no-tty: no prompts, ever. --yes: no overwrite question.
    --pinentry-mode loopback + --passphrase-file: the ONLY way a protected key
    can be used from cron; omitted entirely when the key is unprotected, which
    is the recommended setup.
    """
    argv = [CFG.gpg_bin, "--batch", "--yes", "--quiet", "--no-tty", "--decrypt"]
    if CFG.gnupghome:
        argv[1:1] = ["--homedir", CFG.gnupghome]
    if CFG.passphrase_file:
        argv[1:1] = ["--pinentry-mode", "loopback", "--passphrase-file", CFG.passphrase_file]
    argv.append(str(blob))
    return argv


def gpg_decrypt(blob: Path):
    """(text, None) or (None, reason). Never raises."""
    try:
        proc = subprocess.run(
            gpg_argv(blob), capture_output=True, text=True, timeout=CFG.gpg_timeout_s,
        )
    except subprocess.TimeoutExpired:
        # Almost always a passphrase-protected key waiting on a pinentry that
        # will never come. Named explicitly because the generic message sends
        # operators hunting the wrong thing.
        return None, ("gpg timed out — the ingest key is probably passphrase-protected; "
                      "recreate it unprotected or set ARINGEST_PASSPHRASE_FILE")
    except OSError as exc:
        return None, f"cannot run gpg: {type(exc).__name__}"
    if proc.returncode != 0:
        detail = " ".join((proc.stderr or "").split())[:160]
        return None, f"gpg exited {proc.returncode}: {detail}"
    return proc.stdout, None


# ===========================================================================
# Taildrop
# ===========================================================================


def drain_taildrop() -> None:
    """`tailscale file cp` delivers into the Taildrop inbox, NOT to a path.

    The blob only becomes a file in ~/.agent-reach-inbox/ once something runs
    `tailscale file get`. Without this step a Taildrop-based push looks like it
    worked on the sending side and silently never arrives here. Off by default
    (scp is the primary path); enable with ARINGEST_TAILDROP=1.
    """
    if not CFG.taildrop:
        return
    try:
        proc = subprocess.run(
            [CFG.tailscale_bin, "file", "get", "--conflict=rename", str(CFG.inbox)],
            capture_output=True, text=True, timeout=60,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        log(f"taildrop drain skipped: {type(exc).__name__}")
        return
    if proc.returncode != 0:
        # "no files" is the normal case and exits non-zero on some versions.
        log(f"taildrop drain: rc={proc.returncode} {' '.join((proc.stderr or '').split())[:120]}")


# ===========================================================================
# Ingest
# ===========================================================================


def check_blob_perms(blob: Path):
    """(ok, reason). Ownership first, then mode."""
    try:
        st = blob.stat()
    except OSError as exc:
        return False, f"cannot stat ({type(exc).__name__})"
    if st.st_uid != os.getuid():
        return False, "not owned by this user"
    if st.st_mode & 0o077:
        return False, f"group/world-accessible (mode {oct(st.st_mode & 0o777)})"
    return True, ""


def save_state(entry: dict) -> None:
    if CFG.dry_run:
        return
    ensure_dir(CFG.state_path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{CFG.state_path.name}.", suffix=".tmp",
                                    dir=str(CFG.state_path.parent))
    tmp = Path(tmp_name)
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(entry, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, CFG.state_path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise
    with contextlib.suppress(OSError):
        os.chmod(CFG.state_path, 0o600)


PARTIAL_SUFFIX = ".partial"
PARTIAL_MAX_AGE_H = 24


def sweep_partials() -> None:
    """Delete in-flight uploads that were abandoned.

    refresh-cookies.sh uploads to `<name>.gpg.partial` and renames into place,
    so a blob is never read mid-transfer (the glob below only matches `.gpg`).
    An interrupted scp leaves the `.partial` behind; without this it would sit
    in the inbox forever. Age-gated so a transfer running RIGHT NOW is never
    deleted out from under itself.
    """
    cutoff = time.time() - PARTIAL_MAX_AGE_H * 3600
    try:
        stragglers = [p for p in CFG.inbox.iterdir()
                      if p.is_file() and p.suffix == PARTIAL_SUFFIX]
    except OSError:
        return
    for path in stragglers:
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                log(f"swept abandoned upload {path.name} (older than {PARTIAL_MAX_AGE_H} h)")
        except OSError:
            continue


def ingest_once() -> int:
    """Process every blob in the inbox, oldest first. Returns install count."""
    ensure_dir(CFG.inbox, 0o700)
    drain_taildrop()
    try:
        blobs = sorted((p for p in CFG.inbox.iterdir() if p.is_file() and p.suffix == ".gpg"),
                       key=lambda p: p.stat().st_mtime)
    except OSError as exc:
        log(f"cannot read inbox: {type(exc).__name__}")
        return 0

    sweep_partials()

    installed = 0
    for blob in blobs:
        ok, reason = check_blob_perms(blob)
        if not ok:
            reject(blob, reason)
            continue
        text, reason = gpg_decrypt(blob)
        if text is None:
            reject(blob, reason or "decrypt failed")
            continue
        ok, reason = validate_store(text)
        if not ok:
            reject(blob, reason)
            continue
        if CFG.dry_run:
            log(f"DRY-RUN would install {blob.name} → {CFG.store} ({reason})")
            installed += 1
            continue
        atomic_install(CFG.store, text)
        with contextlib.suppress(OSError):
            blob.unlink()
        installed += 1
        log(f"installed {blob.name} → {CFG.store} ({reason})")
        save_state({"last_install_at": iso(now()), "source": blob.name, "summary": reason})
    if not blobs:
        log("inbox empty")
    return installed


def run_status() -> int:
    print(f"inbox: {CFG.inbox}")
    print(f"store: {CFG.store}", end="")
    if CFG.store.exists():
        st = CFG.store.stat()
        print(f"  (mode {oct(st.st_mode & 0o777)}, {st.st_size} bytes, mtime {iso(dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc))})")
    else:
        print("  (absent — no payload has been ingested yet)")
    try:
        state = json.loads(CFG.state_path.read_text(encoding="utf-8"))
        print(f"last install: {state.get('last_install_at')} ({state.get('summary')})")
    except (OSError, ValueError):
        print("last install: never")
    pending = list(CFG.inbox.glob("*.gpg")) if CFG.inbox.exists() else []
    print(f"pending blobs: {len(pending)}")
    rejected = list((CFG.inbox / "rejected").glob("*")) if (CFG.inbox / "rejected").exists() else []
    print(f"rejected blobs: {len(rejected)}")
    return 0


# ===========================================================================
# SECTION T: self-test
# ===========================================================================

_SCENARIOS: list = []
_SKIPPED: list = []


def scenario(fn):
    _SCENARIOS.append((fn.__name__, fn))
    return fn


class Skip(Exception):
    pass


@contextlib.contextmanager
def fixture():
    prev = (CFG.inbox, CFG.store, CFG.state_path, CFG.gnupghome, CFG.passphrase_file,
            CFG.dry_run, CFG.taildrop)
    tmp = Path(tempfile.mkdtemp(prefix="aringest-selftest-"))
    CFG.inbox = tmp / "inbox"
    CFG.store = tmp / "store" / "config.yaml"
    CFG.state_path = tmp / "state" / "ingest-state.json"
    CFG.gnupghome = ""
    CFG.passphrase_file = ""
    CFG.dry_run = False
    CFG.taildrop = False
    ensure_dir(CFG.inbox, 0o700)
    try:
        yield tmp
    finally:
        (CFG.inbox, CFG.store, CFG.state_path, CFG.gnupghome, CFG.passphrase_file,
         CFG.dry_run, CFG.taildrop) = prev
        shutil.rmtree(tmp, ignore_errors=True)


REAL_STORE = (
    "twitter:\n"
    "  auth_token: tw-not-a-real-value\n"
    "  ct0: tw-not-a-real-ct0\n"
    "reddit:\n"
    "  session: rd-not-a-real-value\n"
    "instagram:\n"
    "  sessionid: ig-not-a-real-value\n"
    "facebook:\n"
    "  c_user: fb-not-a-real-user\n"
    "  xs: fb-not-a-real-xs\n"
)


def _gpg_available() -> bool:
    try:
        subprocess.run([CFG.gpg_bin, "--version"], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return True


@contextlib.contextmanager
def throwaway_keyring(protected=False):
    """A real, disposable gpg keyring so the decrypt path is exercised for real.

    The whole point of the protected=True variant is to prove the loopback
    invocation works without a TTY — the failure mode this guards is cron
    hanging on pinentry forever.
    """
    if not _gpg_available():
        raise Skip("gpg not available on this host")
    home = Path(tempfile.mkdtemp(prefix="aringest-gnupg-"))
    os.chmod(home, 0o700)
    passphrase = "selftest-throwaway-passphrase" if protected else ""
    argv = [CFG.gpg_bin, "--batch", "--yes", "--homedir", str(home),
            "--pinentry-mode", "loopback", "--passphrase", passphrase,
            "--quick-generate-key", "aries-cookie-selftest@example.invalid", "default", "default", "never"]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        shutil.rmtree(home, ignore_errors=True)
        raise Skip(f"gpg key generation unavailable here (rc={proc.returncode})")
    try:
        yield home, passphrase
    finally:
        shutil.rmtree(home, ignore_errors=True)


def encrypt_to(home: Path, text: str, dest: Path) -> None:
    proc = subprocess.run(
        [CFG.gpg_bin, "--batch", "--yes", "--homedir", str(home), "--trust-model", "always",
         "--recipient", "aries-cookie-selftest@example.invalid", "--output", str(dest), "--encrypt"],
        input=text, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, f"fixture encryption failed: {proc.stderr}"
    os.chmod(dest, 0o600)


@scenario
def installs_an_encrypted_payload_at_0600_atomically():
    with fixture(), throwaway_keyring() as (home, _):
        CFG.gnupghome = str(home)
        encrypt_to(home, REAL_STORE, CFG.inbox / "cookies.yaml.gpg")
        assert ingest_once() == 1
        assert CFG.store.read_text(encoding="utf-8") == REAL_STORE
        assert oct(CFG.store.stat().st_mode & 0o777) == "0o600", oct(CFG.store.stat().st_mode)
        assert oct(CFG.store.parent.stat().st_mode & 0o777) == "0o700"
        assert not (CFG.inbox / "cookies.yaml.gpg").exists(), "an installed blob must be removed"
        state = json.loads(CFG.state_path.read_text(encoding="utf-8"))
        assert state["last_install_at"], state


@scenario
def loopback_passphrase_file_decrypts_without_a_tty():
    """The cron-safe path for a PROTECTED key. If this ever regresses, ingest
    hangs on pinentry and the store silently stops being refreshed."""
    with fixture(), throwaway_keyring(protected=True) as (home, passphrase):
        CFG.gnupghome = str(home)
        pf = Path(home) / "pass.txt"
        pf.write_text(passphrase, encoding="utf-8")
        os.chmod(pf, 0o600)
        CFG.passphrase_file = str(pf)
        assert "--pinentry-mode" in gpg_argv(Path("x.gpg")), gpg_argv(Path("x.gpg"))
        encrypt_to(home, REAL_STORE, CFG.inbox / "cookies.yaml.gpg")
        assert ingest_once() == 1
        assert CFG.store.read_text(encoding="utf-8") == REAL_STORE


@scenario
def unprotected_key_invocation_carries_no_pinentry_flags():
    with fixture():
        argv = gpg_argv(Path("x.gpg"))
        assert "--batch" in argv and "--no-tty" in argv, argv
        assert "--pinentry-mode" not in argv, "loopback is only for a passphrase file"


@scenario
def rejects_a_world_readable_blob():
    with fixture(), throwaway_keyring() as (home, _):
        CFG.gnupghome = str(home)
        blob = CFG.inbox / "leaky.yaml.gpg"
        encrypt_to(home, REAL_STORE, blob)
        os.chmod(blob, 0o644)
        assert ingest_once() == 0, "a world-readable blob must never be installed"
        assert not CFG.store.exists()
        quarantined = list((CFG.inbox / "rejected").iterdir())
        assert len(quarantined) == 1, quarantined


@scenario
def rejects_an_undecryptable_blob():
    """Wrong recipient / tampered ciphertext / random bytes all land here."""
    with fixture():
        if not _gpg_available():
            raise Skip("gpg not available on this host")
        blob = CFG.inbox / "garbage.yaml.gpg"
        blob.write_bytes(b"\x00\x01not gpg at all\x02")
        os.chmod(blob, 0o600)
        assert ingest_once() == 0
        assert not CFG.store.exists()
        assert len(list((CFG.inbox / "rejected").iterdir())) == 1


@scenario
def rejects_the_placeholder_fixture():
    """The shipped placeholder must never become a live store."""
    placeholder = (FIXTURES / "agent-reach-config.placeholder.yaml").read_text(encoding="utf-8")
    ok, reason = validate_store(placeholder)
    assert not ok, "the placeholder fixture must never validate"
    assert "placeholder" in reason.lower(), reason
    with fixture(), throwaway_keyring() as (home, _):
        CFG.gnupghome = str(home)
        encrypt_to(home, placeholder, CFG.inbox / "placeholder.yaml.gpg")
        assert ingest_once() == 0
        assert not CFG.store.exists()


@scenario
def rejects_structurally_empty_payloads():
    for text, why in (
        ("", "empty"),
        ("# only a comment\n", "no keys"),
        ("github:\n  token: x\n", "no tracked platform"),
        ("twitter:\nreddit:\n", "keys with no values"),
    ):
        ok, reason = validate_store(text)
        assert not ok, f"{why}: should have been rejected, got {reason}"


@scenario
def accepts_unverified_platform_field_names():
    """Reviewer requirement: the validator must NOT hard-code per-platform
    field names. Only twitter's are documented upstream; reddit/IG/FB key names
    are guesses, and a schema check built on guesses would silently drop real
    payloads and starve the pipeline."""
    exotic = (
        "twitter:\n  auth_token: a-value\n  ct0: another\n"
        "reddit:\n  cookie_jar_b64: some-blob\n"
        "instagram:\n  browser_profile: /home/x/profile\n  ds_user_id: '12345'\n"
        "facebook:\n  whatever_upstream_calls_it: value\n"
    )
    ok, reason = validate_store(exotic)
    assert ok, f"unknown-but-populated field names must validate: {reason}"


@scenario
def a_partial_snapshot_validates_but_is_announced():
    ok, reason = validate_store("instagram:\n  sessionid: only-this-one\n")
    assert ok, reason
    assert "instagram" in reason, reason


@scenario
def structural_fallback_matches_the_yaml_path():
    """The no-PyYAML path is the contract on a bare host — it must agree with
    the parser path on every case above."""
    top, leaves = _structural_keys(REAL_STORE)
    assert set(top) == {"twitter", "reddit", "instagram", "facebook"}, top
    assert len(leaves) == 6, leaves
    top, leaves = _structural_keys("# comment\ntwitter:\n  auth_token: v\n")
    assert top == ["twitter"], top
    assert leaves == ["v"], leaves

    # THE CASE THAT ACTUALLY DIVERGED. A tracked platform with an empty section
    # plus an UNtracked section that does carry values: the parser path counts
    # leaves only under tracked keys and rejects this, so the fallback must too.
    # It previously counted `x` as a value, validated, and installed an empty
    # twitter section over the live twitter session.
    empty_tracked_plus_populated_untracked = "twitter:\ngithub:\n  token: x\n"
    top, leaves = _structural_keys(empty_tracked_plus_populated_untracked)
    assert set(top) == {"twitter", "github"}, top
    assert leaves == [], f"leaves must be scoped to tracked platforms, got {leaves}"

    # And the validator itself must reject it, whichever path it took.
    ok, reason = validate_store(empty_tracked_plus_populated_untracked)
    assert not ok, f"should have been rejected, got ok with {reason}"
    assert "carry no values" in reason, reason

    # Cross-check both paths agree, on every payload the suite cares about, on
    # the hosts that have PyYAML. Run the real validator, then the same text
    # with the parser forcibly hidden, and compare the verdicts.
    try:
        import yaml  # noqa: F401,PLC0415
        have_yaml = True
    except ImportError:
        have_yaml = False
    if have_yaml:
        cases = (
            REAL_STORE,
            empty_tracked_plus_populated_untracked,
            "github:\n  token: x\n",
            "twitter:\nreddit:\n",
            "twitter:\n  auth_token: a-value\n",
        )
        real_import = builtins.__import__

        def no_yaml(name, *args, **kwargs):
            if name == "yaml":
                raise ImportError("yaml hidden by the self-test")
            return real_import(name, *args, **kwargs)

        for text in cases:
            with_yaml = validate_store(text)[0]
            builtins.__import__ = no_yaml
            try:
                without_yaml = validate_store(text)[0]
            finally:
                builtins.__import__ = real_import
            assert with_yaml == without_yaml, (
                f"paths disagree on {text!r}: PyYAML={with_yaml} fallback={without_yaml}"
            )


@scenario
def sweeps_abandoned_partial_uploads():
    """`<name>.gpg.partial` is what an interrupted scp leaves behind.

    The two-step upload in refresh-cookies.sh exists so a blob is never read
    mid-transfer; this is the other half — the leftovers get cleaned, but only
    once they are old enough that a live transfer cannot be the explanation.
    """
    with fixture():
        fresh = CFG.inbox / "cookies-now.yaml.gpg.partial"
        fresh.write_bytes(b"half a blob")
        old = CFG.inbox / "cookies-old.yaml.gpg.partial"
        old.write_bytes(b"half a blob")
        ancient = time.time() - (PARTIAL_MAX_AGE_H + 1) * 3600
        os.utime(old, (ancient, ancient))

        assert ingest_once() == 0, "a .partial must never be ingested"
        assert fresh.exists(), "an in-flight upload must not be deleted"
        assert not old.exists(), "an abandoned upload should have been swept"


@scenario
def dry_run_installs_nothing():
    with fixture(), throwaway_keyring() as (home, _):
        CFG.gnupghome = str(home)
        encrypt_to(home, REAL_STORE, CFG.inbox / "cookies.yaml.gpg")
        CFG.dry_run = True
        assert ingest_once() == 1, "dry-run still reports what it would do"
        assert not CFG.store.exists(), "dry-run must not write the store"
        assert (CFG.inbox / "cookies.yaml.gpg").exists(), "dry-run must not consume the blob"


@scenario
def an_empty_inbox_is_a_no_op():
    with fixture():
        assert ingest_once() == 0
        assert not CFG.store.exists()


def run_self_test() -> int:
    failures = []
    for name, fn in _SCENARIOS:
        try:
            fn()
        except Skip as exc:
            _SKIPPED.append((name, str(exc)))
        except AssertionError as exc:
            failures.append((name, str(exc)))
        except Exception as exc:  # noqa: BLE001 — report, don't abort the suite
            failures.append((name, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"))
    for name, msg in failures:
        print(f"SELF-TEST FAIL: {name}: {msg}")
    for name, msg in _SKIPPED:
        print(f"SELF-TEST SKIP: {name}: {msg}")
    print(f"SELF-TEST: {len(_SCENARIOS)} scenarios, {len(failures)} failed, {len(_SKIPPED)} skipped")
    return 1 if failures else 0


# ===========================================================================
# CLI
# ===========================================================================


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install Agent-Reach cookie payloads dropped over the tailnet.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--cron", action="store_true", help="drain the inbox (default)")
    mode.add_argument("--status", action="store_true", help="print inbox/store state")
    mode.add_argument("--self-test", action="store_true", help="run the in-script fixture suite")
    parser.add_argument("--dry-run", action="store_true", help="validate and report; install nothing")
    return parser


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)
    CFG.dry_run = bool(args.dry_run)
    if args.self_test:
        return run_self_test()
    if args.status:
        return run_status()
    try:
        ingest_once()
        return 0
    except Exception as exc:  # noqa: BLE001 — never die silently under cron
        log(f"crashed: {type(exc).__name__}: {exc}")
        for line in traceback.format_exc().rstrip().splitlines():
            log(f"  {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
