# ubuntu-docker release preparation — NOT an executable deployment

Decision: adopt the existing healthy migrated Aries stack. Do not create another
Compose project, repoint ingress or replace data. This preparation PR does not
complete recovery. Keep implementation card `t_3c2cb3de` blocked until the missing
evidence and executable replacement path have been reviewed and exact-head CI
accepted; only then may its completion release Dora's `t_1b8a9688` dependency.
Dora owns the separately authorized rollout and live readback. Do not merge this
intermediate draft as if it delivered that executable path.

## Observed inventory and explicit unknowns

Sanitized operations handoff from dev-lead, 2026-09-28 06:55 UTC (a snapshot,
not continuously verified state): GET `/` and `/api/health/db` each returned 200 at
https://aries.deliciouswines.org. This is healthy ingress, not evidence that a
recent merge is live. Image revision observed:
`e5ee8b8e68a7ca89cbd43a50480983df41eeb101`.

| Surface | Observed contract |
| --- | --- |
| Ingress | Caddy LXC `192.168.1.57` routes to ubuntu-docker `192.168.1.240:13000` |
| App | `aries-a3e604b4-app`, `node scripts/start-runtime.mjs`, UID:GID `1001:1001` |
| Ports | `127.0.0.1:13000` and `192.168.1.240:13000` -> container `3000` |
| Network | `aries-cutover-v1` |
| Runtime data | Observed bind suffix `migration-workspace/quarantine-files/aries-files/aries-data` -> `/data`, RW, root `1001:1001`, mode `0700`; absolute authoritative source still needs reconciliation |
| Database | `aries-a3e604b4-pg`, database `aries_snapshot`, named volume `aries-a3e604b4-pg` -> `/var/lib/postgresql/data`; host-volume UID/GID unknown |
| Required active workers | `aries-a3e604b4-scheduled-posts` (`scheduled-posts-worker.mjs`) and `aries-a3e604b4-insights-sync` (`insights-sync-worker.ts`), same image/network; neither has mounts |
| Stopped worker | Weekly-trigger: Exited 0; retain stopped state |
| Absent workers | Draft-expiry, hermes-gc, feedback-retry, honcho-performance, composio-reconciler, usage-rollup; do not create them |
| In-process gates | `ARIES_SKIP_DB_INIT=1`, `PARTNER_ATTRIBUTION_ENABLED=false`, `ARIES_REAPER_ENABLED` unset (opt-in), `ARIES_HERMES_CLI_COMPAT_ENABLED=0`, `ARIES_RECONCILER_ENABLED=0` |
| Autoheal | Absent; do not add Docker-socket access |
| Hermes | `aries-hermes-runtime` belongs to separate `aries-hermes` project; not an app-worker substitute |

No Compose project/service ownership labels were found. The migration workspace
contains `start_private.py`, `checkpoint.py`, and an app-source Compose copy,
but **none is established as the authoritative owning launch contract**. Do not
promote that copy, infer missing service settings, or print/read private scripts,
raw container environment, credentials or data into a PR/card. Operations must
provide sanitized source ownership, absolute mount identity, per-service
non-secret settings and secret-reference mapping (never secret values).

## Why the old Deploy cannot run safely

The old workflow requires `/home/node/aries-app/.git`, which is absent on the new
host, and performs destructive checkout reset/clean, mutable `.env` writes,
schema initialization, scheduled-dispatch cutover, autoheal and broad worker
recreation. Repo Compose defaults use another port, mounts and external network.
Relabeling its runner would not migrate these contracts safely.

The workflow is moved out of `.github/workflows` into a historical regression
fixture at `tests/fixtures/retired-deploy.yml`. Helper and ordering tests remain;
they do not establish compatibility with the migrated database or containers.
There is no success-only validation Deploy job and no permanently failing Deploy
placeholder. There is currently **no executable replacement deployment job**.

Existing run definitions are immutable snapshots. Removing the workflow in this
branch does not cancel, modify or secure queued runs. Preserve them; do not attach
a runner, rerun or repoint them:

