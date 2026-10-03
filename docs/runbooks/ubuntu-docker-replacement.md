# ubuntu-docker replacement release — gated operator path

Adopt the existing direct-Docker stack at https://aries.deliciouswines.org.
No Compose adoption, ingress change, runner attachment or old cutover execution.
Image preparation is not deployment. Dora owns operational rehearsal/rollout;
this code card does not authorize host changes or database migration/restoration.
Keep t_3c2cb3de -> t_1b8a9688 gated until compatibility, fresh checkpoint, exact-head
CI and canonical review acceptance exist. No premature rollout or QA release.

## Current sanitized contract

Controller-reviewed metadata discovery: 2026-10-03 09:09–09:13 UTC,
aries-replacement-prerequisites-20261003/prerequisites.md in protected local evidence.
This supersedes the September snapshot in ubuntu-docker-release.md.

- Direct-Docker ownership, not repo Compose. Historical source locator:
  /home/node/.hermes-migration-workspaces/t_a3e604b4/private-cutover-v1/run_cutover.py,
  node-owned 0700, SHA256
  26e2da67e9cf8997554afc24d8bd5a09ef2c07e5d2c53609c1758ddaa9810c73.
  This mutating cutover launcher is NOT a replacement command.
- Launcher references protected private-config/app.env under migration root.
  published.env is stale. Replacement preserves current Docker configuration in
  memory, never an env-file dump or guessed credential mapping.
- aries-a3e604b4-app: node scripts/start-runtime.mjs, /app, 1001:1001,
  2 GiB/1 CPU, restart unless-stopped; app 3000 published only at
  127.0.0.1:13000 and 192.168.1.240:13000. Existing Caddy ingress is unchanged.
- THREE RUNNING workers: aries-a3e604b4-scheduled-posts (node
  scripts/automations/scheduled-posts-worker.mjs), aries-a3e604b4-insights-sync
  (node node_modules/.bin/tsx scripts/automations/insights-sync-worker.ts),
  aries-a3e604b4-weekly-trigger (node node_modules/.bin/tsx
  scripts/automations/weekly-job-trigger-worker.ts). Each /app, 1001:1001,
  512 MiB/0.5 CPU, restart unless-stopped, no mounts or published ports.
- Four services: aries-cutover-v1, no-new-privileges, writable rootfs.
  App RW/rprivate bind is migration root/quarantine-files/aries-files/aries-data
  -> /data, root 1001:1001 0700. Do not add worker storage.
- PG aries-a3e604b4-pg: postgres:16.13-bookworm, named volume of the same name
  -> /var/lib/postgresql/data, production 999:999 0700, no public PG ports.
  Recovery-clone 999:1001 ownership is not production ownership.
- Observed app/worker image aries-app:dc8d384c, local ID
  sha256:9c9c70679d048d35153628cb411ec551e565f6b8dbddb55773491ad46ca1699c.
  Short dc8d384c revision is NOT full-SHA provenance or a registry release digest.
- ARIES_SKIP_DB_INIT=1; PARTNER_ATTRIBUTION_ENABLED=false;
  ARIES_HERMES_CLI_COMPAT_ENABLED=0; ARIES_RECONCILER_ENABLED=0;
  ARIES_WEEKLY_TRIGGER_ENABLED=1; ARIES_REAPER_ENABLED absent.
  App APP_BASE_URL/NEXTAUTH_URL public; workers http://aries-a3e604b4-app:3000;
  AUTH_URL public on all four. Weekly-trigger alone has DB_POOL_MAX=3.
  Preserve EVERY live setting, including enabled in-process gates; absent
  dedicated workers do not mean those gates disabled.
- Dedicated draft-expiry, hermes-gc, feedback-retry, honcho-performance,
  composio-reconciler, usage-rollup and autoheal absent: do not create them.
  Separate aries-hermes-runtime belongs to aries-hermes; do not recreate it or PG.

## Recovery evidence and merge scope

