# Tier 2 Honcho and Agent-Reach runbook

This runbook deploys and verifies the two Growth Loop Tier 2 additions:

1. a tenant-scoped Honcho brand profile that compounds approved decisions and measured post performance; and
2. optional Agent-Reach enrichment for the weekly research stage, using read-only throwaway-account cookie sessions.

The repository does not install Agent-Reach, create credentials, change crontabs, restart gateways, or enable production flags. Those are explicit operator actions.

## Contracts and owners

| Contract | Source of truth |
|---|---|
| Honcho environment, tenant isolation, read/write flow | `docs/honcho-integration.md` |
| VM cookie ingest, probe, and Agent-Reach install | `ops/agent-reach/README.md` |
| Local residential-IP refresh bundle | `ops/local-cookie-agent/README.md` |
| External pipeline and cookie-session monitor | `ops/README-aries-pipeline-monitor.md` |
| Research-profile skill contract | `ops/agent-reach/skill/SKILL.md` |

Agent-Reach does not introduce a second alert owner. `COOKIE_STALE` is added to the existing `aries-pipeline-monitor`; the prober only writes state, and the monitor only reads that state and alerts.

## Claims trace

| Claim | Executable path or evidence |
|---|---|
| Tenant isolation | `TenantMemoryClient` derives `aries-tenant-<hmac32>` from the tenant id and rejects any workspace outside that namespace. |
| Honcho read loop | `loadBrandProfileContext` concurrently queries `peer-brand` and `peer-policy`; `backend/marketing/ports/hermes.ts` injects the bounded `Brand memory` block into weekly research and strategy only. |
| Honcho write loop | `aries-honcho-performance-worker` selects due 24h/7d/28d observations, scrubs the payload, appends prose to `peer-brand`, and records the horizon ledger. |
| Idempotency and crash recovery | `memory_write_claim_leases` holds mutable one-hour operational leases. Successful writes append a key to `honcho_write_idempotency_keys`; no `honcho_*` row is updated or deleted. |
| Agent-Reach transfer | The desktop encrypts the complete cookie store to the VM-only GPG key, copies the ciphertext over Tailscale SSH, and atomically renames the completed upload. |
| Credential handling | Throwaway credentials are read from Bitwarden and passed to exporters on stdin, never argv. The VM receives cookies, never account passwords. |
| Store permissions | Local staging, VM inbox, state directories, and installed cookie store are checked as `0700` directories and `0600` files. |
| Redaction | The prober redacts `detail` before writing state; `aries-pipeline-monitor.py` redacts again before Telegram. Raw cookies, headers, tokens, and passwords are forbidden in alerts. |
| Stale-session automation | Prober state `stale` produces `COOKIE_STALE`; the desktop pulls the level-triggered state, refreshes, encrypts, and ships; the next fresh probe produces the monitor's resolved indicator. |
| Research degradation | `/agent-reach` returns `session_stale` without retrying. Weekly research falls back to `/last30days` and `web_search`; non-weekly/default-gateway prompts never advertise the skill. |

## 1. Pre-deploy checks

From the repository root:

```bash
npx tsx --test --test-concurrency=1 \
  tests/memory/perf-insights-read.test.ts \
  tests/memory/perf-insights-payload.test.ts \
  tests/memory/honcho-performance-worker.test.ts \
  tests/memory-brand-profile-context.test.ts \
  tests/hermes-port-brand-context.test.ts \
  tests/memory-write-events.test.ts \
  tests/prd-invariants/inv-10-memory-curated-append-only.test.ts \
  tests/marketing/agent-reach-research-policy.test.ts \
  tests/local-cookie-agent.test.ts

python3 ops/agent-reach/cookie-prober.py --self-test
python3 ops/agent-reach/cookie-ingest.py --self-test
python3 ops/aries-pipeline-monitor.py --self-test

bash -n ops/local-cookie-agent/bw-fetch-creds.sh \
  ops/local-cookie-agent/refresh-cookies.sh \
  ops/local-cookie-agent/pull-and-refresh.sh
```

Do not proceed if any security self-test or append-only invariant fails.

## 2. Deploy the app and schema dark

Set the production secrets and gates through the existing deployment secret store, not in the repository:

