# agent-reach on the VM — cookie sessions, fully automated

Gives the weekly **research stage** a way to read what is actually working on
Instagram / X / Reddit / Facebook right now, using logged-in throwaway accounts,
without ever logging in from this datacenter IP and without a human pasting
cookies.

`ops/` holds host-operational tooling. Nothing in this directory is built,
imported, or executed by the app — it is not on the TypeScript path and is
outside both repo guards (`check-repo-boundary.mjs`, `check-banned-patterns.mjs`).
The single app-side change this feature needs is a prompt edit
(`WEEKLY_RESEARCH_AGENT_REACH_GUIDANCE` in `backend/marketing/ports/hermes.ts`),
which ships in the normal image build.

## The shape of the thing

```
brendan-desktop (residential IP, his browser, Bitwarden)
   │  1. bw unlock → throwaway creds → log in / refresh in a dedicated browser profile
   │  2. export cookies → assemble store → gpg --encrypt --recipient <VM key>
   │  3. scp over Tailscale SSH  ─────────────────────────┐   (WireGuard, ciphertext)
   ▼                                                      ▼
                                          n8n-vm  ~/.agent-reach-inbox/*.gpg
                                                          │
                                        cookie-ingest.py (cron, */10)
                                          perms → gpg -d → structural validate
                                                          ▼
                                              ~/.agent-reach/config.yaml (0600)
                                                          │
                                     agent-reach reads ◄──┘   (the /agent-reach skill)
                                                          │
                                        cookie-prober.py (cron, every 4 h)
                                          agent-reach doctor → fresh/stale/unknown
                                                          ▼
                              ~/.local/state/agent-reach-prober/state.json (0600)
                                        │                             │
                    aries-pipeline-monitor.py                  brendan-desktop
                    COOKIE_STALE → Telegram (operator)         pulls this file over
                                                               the tailnet and
                                                               re-mints (see below)
```

Three programs, three jobs, no shared failure:

| Program | Owns | Never does |
| --- | --- | --- |
| `cookie-prober.py` | the network probe + the state file | alert anyone, touch the store |
| `cookie-ingest.py` | decrypt + validate + install the store | any network I/O, any probe |
| `aries-pipeline-monitor.py` | the operator alert (`COOKIE_STALE`) | any network I/O, any probe |

The monitor is deliberately network-free so an alerting bug can never wedge the
pipeline; probing a social platform is network I/O that can block or rate-limit.
Hence the split, and hence the state file between them.

## Transport, and why it is this and not something else

**Hard requirement: raw cookies never transit Telegram in plaintext.** They do
not transit Telegram at all in the normal path.

| Leg | Channel | Auth | Why |
| --- | --- | --- | --- |
| Cookie payload, local → VM | `scp` over **Tailscale SSH** into `~/.agent-reach-inbox/` | tailnet device identity + ACL + SSH key | WireGuard (ChaCha20-Poly1305) in transit; **no new listening service, no new bearer token to rotate**. An authenticated HTTP receiver would re-implement authentication the tailnet already performs and add attack surface for nothing. |
| At rest, everywhere | `gpg --encrypt` to a **VM-only** key, done *before* the blob leaves the local machine | VM private key, which never leaves the VM | the file in the inbox — and any copy of it in an off-host backup — is useless to anyone but this host. |
| "Session is stale", VM → local | **nothing is pushed**; the desktop *pulls* the prober state over the tailnet | Tailscale SSH | see below. |
| Operator notification | Telegram, via the monitor | existing bot token | carries a platform name and a duration. No cookie, no token, ever — pinned by `no_secret_material_in_messages`. |
| Tailnet down (last resort) | the same **gpg blob** as a Telegram document attachment | VM private key | still ciphertext; the never-plaintext rule holds either way. |

### PULL, not push — the signalling decision

The obvious design is "VM detects stale → signals the desktop → desktop
re-mints". It was rejected:

* `tailscale status` shows **brendan-desktop offline, last seen 3 days ago**. A
  push to a machine that is off is a signal that is simply lost — and staleness
  is a *level*, not an edge, so a lost edge is never recovered.