Existing t_1e93b43a receipt under host-local
/home/node/.hermes-task-workspaces/t_1e93b43a/recovery-20261002T155324Z records two
stopped network-none PG restores, aggregate/schema parity (69 tables each in
aries_snapshot/aries_rollback), valid indexes/constraints, pg_amcheck/offline
pg_checksums and 2093 restored asset hashes. Controller rechecked dump and asset
manifest hashes. This resolves historical restore evidence, NOT candidate app,
three-worker protocols, fresh quiescence or a release-boundary checkpoint.
Per-database snapshots are not atomic across databases/assets/runtime; sequence
and key reconciliation still required. No off-host/encrypted recovery or
credentials/globals/runtime-store recovery was established.

Preserve historical queued Deploy definitions and recovery-not-revert decisions.
Do not cancel/rerun/repoint them or attach a runner. The September run table is
historical, not live status. Also retain these merges or a deliberate descendant:

| PR / run | Merge SHA |
| --- | --- |
| #1055 / 36403490678 | b8ba149c3d875ec0e20b32a00eead89b6fc10f30 |
| #1073 / 36412358470 | e906c2f1a84d8361dd5d9fd1828a55be64d09134 |
| #1041 / 36418440023 | f6219275604b15c1d28ba50d264ef1ad21febf76 |
| #1074 / 36921171637 | dc8d384c1442e4ee01ebed4f022dbb8ed9ee0251 |
| #1075 / 36978429668 | 29884c0142c0351582787b39fae88ffa088f4594 |
| #1077 / 37110845482 | 722aebec6070e11788faff57ee83598a143cbb0d |
| #1064 / 37112667476 | 232958ad8bc31a1afe78ec58e7f765e461cee6e3 |
| #1070 / 37116654519 | 7e7a5ae760939d1068d50138d81cdaa0f35ab949 |
| #1079 / 37118215971 | f015c476822c9fc1e45db85e26b882e271cc472a |

Select a fresh reviewed master descendant at release. Reuse hosted release.yml:
dispatch at full SHA, verify headSha, resolve sha-<full SHA> to registry digest,
verify OCI full revision and stage by digest through authorized operations.
Manual preparation does not move latest. Replacement never pulls/builds.

## Evidence gates

Offline node scripts/release/ubuntu-docker-preflight.mjs <plan.json> requires
host ubuntu-docker, origin https://aries.deliciouswines.org, full lowercase
40-character sha, ghcr.io/delicioushouse/aries-app@sha256:<64 hex> image.
Each of six checkpoints needs matching sha/image and nonempty reviewed evidence:
launchOwnership, storageIdentity, appAndWorkerSettings, restoredCopyCompatibility,
backupAndRollback, reviewedReplacement. References are not authenticated by code;
the canonical reviewer/operator must inspect them. Offline success still means
prepared_not_deployed/deployed:false. Never use booleans or this doc as evidence.

Compatibility must prove exact candidate startup/init-db behavior, required
scheduled-dispatch cutover/schema and all THREE worker protocols in an authorized
egress-disabled restored copy. ARIES_SKIP_DB_INIT=1 avoids initialization, NOT
incompatible schema. Recovery must cover sequences/assets/in-flight claims.
Historical PG-only restore does not fill candidate compatibility or fresh checkpoint.

## Executable contract — separately authorized operations only

On ubuntu-docker with Node 24 and Docker API v1.45 support:

    node scripts/release/ubuntu-docker-replace.mjs --inventory
    node scripts/release/ubuntu-docker-replace.mjs --execute <reviewed-plan.json>

Inventory emits only four IDs/config fingerprints. Raw protected config is held
in memory, never logged/written/put on argv. Docker Unix socket is local; no SSH,
registry pull, persistent checkout, env-file mutation, schema/cutover, PG/Hermes
change or container deletion. Local single-writer lock
/home/node/.aries-replacement.lock fails closed on overlap/crash. Before manually
removing a stale lock inspect retained state; no automatic crash retry.

