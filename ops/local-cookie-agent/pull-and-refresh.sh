#!/usr/bin/env bash
# The loop. Poll the VM's prober state over the tailnet; re-mint and re-ship
# anything it reports as stale.
#
#   ./pull-and-refresh.sh            # act on stale platforms
#   ./pull-and-refresh.sh --check    # report only, change nothing
#   ./pull-and-refresh.sh --force    # re-mint and ship everything regardless
#
# PULL, NOT PUSH — see ops/local-cookie-agent/README.md. This machine is often
# offline for days; staleness is a level, not an edge, so a poll after waking
# recovers what a lost push never would. Nothing listens on a port here.
#
# It reads ONE file over SSH and never writes to the VM except via
# refresh-cookies.sh's scp into the drop-box.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$here/config.env"
: "${VM_SSH_TARGET:?}" "${VM_PROBER_STATE:?}" "${PLATFORMS:?}"

mode="${1:-run}"
log() { printf '%s pull: %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [ "$mode" = "--force" ]; then
  log "forced refresh of: $PLATFORMS"
  exec "$here/refresh-cookies.sh" $PLATFORMS
fi

# ── Read the prober state ──────────────────────────────────────────────────
# A failure here is UNKNOWN, never "everything is fine" and never "everything
# is dead" — the same rule the VM's prober and monitor follow. The desktop being
# unable to reach the VM is not evidence about any cookie.
if ! state="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$VM_SSH_TARGET" \
              "cat '$VM_PROBER_STATE'" 2>/dev/null)"; then
  log "cannot read prober state (VM unreachable, or it has never run) — doing nothing"
  exit 0
fi

state_parser="$(cat <<'PY'
import json, os, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    sys.exit(0)                      # unparseable == unknown == do nothing
platforms = data.get("platforms")
if not isinstance(platforms, dict):
    sys.exit(0)
# THE ALLOWLIST IS A TRUST BOUNDARY, not tidiness.
#
# This JSON comes from the VM. Every name in it flows into
# `exec refresh-cookies.sh $stale`, which builds an executable path from it
# ("$here/exporters/$platform.sh") and runs it. Without this intersection a
# compromised VM could emit "../../.local/share/evil" and make THIS machine run
# an arbitrary *.sh, or emit an option-like "--force" that changes what the
# downstream script does. That turns the accepted risk (VM compromise = the
# cookies it holds are burned) into code execution on the owner's desktop —
# the exact boundary the pull-not-push and gpg-to-VM-only design exists to
# hold. Anything the operator did not list in PLATFORMS is simply not a name
# this side will act on.
allowed = set(os.environ.get("ARIES_ALLOWED_PLATFORMS", "").split())
# ONLY "stale" acts. "unknown" (timeout, missing binary, platform not reported)
# must never trigger a re-mint: re-minting on unknown means every VM hiccup
# burns a fresh login on a throwaway account, which is exactly the behaviour
# that gets throwaway accounts suspended.
selected = sorted(
    name for name, entry in platforms.items()
    if isinstance(entry, dict)
    and str(entry.get("status", "")).lower() == "stale"
    and name in allowed
)
ignored = sorted(
    name for name, entry in platforms.items()
    if isinstance(entry, dict)
    and str(entry.get("status", "")).lower() == "stale"
    and name not in allowed
)
if ignored:
    # Loud on stderr, never acted on: an unexpected name here is either a
    # config drift (PLATFORMS out of sync with the VM) or an attack.
    print(f"IGNORED un-allowlisted platform name(s) from the VM: {', '.join(ignored)}",
          file=sys.stderr)
print(" ".join(selected))
PY
)"
stale="$(printf '%s' "$state" | ARIES_ALLOWED_PLATFORMS="$PLATFORMS" python3 -c "$state_parser")"
unset state_parser

if [ -z "${stale// /}" ]; then
  log "no stale sessions"
  exit 0
fi

log "stale: $stale"
if [ "$mode" = "--check" ]; then
  exit 0
fi

# refresh-cookies.sh re-mints the named platforms, then ships a FULL snapshot
# (the VM install replaces the store wholesale — a partial push would drop the
# healthy sessions).
exec "$here/refresh-cookies.sh" $stale
