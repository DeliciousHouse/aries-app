#!/usr/bin/env bash
# Assemble the FULL Agent-Reach cookie store from the local staging dir,
# encrypt it to the VM-only gpg key, and scp it into the VM drop-box.
#
#   ./refresh-cookies.sh                 # ship whatever is staged
#   ./refresh-cookies.sh instagram x     # re-mint those first, then ship
#
# WHY A FULL SNAPSHOT, ALWAYS: the VM ingest REPLACES ~/.agent-reach/config.yaml
# with what arrives (merging YAML without a guaranteed parser is how credential
# stores get silently corrupted). A partial payload therefore drops the sessions
# it omits. So every push carries every platform in $PLATFORMS.
#
# WHAT NEVER HAPPENS HERE: no cookie is written outside $STAGING_DIR (0700) and
# the browser profile; no plaintext store leaves this machine; nothing is sent
# over Telegram, email, or any channel but scp-over-tailnet.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$here/config.env"

: "${STAGING_DIR:?}" "${PLATFORMS:?}" "${GPG_RECIPIENT:?}" "${VM_SSH_TARGET:?}" "${VM_INBOX:?}"

mkdir -p "$STAGING_DIR"; chmod 700 "$STAGING_DIR"
umask 077

log() { printf '%s refresh: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ── 1. Re-mint the platforms named on the command line ─────────────────────
#
# An exporter is a small per-platform script that drives the dedicated browser
# profile (or reads its cookie jar) and writes $STAGING_DIR/<platform>.yaml.
# There is no generic one: each platform's login and export differ, and a
# half-working generic exporter would fail silently. Without an exporter the
# script stops and tells you exactly what to do by hand — which is the honest
# behaviour for a step that must not be guessed at.
for platform in "$@"; do
  exporter="$here/exporters/$platform.sh"
  if [ -x "$exporter" ]; then
    log "re-minting $platform via exporters/$platform.sh"
    "$exporter"
  else
    cat >&2 <<EOF

  MANUAL STEP — $platform has no exporter at $exporter

  1. Open the dedicated browser profile:
       chromium --user-data-dir="${BROWSER_PROFILE:-$HOME/.config/chromium-aries-throwaway}"
  2. Log in as the throwaway account. Credentials, printed to this terminal only:
       $here/bw-fetch-creds.sh $platform
  3. Export its cookies with Cookie-Editor and save them as:
       $STAGING_DIR/$platform.yaml
     …in the same key shape the VM store uses (see the VM's own
     ~/.agent-reach/config.yaml, or ops/agent-reach/fixtures/*.placeholder.yaml
     for the shape — the twitter keys there are the documented ones, the rest
     are illustrative until you confirm them with \`agent-reach configure\`).
  4. Re-run this script.

EOF
    exit 5
  fi
done

# ── 2. Assemble the full snapshot ──────────────────────────────────────────
staged=0
missing=""
tmp="$(mktemp "${TMPDIR:-/tmp}/aries-store.XXXXXX.yaml")"
chmod 600 "$tmp"
trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"' EXIT

for platform in $PLATFORMS; do
  fragment="$STAGING_DIR/$platform.yaml"
  if [ -s "$fragment" ]; then
    cat "$fragment" >> "$tmp"
    printf '\n' >> "$tmp"
    staged=$((staged + 1))
  else
    missing="$missing $platform"
  fi
done

[ "$staged" -gt 0 ] || { log "nothing staged in $STAGING_DIR — refusing to ship an empty store"; exit 6; }
if grep -q 'PLACEHOLDER_NEVER_REAL' "$tmp"; then
  log "staged fragments still contain PLACEHOLDER_NEVER_REAL — the VM would reject this. Fix them."
  exit 7
fi
[ -z "$missing" ] || log "WARNING: no fragment for:$missing — the VM install will DROP those sessions"

# ── 3. Encrypt to the VM-only key, then ship ───────────────────────────────
blob="$(mktemp "${TMPDIR:-/tmp}/aries-store.XXXXXX.yaml.gpg")"
chmod 600 "$blob"
trap 'shred -u "$tmp" "$blob" 2>/dev/null || rm -f "$tmp" "$blob"' EXIT

gpg --batch --yes --trust-model always \
    --recipient "$GPG_RECIPIENT" --output "$blob" --encrypt "$tmp"

remote_name="cookies-$(date -u +%Y%m%dT%H%M%SZ).yaml.gpg"
# scp over Tailscale SSH: WireGuard in transit, tailnet ACL + SSH key for auth.
# -p preserves the 0600 mode; the ingest rejects anything group/world-readable.
scp -p "$blob" "$VM_SSH_TARGET:$VM_INBOX/$remote_name"
log "shipped $remote_name ($staged/$(echo "$PLATFORMS" | wc -w) platforms) to $VM_SSH_TARGET:$VM_INBOX"

# ── 4. Taildrop fallback, if scp is unavailable ────────────────────────────
# tailscale file cp "$blob" "<vm>:"      # then the VM must run `tailscale file get`
#                                        # (set ARINGEST_TAILDROP=1 there — files
#                                        #  do NOT land at an arbitrary path)