```text
HONCHO_ENABLED=true
HONCHO_BASE_URL=<honcho-v3-base-url>
HONCHO_CONTROL_PLANE_JWT=<control-plane-token>
HONCHO_DATA_PLANE_JWT=<data-plane-token>
ARIES_TENANT_PSEUDONYM_SALT=<stable-environment-secret-at-least-16-chars>
HONCHO_WRITE_APPROVALS_ENABLED=true
HONCHO_WRITE_PUBLISH_ENABLED=true
HONCHO_WRITE_PREFERENCES_ENABLED=true
ARIES_HONCHO_BRAND_CONTEXT_ENABLED=
```

Keep `ARIES_HONCHO_BRAND_CONTEXT_ENABLED` blank/off during the write soak. The app and `aries-honcho-performance-worker` fail open if Honcho is unavailable.

`ARIES_INSIGHTS_513_TABLES_PRESENT` is a kill switch, not an enable flag. Its default is on. Set it to `0` only to stop the performance read model from touching the insights tables.

Deploy through the normal app process. Startup `scripts/init-db.js` must create or retain:

```text
honcho_write_idempotency_keys
memory_write_claim_leases
honcho_perf_writes
```

Confirm the worker is running from the deployed compose definition:

```bash
docker compose ps aries-honcho-performance-worker
docker compose logs --tail=100 aries-honcho-performance-worker
```

Expected: no missing-table errors, no authentication errors, and no repeated failed outcome for the same due observation.

## 3. Verify the Honcho write leg before enabling reads

Use a non-production test tenant or one explicitly approved tenant.

1. Publish a test post through the normal Aries flow.
2. Wait until an observation is due, or run the worker once in the approved test environment.
3. Compute the tenant workspace id using the command in `docs/honcho-integration.md`.
4. List the workspace sessions and inspect `session-performance-<jobId>` through the Honcho v3 API.
5. Confirm the message is plain prose on `peer-brand`, includes an HTTPS source, contains no platform post id or token-like value, and identifies the correct 24h/7d/28d horizon.
6. Run the worker again. Confirm the same horizon is not appended twice.
7. Confirm the matching row exists in `honcho_perf_writes` and a completion key exists in `honcho_write_idempotency_keys`.

If a write fails, the observation must remain due. An in-flight lease is not a successful write and must never be permanently ledgered as one.

## 4. Install Agent-Reach on the VM

Review the pinned upstream commit and supply-chain notes in `ops/agent-reach/README.md` before installation. Never replace the pinned archive SHA with a floating branch.

As the VM service user:

```bash
REPO=<deployed-aries-app-path>
AGENT_REACH_SHA=1221ecd0c3e0502ee37406f03543bedf7503f2c7

pipx install "https://github.com/Panniantong/Agent-Reach/archive/$AGENT_REACH_SHA.zip"
agent-reach install --env=auto --channels=twitter,reddit,instagram,facebook
agent-reach doctor

mkdir -p ~/.agent-reach-inbox ~/.agent-reach ~/.local/state/agent-reach-prober
chmod 700 ~/.agent-reach-inbox ~/.agent-reach ~/.local/state/agent-reach-prober
ln -sfn "$REPO/ops/agent-reach/cookie-prober.py" ~/.agent-reach/cookie-prober.py
```

Create a VM-only GPG recipient exactly as described in `ops/agent-reach/README.md`; export only its public key to the desktop. The private key never leaves the VM.

Install the skill only into the dedicated research profile:

```bash
mkdir -p ~/.hermes/profiles/aries-research/skills/social-media/agent-reach
cp "$REPO/ops/agent-reach/skill/SKILL.md" \
  ~/.hermes/profiles/aries-research/skills/social-media/agent-reach/SKILL.md
python3 ~/.agent-reach/cookie-prober.py --status
```

Restart only the `aries-research` gateway on port 8651, in a maintenance window. Do not install the skill into the default, strategist, or content-generator profiles.

Install the two VM jobs as the service user, using the deployed absolute repository path:

```cron
*/10 * * * * /usr/bin/python3 <repo>/ops/agent-reach/cookie-ingest.py --cron >> /home/node/.local/state/agent-reach-prober/ingest.log 2>&1
17 */4 * * * /usr/bin/python3 <repo>/ops/agent-reach/cookie-prober.py --cron >> /home/node/.local/state/agent-reach-prober/prober.log 2>&1
```

Do not increase the probe cadence without an explicit abuse/rate-limit review.

## 5. Configure the residential-IP desktop

Copy `ops/local-cookie-agent/` to the owner's desktop and follow its README.

Required controls:

- dedicated browser profiles and throwaway accounts only;
- one Bitwarden item per platform using the documented item names;
- Cookie-Editor or a reviewed platform exporter;
- VM public GPG key imported locally;
- local staging directory mode `0700`, fragments mode `0600`;
- full-store encryption before transfer;
- `.partial` upload followed by same-filesystem atomic rename;
- platform names intersected with the configured allowlist before any exporter path executes.

Run the local bundle syntax and security checks from section 1 before the first
live refresh. Then run `refresh-cookies.sh` interactively once. On the VM,
verify:

```bash
python3 <repo>/ops/agent-reach/cookie-ingest.py --status
stat -c '%a %n' ~/.agent-reach/config.yaml
python3 <repo>/ops/agent-reach/cookie-prober.py --cron
python3 <repo>/ops/agent-reach/cookie-prober.py --status
```

Expected store mode: `600`. All configured platforms should become `fresh`; `unknown` is not proof of a stale session.

Schedule `pull-and-refresh.sh` every six hours with the host's existing scheduler, and run a proactive full refresh weekly. The desktop pulls VM state; the VM does not open a command channel back to the desktop.

## 6. Arm the existing monitor

The monitor is external to the app so it can report app or worker failure. Run:

```bash
REPO=<deployed-aries-app-path>
python3 "$REPO/ops/aries-pipeline-monitor.py" --self-test
python3 "$REPO/ops/aries-pipeline-monitor.py" --cron --dry-run
python3 "$REPO/ops/aries-pipeline-monitor.py" --status
python3 "$REPO/ops/aries-pipeline-monitor.py" --cron
```

Then retain the existing monitor schedule from `ops/README-aries-pipeline-monitor.md`. Point `PIPEMON_COOKIE_STATE` at the prober state only if it differs from the default.

The first real run arms existing findings and must not fan out historical failures. A cookie alert may contain platform and age only. If message output includes cookie material, a token, an authorization header, or a password, disable the monitor and treat it as a security incident.

## 7. End-to-end acceptance

1. Run a weekly research stage on the dedicated research gateway.
2. Confirm its prompt includes both mandatory `/last30days` guidance and optional `/agent-reach` guidance, while a default-gateway `marketing_pipeline` prompt contains no Agent-Reach wording.
3. Confirm fresh-session output is strict JSON and is labelled platform-native observation, not first-party measured performance.
4. Force one throwaway session stale using the safe procedure in `ops/local-cookie-agent/README.md`.
5. Confirm the skill returns `session_stale` immediately and the weekly stage degrades rather than failing or retrying.
6. Confirm the monitor reports `COOKIE_STALE` without the state's raw `detail`.
7. Run the desktop pull/refresh, ingest the encrypted replacement, and probe again.
8. Confirm the next monitor tick emits the resolved indicator.
9. Inspect one research and one strategy submission for the same tenant. With the read flag still off, neither should contain `Brand memory`.

## 8. Enable the Honcho read leg after soak

After successful writes and clean monitoring for the approved soak window:

1. Smoke-test Honcho `/chat` for both `peer-brand` and `peer-policy` in the test tenant workspace.
2. Set `ARIES_HONCHO_BRAND_CONTEXT_ENABLED=true`.
3. Restart the app workers through the normal deployment process.
4. Run one weekly workflow and confirm research and strategy receive a bounded `Brand memory` block.
5. Confirm production and publish stages do not receive the block.
6. Stop immediately if any tenant receives another tenant's facts, if the block contains instructions rather than data, or if latency exceeds the configured dialectic timeout.

## Rollback

### Honcho read rollback

Blank or set `ARIES_HONCHO_BRAND_CONTEXT_ENABLED=false`, then restart normally. Writes continue; prompts return to their byte-identical no-memory form.

### Honcho performance-write rollback

Set `HONCHO_WRITE_PUBLISH_ENABLED=false` to stop app and worker writes. If the insights schema itself is unsafe, also set `ARIES_INSIGHTS_513_TABLES_PRESENT=0`. Do not delete Honcho messages, completion keys, leases, or horizon ledger rows.

### Agent-Reach rollback

1. Remove the two Agent-Reach VM cron lines.
2. Remove the skill from the `aries-research` profile.
3. Restart only the research gateway.
4. Remove the local refresh schedule.
5. Remove cookie/state directories only after the operator confirms they are no longer needed, following `ops/agent-reach/README.md`.

The app prompt treats Agent-Reach as optional and degrades to `/last30days` plus `web_search`, so no app rollback is required.

### Monitor rollback

Remove only the `aries-pipeline-monitor` cron lines and its state directory as documented in `ops/README-aries-pipeline-monitor.md`. This does not affect app execution.