| Run | SHA | Last handoff state (not live status) |
| --- | --- | --- |
| `36382024398` | `582bb43c96e67e2f72e8e81eaa010b1c5e3c06ea` | queued on retired runner |
| `36384963344` | `4d2f76aecc3a4de55956fa320c5eb6f36293e142` (#1068) | cancelled |
| `36388172792` | `85f6b06e78f3bf08544c17f7d728f507cd924e8c` (#1067) | pending |
| `36391406900` | `fad004be338b568aa4729c8d868b8ba991b53107` (#1066) | pending, jobs=[] at 07:28 UTC |

Dev-lead's `t_f151474c` decision retains recovery, not revert, for #1066 (motion
dependency only). Root and DB GET 200 at 07:28 UTC still describe the older stack,
not proof of the #1066 image. No new incident or QA is needed for this handoff.

At release time select a fresh reviewed `master` SHA including #1068, #1067 and #1066;
never assume any of these historical run SHAs is the release target or live.

## Required checkpoints (all unresolved until supported by evidence)

1. `launchOwnership`: reconcile the source owner and launch mechanism for existing
   app, PostgreSQL and both workers. Specify how the adopted containers will be
   replaced without checkout reset, Compose-project adoption by guesswork, or
   creating duplicate services. Pin the reviewed manifest/launch source revision.
2. `storageIdentity`: verify absolute app bind, volume identity, access and PG
   UID/GID through scoped operations evidence. No chown, data copy, volume recreate
   or production DB query is authorized by this preparation change.
3. `appAndWorkerSettings`: reconcile exact per-service commands, UID/GID, ports,
   network aliases, mounts, restart/drain policy, flags, pool budgets, callback
   origins and secret references. Preserve the two active workers and every
   disabled/absent worker; justify each proposed difference individually.
4. `restoredCopyCompatibility`: inspect the exact target image's `start-runtime`,
   `init-db`, scheduled-dispatch cutover, web/worker protocols and insights sync.
   Startup initializes schema unless `ARIES_SKIP_DB_INIT=1`; this flag prevents
   initialization, **not schema incompatibility**. Use an authorized disposable
   restored test copy with isolated credentials and outbound publishing/callbacks
   denied, never production connections. Prove schema init, cutover, app readiness,
   both active workers and pre-/post-boundary failure recovery against that copy.
   Record source/target revision, digest, test commands, results and boundary.
5. `backupAndRollback`: operations must verify a consistent pre-boundary database
   and runtime-file checkpoint, restore rehearsal, retention/access and rollback
   procedure. Do not store backups or private contents in source control. Any
   production-data migration/restore requires charter-owner approval through
   dev-lead, with exact scope and checkpoint reference; no implied authorization.
6. `reviewedReplacement`: review the executable replacement implementation and
   exact-head required CI. It must fail before side effects on unknown/mismatched
   target identity or evidence, prohibit fallback to repo Compose defaults, and
   report deployment success only after actual app + both required-worker
   replacement and post-change proof. This preparation PR alone cannot supply
   this checkpoint. Runner changes require their own explicit operations scope.

## Offline evidence preflight

`node scripts/release/ubuntu-docker-preflight.mjs <sanitized-plan.json>` checks
completeness and target binding without Docker, SSH, env access or network calls.
Missing/malformed input or any missing/mismatched checkpoint exits 1. A complete
plan returns `prepared_not_deployed` and `deployed: false`, exit 0. It never
executes a deployment. It verifies evidence **references**, not their authenticity
or results; the assigned reviewer/operator must inspect each referenced record.
A green unit test or preflight cannot authorize production or clear the incident.

Plan fields:

- `host`: exactly `ubuntu-docker`
- `origin`: exactly `https://aries.deliciouswines.org`
- `sha`: full lowercase 40-character candidate commit SHA
- `image`: `ghcr.io/delicioushouse/aries-app@sha256:<64 lowercase hex>`
- `checkpoints`: all six keys above, each containing the same `sha`, same `image`,
  and nonempty `evidence` reference to a sanitized reviewed record

Do not fill missing evidence with booleans, assumptions or this document's URL.
Bind all checkpoints to the chosen candidate; re-evaluate them if SHA or digest
changes. No ready-made approval manifest is committed because the facts are absent.

## Replacement protocol for Dora — gated, not permission to run now

A. Establish launch/storage/settings identity and fresh health/image inventory,
   without changing running services. Missing identity means STOP, not a default.
B. Reuse `.github/workflows/release.yml` on GitHub-hosted runners for image
   preparation: dispatch `release.yml --ref <selected full master SHA>` via `gh
   workflow run`, then verify the run's actual `headSha` matches the selected SHA.
   Manual metadata tags are `sha-<full SHA>` (not bare `<SHA>`); they do not move
   `latest`. Resolve the published **registry digest**, verify the image revision
   label and target architecture/UID compatibility, then stage by digest only.
   Do not confuse local image ID with registry digest. No new publisher is needed.
C. Prove candidate compatibility in the isolated restored copy, then require all
   six reviewed checkpoints and a passing offline preflight before live changes.
   With authorized scope, establish the verified backup/restore checkpoint and
   approved reversible quiescence of web mutations and scheduled publishing.
   Respect in-flight worker drain and outcome-unknown claims; do not replay posts
   to prove readiness. Preserve stopped/absent worker states and the PG volume.
D. Execute only the reviewed launch path and proven schema/cutover sequence.
   Record the instant the irreversible schema/protocol boundary is crossed.
   Keep publishing stopped until target app and both required workers are proven
   compatible. Never run the archived workflow or repo Compose on the new host.
E. Require root and DB health at loopback, LAN and public origin; verify app and
   both workers' running image IDs resolve to the staged registry digest and
   source SHA. Verify worker functional readiness, not merely container uptime,
   with non-publishing probes established by the disposable-copy rehearsal.
   Recheck mounts, settings, PG identity, disabled workers and ingress unchanged.
   Switch traffic only if actually needed and included in the approved procedure.
F. Report real deployment only with replacement execution record, exact digest/SHA,
   required CI run links, health timestamps and app/worker parity proof. Publication,
   preflight, a running old image and public HTTP 200 alone are never deployment.

### Rollback boundary

Before schema/cutover boundary: on failure use the rehearsed procedure to restore
original image/container/route and, if required and explicitly approved, the
verified consistent data checkpoint. Prove old app readiness before publishing
resumes. Prefer leaving the healthy old stack untouched when preflight fails.

At or after a schema/cutover boundary (or if boundary state is unknown): fail
closed with publishing stopped. Do not restart an incompatible old app/worker and
do not claim image-only rollback. Forward-recover with the proven compatible
candidate; any data restore/migration requires owner-approved scope and evidence.

## Current completion blockers

Authoritative launch ownership; PG volume UID/GID; exact app/worker settings;
restored-copy schema/cutover compatibility; verified backup/restore checkpoint;
reviewed executable replacement with exact-head CI; and approval to correct the
stale protected `CLAUDE.md` deployment instructions. A draft preparation PR is an
intermediate artifact, not satisfaction of these requirements.