* A Telegram message from the VM lands in a **chat**. It does not POST to
  anything. Making the local hermes react to it needs a local Telegram gateway
  long-polling; `hermes webhook subscribe --script` does **not** consume
  Telegram messages — it creates an *inbound HTTP route* `/webhooks/<name>`,
  i.e. exactly the inbound port that choosing Telegram was supposed to avoid.
  Mixing the two produces a design that reads coherent and never fires.

So: **the desktop polls.** A local `hermes cron` job (or systemd timer) reads
this VM's prober state over the tailnet and re-mints whatever is stale. Being
offline for three days costs nothing but latency — the first poll after it wakes
sees the same `stale` and acts. See `ops/local-cookie-agent/README.md`.

The tailnet-webhook alternative (local hermes bound to the tailnet interface,
VM POSTs with `--secret` HMAC) is documented there too, and is the right
upgrade **if** the desktop ever becomes always-on.

## Install (owner-actions — none of this is applied by the repo)

```bash
REPO=/home/node/openclaw-n8n-stack        # or the worktree path until this lands

# 1. Agent-Reach itself — PINNED. Read the supply-chain note below first.
AGENT_REACH_SHA=1221ecd0c3e0502ee37406f03543bedf7503f2c7   # default-branch head, 2026-08-06
pipx install "https://github.com/Panniantong/Agent-Reach/archive/$AGENT_REACH_SHA.zip"
agent-reach install --env=auto --channels=twitter,reddit,instagram,facebook
agent-reach doctor                         # confirm channels register

# 2. Paths (all 0700; the store file itself ends up 0600)
mkdir -p ~/.agent-reach-inbox && chmod 700 ~/.agent-reach-inbox
mkdir -p ~/.agent-reach       && chmod 700 ~/.agent-reach
mkdir -p ~/.local/state/agent-reach-prober && chmod 700 ~/.local/state/agent-reach-prober

# Stable path the SKILL's freshness pre-check calls (it must not hardcode $REPO —
# it gets copied into the gateway profile). Repoint this when the repo moves.
ln -sfn $REPO/ops/agent-reach/cookie-prober.py ~/.agent-reach/cookie-prober.py

# 3. The VM ingest key. READ THE PASSPHRASE WARNING BELOW FIRST.
gpg --batch --passphrase '' \
    --quick-generate-key "aries-cookie-vm <brendan3394@gmail.com>" default default never
gpg --armor --export aries-cookie-vm > /tmp/aries-cookie-vm.pub
#    copy that .pub to brendan-desktop, then: rm /tmp/aries-cookie-vm.pub
#    the PRIVATE key never leaves this VM.

# 4. Smoke-test everything (no network, no live state touched)
python3 $REPO/ops/agent-reach/cookie-prober.py --self-test
python3 $REPO/ops/agent-reach/cookie-ingest.py  --self-test
python3 $REPO/ops/aries-pipeline-monitor.py     --self-test
```

### ⚠️ Supply chain — why the install is pinned

`pipx install …/archive/main.zip` installs whatever is on that third-party
`main` branch *at the moment you run it*, onto the host that holds the cookie
store — and `agent-reach` reads that store on every invocation. One malicious
or compromised upstream push would therefore exfiltrate all four live sessions,
with no review step anywhere in the loop. Pinning the SHA does not make the code
trustworthy, but it makes it *reviewable and repeatable*: the same bytes every
install, and an upgrade becomes a deliberate act instead of a silent one.

* Before installing, skim the pinned tree — especially anything that reads
  `~/.agent-reach/config.yaml` or makes outbound requests:
  `https://github.com/Panniantong/Agent-Reach/tree/<sha>`.
* To upgrade: diff `<old-sha>…<new-sha>` on GitHub, re-read those same paths,
  then bump `AGENT_REACH_SHA` above in the same commit as the review note.
* Never replace the pin with `main.zip` "just to test something" — that is the
  whole hole, reopened.

### ⚠️ The passphrase footgun