Additional plan fields:
- sources: exactly four current service names, each id/fingerprint from fresh
  inventory. Changed identity/config/running state refuses before replacement.
- mode: compatible_image_only; schemaChanged: false. Any required schema/protocol
  boundary means STOP and return exact incompatibility to dev-lead; this path
  deliberately cannot execute migrations or silently skip a required cutover.
- checkpointAt: ISO timestamp, at most one hour old and not future-dated. Operator
  verifies actual checkpoint consistency; timestamp alone is not proof.
- verifier: absolute path and lowercase SHA256 sha256 of a reviewed executable
  operations probe. No generic always-success probe is supplied. It must be
  rehearsed and reviewed along with exact-head CI before live execution.

Verifier is invoked without shell as <path> <phase> <sha> <image>, fixed PATH only,
exit 0 means phase accepted; all output suppressed, even on errors; 180s timeout.
Hash checked on each call. It writes sanitized timestamped receipts to protected
operations evidence. Required phases:
- quiesced: verify fresh consistent checkpoint, matching PG/Hermes/storage,
  durable ingress/write and publishing/callback egress containment; drain/reconcile
  app in-process and all three worker claims. Containment must survive recreation
  and hold through acceptance. Verify candidate compatibility/recovery and CI.
- appReady: candidate app ready against unchanged schema with preserved settings,
  old-worker-compatible protocol and publishing still denied.
- accepted: ALL THREE functional worker probes, not uptime; exact network aliases,
  unchanged PG/Hermes/storage/ingress/absent-worker inventory; no init/cutover,
  ambiguous publishing outcomes or drift; fresh health/provenance. Keep publishing
  held. A subsequent explicit operations step resumes only after reconciliation.

The command checks staged registry digest/full OCI revision, rechecks originals
after quiescence, stops workers before app, retains originals by ID, renames and
disconnects them, then creates app and workers with captured Config/HostConfig,
only image changed. Old ID aliases/dynamic IPs not copied; static endpoints or
extra networks refused. App probe runs before starting workers. Readback requires
four running image/config/host-config/network records, GET / and /api/health/db
(status ok) on loopback/LAN/public, then functional acceptance. Only then does
it emit deployed:true, exact digest/SHA/new IDs/retained IDs. Preserve receipt,
CI IDs, health times and probe evidence. Public 200 alone is never SHA proof.
No success-only or permanent-failure Deploy job is introduced.

### Full CLI isolated rehearsal

Dora's 2026-10-03 structural rehearsal exercised the exported logic, not CLI
main. Ten real-Docker trials recovered retained originals; they did NOT establish
Aries schema/worker compatibility. Use the explicit full-CLI seam on the next
disposable-daemon rehearsal, never DOCKER_HOST or a production socket proxy:

    node scripts/release/ubuntu-docker-replace.mjs --rehearsal <target.json> --inventory
    node scripts/release/ubuntu-docker-replace.mjs --rehearsal <target.json> --execute <plan.json>

target.json has absolute socket, exact daemonId from that daemon's /info, and a
random lowercase 64-hex token. Configure ONLY the disposable daemon with label
aries.replacement.rehearsal=<token> and all four fixture containers with the
same label. Keep its private mount/network namespace, distinct data/exec/socket
roots and no default route. aries-cutover-v1 must be an internal bridge; fixtures
must have no mounts, published ports or privilege and use that network mode.
Standard production sockets and symlink aliases are refused. Identity/labels,
network and fixture checks run before mutation. The single-writer lock lives
beside that socket, not in production's lock location. No live secrets/data.

This structural mode delegates health to verifier phase health instead of
fetching production loopback/LAN/public origins. The reviewed fixture verifier
must hardcode its disposable socket/targets, check / and DB health on the isolated
app via that namespace and emit no private output. Existing quiesced, appReady
and accepted phases still run. A successful receipt always has deployed:false,
status:rehearsal_passed. Do not reuse fixture receipts/verifiers for production.
Candidate restored-copy compatibility remains a separate authorized exercise;
this no-mount structural seam is not permission to attach restored/live volumes.

