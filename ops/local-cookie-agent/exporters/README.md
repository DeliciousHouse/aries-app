# exporters/ — one optional script per platform

`refresh-cookies.sh <platform>` runs `exporters/<platform>.sh` when it exists
and is executable. If it does not exist, the script stops and prints the manual
steps instead of guessing. That is deliberate: each platform's login flow and
cookie export differ, and a generic exporter that half-works would fail
silently and ship a stale or empty fragment.

## Contract

An exporter:

1. takes **no arguments**;
2. may call `../bw-fetch-creds.sh <platform>` to get the throwaway credentials
   (consume them on a pipe — never write them to disk, never pass them in argv);
3. drives the dedicated browser profile (`$BROWSER_PROFILE`) to a logged-in
   state;
4. writes `"$STAGING_DIR/<platform>.yaml"` with mode **0600**, containing that
   platform's section of the Agent-Reach store;
5. exits non-zero if it could not produce a **valid, non-empty** fragment.

Never `echo` a cookie value to stdout: `refresh-cookies.sh`'s output goes to a
cron log.

## Getting the key shape right

Only Twitter/X's field names are documented upstream (`auth_token`, `ct0`).
Reddit / Instagram / Facebook are "browser login state" with unpublished key
names, so the shapes in `ops/agent-reach/fixtures/agent-reach-config.placeholder.yaml`
are **illustrative** for those three.

The reliable way to learn the real shape: run `agent-reach configure <platform>`
once **on the VM**, let it write `~/.agent-reach/config.yaml`, and copy that
structure here. The VM ingest validates structurally (parses, has a tracked
top-level platform key, non-empty values, no placeholders) precisely so that an
unverified-but-correct field name is never rejected.

## Skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$here/config.env"
umask 077

# creds="$("$here/bw-fetch-creds.sh" instagram)"   # consume, never persist

# … drive $BROWSER_PROFILE to a logged-in state, then export the cookie jar …

out="$STAGING_DIR/instagram.yaml"
tmp="$(mktemp)"; chmod 600 "$tmp"
{
  echo "instagram:"
  echo "  sessionid: $SESSIONID"
} > "$tmp"
mv "$tmp" "$out"          # atomic; a half-written fragment must never be shipped
```
