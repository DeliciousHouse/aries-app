#!/usr/bin/env bash
# Fetch ONE throwaway account's credentials from Bitwarden, at the moment they
# are needed, and print them to stdout. Nothing is written to disk, ever.
#
#   ./bw-fetch-creds.sh instagram
#   -> username=<...>
#      password=<...>
#      totp=<...>            (only if the item has one)
#
# The caller is expected to consume this on a pipe or in a command substitution
# and let it die with the process. Do NOT redirect it to a file, do NOT echo it
# into a log, and do NOT pass it as a command-line argument to anything (argv is
# world-readable in /proc).
#
# BW_SESSION handling: if it is already exported, it is reused; otherwise this
# prompts for the master password on the TTY. That means a cron-driven refresh
# needs BW_SESSION exported by the session that scheduled it — deliberately, so
# an unattended job can never silently unlock the whole vault.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$here/config.env" ] && . "$here/config.env"
: "${BW_ITEM_PREFIX:=aries-throwaway-}"

platform="${1:?usage: bw-fetch-creds.sh <platform>}"
item="${BW_ITEM_PREFIX}${platform}"

command -v bw >/dev/null || { echo "bw (Bitwarden CLI) not installed" >&2; exit 2; }

if [ -z "${BW_SESSION:-}" ]; then
  if [ ! -t 0 ]; then
    echo "BW_SESSION is not set and there is no TTY to unlock on." >&2
    echo "Export it first:  export BW_SESSION=\$(bw unlock --raw)" >&2
    exit 3
  fi
  BW_SESSION="$(bw unlock --raw)"
  export BW_SESSION
fi

bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true

json="$(bw get item "$item" --session "$BW_SESSION" 2>/dev/null)" || {
  echo "no Bitwarden item named '$item'" >&2
  exit 4
}

python3 - "$json" <<'PY'
import json, sys
item = json.loads(sys.argv[1])
login = item.get("login") or {}
for key in ("username", "password", "totp"):
    value = login.get(key)
    if value:
        print(f"{key}={value}")
PY