### Reviewable functional-verifier requirements (not a supplied acceptance probe)

There is no common non-mutating functional check for all three workers. Do not
replace this missing operations executable with uptime, an always-zero callback,
unit tests alone or the historical PG restore. Review a host-local executable
against these source-specific assertions before candidate acceptance:

- scheduled-posts: run the existing ARIES_SCHEDULED_POSTS_READINESS_CHECK=1 path
  in scripts/automations/scheduled-posts-worker.mjs. It checks schema/protocol
  constraints and authenticated GET scheduled-dispatch readiness without a tick.
  In the isolated restored copy, additionally exercise a synthetic claim/attempt,
  dispatch idempotency and ambiguous-outcome reconciliation with provider egress
  replaced by a local sink; assert no external publish or duplicate attempt.
- insights-sync: startup immediately invokes runWorkerCycle/bridgeAndTick and
  catches/logs tick failures. Exit status or a running process is NOT acceptance.
  Exercise a synthetic connected-account projection plus one synchronization
  against a local provider sink; assert persisted success/error and stranded-run
  recovery, with sanitized aggregate receipts only.
- weekly-trigger: enabled startup calls ensureClaimsTable even when app
  ARIES_SKIP_DB_INIT=1. Prove marketing_weekly_claims already exists with compatible
  constraints, and compare schema before/after; absence or DDL is a boundary,
  not compatible_image_only. Exercise a synthetic due tenant/local slot with a
  local Hermes sink; assert exactly one claim/async submission and duplicate-slot
  refusal. RUN_ONCE alone is not acceptance because tickSafe catches failures.
- quiesced must establish durable write/callback/publishing containment outside
  recreated containers and reconcile in-flight work. accepted must assert all
  three functional receipts plus unchanged schema and PG/Hermes/assets/config,
  while containment stays held. appReady must verify scheduled readiness against
  unchanged schema before any new worker starts. Bind each receipt to exact
  source/digest/SHA, isolated target, phase, timestamps and executable hash.

These requirements are reviewable design, NOT an executable verified probe.
Dora/controller must supply the bounded host-local containment/reconciliation
and synthetic-fixture mapping; code must not guess production firewall controls,
private tenant identifiers or credential consumers. Return the executable/hash
and phase receipts for canonical review before repeating candidate acceptance.

## Failure and recovery

Preflight/quiescence failure leaves Docker unchanged. Replacement failure stops
candidates, retains originals, holds publishing; failed containment needs immediate
operator intervention. No automatic old-image restart: candidate code may already
have written data despite skipped init. Never replay unknown-outcome posts.
Before a data/protocol boundary, use isolated-rehearsed recovery: contain traffic
and egress, stop/disconnect candidates, restore original names/aliases and retained
config, prove old app/worker compatibility/consistency, then resume deliberately.
Do not delete retained originals before acceptance and retention expiry. At/after
or unknown boundary, fail closed and forward-recover with proven compatible image.
Any production-data migration/restore needs charter owner approval, not this card.

Already-stopped Docker HTTP304 is accepted only for POST container stop. Every
candidate then requires exact-ID readback with State.Running=false; running,
missing, unreadable or mismatched state remains containment failure. A successful
stop response alone is not proof. Rehearse start-failure/304, restart-after-stop
and failed readback against the disposable daemon before operational acceptance.

## Exact bounded outstanding prerequisite for Dora/controller

Authorize an egress-disabled restored-copy candidate exercise; select/stage exact
digest/full SHA; exercise this command against a DISPOSABLE four-service direct-
Docker stack including weekly-trigger; establish reviewed verifier and inject
stop/create/start/health/probe failures with recovery. Return sanitized commands,
results, source/target IDs, verifier source/hash, compatibility/no-boundary verdict.
No production rollout is requested. Fresh live checkpoint is separate at release.
Keep rollout/QA gated while evidence is absent. Protected CLAUDE.md correction
remains a proposal to Q through supported interactive path; never headless write.
