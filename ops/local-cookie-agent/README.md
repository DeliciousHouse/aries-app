# local-cookie-agent — runs on operator-desktop, NOT on the VM

A portable bundle. Nothing here is installed, scheduled, or executed by this
repo or by the VM. Copy the directory to the owner's own machine and follow this
file.

Its whole job: keep `~/.agent-reach/config.yaml` on **n8n-vm** stocked with live
cookies for throwaway Instagram / X / Reddit / Facebook accounts, minted from a
residential IP in a real browser, without a human in the loop and without a
cookie ever crossing an untrusted channel.

Read `ops/agent-reach/README.md` (VM side) first — it explains the transport and
the threat model. This file is only the local half.

## PULL, not push — read this before wiring anything

The tempting design is "VM notices a stale session → signals the desktop →
desktop re-mints". Rejected, for two concrete reasons:

1. **This machine is frequently offline** (`tailscale status` on the VM: *last
   seen 3 days ago*). Staleness is a **level**, not an edge. A push delivered
   while the machine is asleep is lost and never re-delivered; a poll after it
   wakes sees the same `stale` and acts.
2. **The obvious push wiring does not actually connect.** `hermes send --to
   telegram` from the VM lands in a *chat*. `hermes webhook subscribe --script`
   here creates an *inbound HTTP route* (`/webhooks/<name>`) — it does not read
   Telegram. Wiring the two together produces something that looks coherent in a
   diagram and never fires once. If you want push, you must run a local Telegram
   **gateway** (outbound long-poll) and hook inbound messages — a different
   thing entirely.

So: **`pull-and-refresh.sh` polls the VM's prober state over the tailnet.** No
inbound port anywhere, no signal to lose, nothing to authenticate beyond the
tailnet itself.

### Schedule it with `hermes cron` (or a systemd timer)

```bash
hermes cron create agent-reach-refresh \
  --schedule "0 */6 * * *" \
  --command "$HOME/local-cookie-agent/pull-and-refresh.sh"
```

(`hermes cron create --help` for the exact flag names on your build; a plain
`crontab -e` line or a systemd timer is equally fine — the script is a normal
executable and takes no arguments.)

Also run `./refresh-cookies.sh` **proactively** once a week even when nothing is
stale. A session refreshed by normal use rarely expires; one that is only ever
touched after it dies means the pipeline runs degraded for up to 6 hours each
time.

### If this machine ever becomes always-on

Then the better design is the **tailnet webhook**: bind the local hermes gateway
to the tailnet interface and have the VM POST the stale signal to
`http://100.120.56.38:<port>/webhooks/agent-reach-refresh` with
`hermes webhook subscribe agent-reach-refresh --secret <hmac> --script refresh-trigger.sh`.
That is inbound-but-tailnet-only (WireGuard + ACL + HMAC), and it reacts in
seconds instead of hours. It is a strict upgrade to the polling loop, not a
replacement for the design — swap `pull-and-refresh.sh`'s trigger, keep
`refresh-cookies.sh` exactly as is.

## One-time setup

1. **Install:** `tailscale` (already on the tailnet), `gpg`, `bw` (Bitwarden
   CLI), `scp`, `python3`, and a Chromium/Firefox profile dedicated to the
   throwaway accounts with the **Cookie-Editor** extension.
2. **Import the VM public key** — see `gpg-setup.md`. This is the only key that
   ever moves; the VM private key never leaves the VM.
3. **Put the throwaway credentials in Bitwarden.** One item per platform, named
   `aries-throwaway-twitter`, `aries-throwaway-reddit`,
   `aries-throwaway-instagram`, `aries-throwaway-facebook`. **Never the owner's
   or the brand's real accounts** — Agent-Reach's own guidance, and the reason
   the blast radius of a suspension is "make a new burner".
4. **Create the staging dir:** `mkdir -p ~/.aries-cookies && chmod 700 ~/.aries-cookies`.
5. **Run `./refresh-cookies.sh` once by hand** and watch it. It will tell you
   what it wants for each platform.
6. Confirm on the VM: `~/.agent-reach/config.yaml` exists, is `0600`, and
   contains no `PLACEHOLDER_NEVER_REAL`.

## The files

| File | Does |
| --- | --- |
| `config.env.example` | copy to `config.env`; VM host, paths, gpg recipient, platform list |
| `bw-fetch-creds.sh` | unlocks Bitwarden and prints one platform's credentials **to stdout only** |
| `refresh-cookies.sh` | assembles the full store from the staging dir, encrypts it to the VM key, `scp`s it to the drop-box |
| `pull-and-refresh.sh` | reads the VM's prober state over the tailnet; if anything is stale, re-mints it and calls `refresh-cookies.sh` |
| `exporters/` | optional per-platform cookie exporters; without one, `refresh-cookies.sh` falls back to asking you |
| `gpg-setup.md` | the key exchange |

## Where the cookies live locally

Only two places, both `0700`/`0600`:

* the dedicated **browser profile** (the browser's own cookie jar), and
* `~/.aries-cookies/<platform>.yaml`, the staging fragment for that platform.

`refresh-cookies.sh` assembles those fragments, encrypts, ships, and never
writes an unencrypted store anywhere else. Nothing is ever pasted into a chat,
a log, a commit, or a Telegram message.

## How the hand-off avoids a half-read blob

The VM's ingest runs every 10 minutes and picks up `*.gpg`. `scp` writes under
the final name while bytes are still arriving, so a tick landing mid-transfer
would read a truncated file, fail to decrypt it, and quarantine it into
`rejected/` — losing the payload while this side logged "shipped".

So the upload is two steps: `scp` to `<name>.gpg.partial` (which the ingest's
glob does not match), then `ssh mv` into place, which is a rename on the same
filesystem and therefore atomic. An interrupted transfer leaves a `.partial`
behind; the ingest sweeps those once they are over 24 h old, so a live transfer
is never deleted out from under itself.

## What the VM is trusted for

Nothing that can run code here. `pull-and-refresh.sh` reads a JSON file the VM
writes, and platform names from it end up in an executable path
(`exporters/<platform>.sh`) — so those names are intersected with `$PLATFORMS`
from `config.env` before anything acts on them, and `refresh-cookies.sh`
independently rejects any name outside `[a-z0-9][a-z0-9_-]*`. A compromised VM
can therefore cost you the cookies it already holds; it cannot make this
machine run something of its choosing. Un-allowlisted names are reported on
stderr and ignored — if you see one, either `PLATFORMS` drifted out of sync
with the VM, or something is wrong.

## End-to-end verification

1. On the VM, force staleness: log the throwaway out in a browser, or hand-edit
   `~/.local/state/agent-reach-prober/state.json` to `"status": "stale"`.
2. `python3 ops/aries-pipeline-monitor.py --status` → the 🍪 line appears; the
   next `--cron` tick sends the Telegram alert.
3. Here: `./pull-and-refresh.sh` → sees `stale` → re-mints → pushes.
4. On the VM: `python3 ops/agent-reach/cookie-ingest.py --status` → *last
   install* is now; the inbox is empty; `rejected/` is empty.
5. `python3 ops/agent-reach/cookie-prober.py --cron` → back to `fresh`.
6. The next monitor tick sends `✅ Resolved — 🍪 Agent-Reach session stale`.

If step 4 shows a **rejected** blob, read `ingest.log`: the reason is always one
of *wrong perms*, *undecryptable* (wrong recipient key), or *failed structural
validation* (empty / placeholder / no tracked platform key).