`gpg --quick-generate-key … default default never` **without** `--batch
--passphrase ''` creates a *passphrase-protected* key. Cron has no TTY and no
pinentry, so the first automated decrypt then hangs or dies with
`Inappropriate ioctl for device`, the store silently stops being refreshed, and
the only symptom is sessions going stale for no visible reason.

Two supported setups, both exercised by `cookie-ingest.py --self-test`:

* **Recommended — unprotected key.** Create it with `--batch --passphrase ''`.
  The decrypt is then plain:
  `gpg --batch --yes --quiet --no-tty --decrypt <blob>`.
  The key is only as safe as the VM, which is also true of the cookies it
  protects, so a passphrase sitting in a file next to it buys nothing.
* **Protected key + passphrase file.** Set `ARINGEST_PASSPHRASE_FILE=/path`
  (0600) and the ingest adds `--pinentry-mode loopback --passphrase-file …`.

### Cron

`crontab -e` for user `node`, mirroring the `hermes-auth-sentinel` /
`aries-pipeline-monitor` absolute-path convention:

```cron
# agent-reach cookie plumbing (worktree path until the branch merges — then repoint)
*/10 * * * * /usr/bin/python3 <repo>/ops/agent-reach/cookie-ingest.py --cron >> /home/node/.local/state/agent-reach-prober/ingest.log 2>&1
17 */4 * * * /usr/bin/python3 <repo>/ops/agent-reach/cookie-prober.py --cron >> /home/node/.local/state/agent-reach-prober/prober.log 2>&1
```

Probe cadence is deliberately low (every 4 h). The probe reuses the same session
the reads use, so it is indistinguishable from a normal read — but volume is
itself a signal, so do not tighten it.

Point the monitor at the prober's state file by adding to its crontab line or
wrapper:

```sh
export PIPEMON_COOKIE_STATE=/home/node/.local/state/agent-reach-prober/state.json
```

(That is already the default; set it explicitly only if the state dir moves.)

### Skill install (this one touches the live pipeline)

`ops/agent-reach/skill/SKILL.md` → the **aries-research profile only**, then
restart gateway 8651 **in a maintenance window**. See the install section at the
bottom of that file.

## Configuration

`cookie-prober.py`, all `ARPROBE_*`:

| Variable | Default |
| --- | --- |
| `ARPROBE_BIN` | `~/.local/bin/agent-reach` |
| `ARPROBE_STATE` | `~/.local/state/agent-reach-prober/state.json` |
| `ARPROBE_PLATFORMS` | `twitter,reddit,instagram,facebook` |
| `ARPROBE_TIMEOUT_S` | `90` |

`cookie-ingest.py`, all `ARINGEST_*`:

| Variable | Default |
| --- | --- |
| `ARINGEST_INBOX` | `~/.agent-reach-inbox` |
| `ARINGEST_STORE` | `~/.agent-reach/config.yaml` |
| `ARINGEST_STATE` | `~/.local/state/agent-reach-prober/ingest-state.json` |
| `ARINGEST_GPG` | `gpg` |
| `ARINGEST_PASSPHRASE_FILE` | *(empty — key must be unprotected)* |
| `ARINGEST_TAILDROP` | `0` |
| `ARINGEST_PLATFORMS` | `twitter,reddit,instagram,facebook` |

`aries-pipeline-monitor.py` gains `PIPEMON_COOKIE_STATE` and
`PIPEMON_COOKIE_STATE_MAX_AGE_H` (12).

### Taildrop, if you use it instead of scp

`tailscale file cp` does **not** deliver to a path — it delivers into the
receiving node's Taildrop inbox, and the file only becomes real when someone
runs `tailscale file get`. A Taildrop push therefore looks successful on the
sending side and silently never arrives. Set `ARINGEST_TAILDROP=1` and the
ingest runs `tailscale file get --conflict=rename <inbox>` before each drain.

## What the prober actually asks

`agent-reach doctor` — Agent-Reach's own documented health surface ("checks each
channel's operational status"). `--json` is tried first and plain text is the
fallback, because the JSON shape is not published upstream.

Hand-rolled per-platform logged-in-only reads (an X self/home fetch, `rdt-cli
me`, an IG own-profile read) were rejected: they depend on CLI sub-surfaces not
verified against this tool, and they generate traffic that looks less like
normal use than `doctor` does.

Classification, with the rule that matters:

| Verdict | Meaning | Alerts? |
| --- | --- | --- |
| `fresh` | an authenticated marker | no |
| `stale` | login required / unauthenticated / expired / 401 | **yes**, via the monitor |
| `unknown` | timeout, missing binary, unparseable answer, or a platform `doctor` did not mention | **no** |

**`unknown` never alerts.** This is the same rule as the monitor's
empty-`max(started_at)` reasoning: "the session is dead" is precisely the
conclusion you cannot draw from an absence of information, and an alert nobody
can act on trains the operator to ignore the channel.

### Recalibrating the fixtures

`fixtures/doctor-*.json|txt` are **synthetic** — plausible shapes, not captures,
because upstream does not publish `doctor`'s output format. After the first real
install, capture the real thing and replace them:

```bash
agent-reach doctor --json > ops/agent-reach/fixtures/doctor-all-fresh.json   # if --json exists
agent-reach doctor        > ops/agent-reach/fixtures/doctor-text-mixed.txt
```

then re-run `--self-test`. If the parser cannot read the real shape, the suite
will show `unknown` where it expects `fresh` — which is the safe direction to
fail, and the signal to widen `_status_fields` / `_STALE_MARKERS`.

## The cookie store

Native location `~/.agent-reach/config.yaml`, mode 0600 (Agent-Reach's own
convention). `fixtures/agent-reach-config.placeholder.yaml` documents the shape
with every value set to `PLACEHOLDER_NEVER_REAL`; the ingest **refuses** to
install a payload containing that string.

Only Twitter's field names (`auth_token`, `ct0`) are documented upstream.
Reddit / Instagram / Facebook are "browser login state" with unpublished key
names — the fixture labels them illustrative. That is why `cookie-ingest.py`
validates **structurally** (parses, has a tracked top-level platform key,
non-empty leaf values, not the placeholder) and never against a guessed
per-platform schema: a schema check built on guesses would silently reject real
payloads and starve the research stage.

An install **replaces** the store wholesale. A payload carrying only Instagram
drops the other three sessions; the local generator therefore always exports a
full snapshot, the ingest logs which platforms a payload omits, and the prober
catches the loss within one cycle.

## Account hygiene, the residential-IP advantage, and what is still risky

Agent-Reach's own guidance, followed here: **throwaway accounts only** — never
the owner's or the brand's primary. Cookie-authenticated automated reads carry a
real suspension risk; that risk is priced in by making the blast radius "re-mint
a burner".

**What this architecture buys.** Every *login* happens on the owner's own
machine, in a real browser profile, from a residential IP. The VM never logs in,
never sees a password, and never touches a login form — it only receives an
already-minted session and only ever **reads**. Logging into a consumer social
platform from a cloud datacenter IP is the single loudest automation signal
there is, and this design never emits it.

**What is still risky, honestly:**

* **Session/IP binding.** The cookie is minted at a residential IP and used from
  a GCP IP. A platform that binds a session to its origin invalidates it.
  Mitigation: reads only, low cadence, and the prober notices within 4 h.
  Not eliminated.
* **Throwaway suspension.** Shows up as a *permanent* `stale`. The fix is to
  **re-mint the account**, not to refresh the cookie — a refresh loop against a
  suspended account will just re-alert forever.
* **VM compromise.** Anyone with the `node` account has the cookies. 0600 +
  gpg-at-rest for blobs limits copies-in-flight, not this.
* **Platform ToS / scraping posture.** Reads only, low cadence, throwaway
  accounts, no posting, no DMs, no follows.

## Removal

```bash
crontab -e                                   # delete the two lines
rm -rf ~/.agent-reach ~/.agent-reach-inbox ~/.local/state/agent-reach-prober
rm -rf ~/.hermes/profiles/aries-research/skills/social-media/agent-reach
```

Then restart gateway 8651. The app side needs no rollback: `/agent-reach` is
advertised as **optional** and the research stage is instructed to degrade to
`/last30days` + `web_search` when it is unavailable, so removing the skill just
stops it being used.
