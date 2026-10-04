# Isolated three-worker component verifier

This is a source-specific executable mapping for synthetic worker checks, not a
production phase verifier or a restored-copy acceptance receipt. Run
`scripts/release/verify-worker-fixture.ts` from the selected image's `/app` root
with `node --import tsx`. The runner image already contains scripts, backend,
lib, packages, app and tsx; no test-only application hooks or dependencies added.

## Containment and input contract

Dora's host orchestration must independently verify the selected image digest,
full OCI revision and retained merge ancestry. Supplied SHA/digest environment
values are only labels: the executable deliberately emits
`imageIdentityVerified:false`, not an image identity claim.

Use the previously reviewed private Docker **and private containerd** arrangement
in a network namespace without IPv4/IPv6 default routes, loopback up, internal
bridge only. No production socket, ports, volumes, provider credentials or
external peers. The executable checks default-route absence, but does not prove
namespace provenance, absence of extra specific routes, mounts or peer identity;
those are host assertions required before launch. It is NOT safe to run merely
because an environment variable or database name says fixture.

Create an independent, schema-only companion database from the isolated restored
copy's schema. Never point this executable at the restored private-row database:
worker sweeps operate across all rows. Do not run candidate init-db against the
companion as a repair: a missing/old constraint/table must remain a failed check.
Any known static seed rows must be excluded during companion preparation, not
removed by this verifier. All public tables must be empty before execution.
Dora owns schema-copy preparation; this code card copies no production data.

Use a fresh database name `aries_release_fixture_<16 lowercase hex digits>` and
set its database comment to `aries synthetic release fixture v1`. Supply an
explicit task-only Unix PG socket and role through DB_HOST/DB_USER. Only a
disposable socket bind is permitted if this runs in a container. This differs
from the no-mount structural CLI fixture: do NOT add mounts to `--rehearsal` or
connect it to the production socket. Use a separate bounded component invocation.
The marker/name/empty-table checks prevent accidental reuse, not hostile forgery.

Start with an empty environment (`env -i`), minimal PATH/HOME/TMPDIR and:

- DB_HOST: absolute fixture-only Unix socket directory
- DB_PORT: fixture PG port (default 5432)
- DB_USER and DB_NAME: explicit disposable fixture role/database
- DOTENV_CONFIG_PATH: absolute nonexistent file, preventing implicit `.env` reads
- ARIES_RELEASE_FIXTURE_SHA: supplied full lowercase 40-character source SHA
- ARIES_RELEASE_FIXTURE_DIGEST: supplied immutable `sha256:<64 lowercase hex>`

No DB_PASSWORD, provider key, inherited application config or production secret
is needed. The task PG socket must use its own local trust policy and stay inside
isolation. APP_BASE_URL and INTERNAL_API_SECRET are generated/replaced in-process
for the loopback synthetic sinks, not taken from production. The executable is
bounded by 120 seconds, PG statements by 10 seconds and sink requests by 5 seconds.
Dora must still bound the entire invocation externally and verify stopped state.

## Real code and exact substitutions

| Component | Real code/DB behavior | Explicit synthetic substitution |
| --- | --- | --- |
| scheduled | runWorkerReadinessCheck, tick, real claims/attempts, terminal writes, canonical publication, ambiguous sweep | loopback scheduled-dispatch GET/POST sink; not the actual app route/provider fence |
| insights | connected-account projection, syncAccountForTenant persistence, tickSafe fan-out/stranded-run sweep | injected InsightsAdapter; fetchAccountMetrics uses a real loopback HTTP sink; post/comment lists empty |
| weekly | ensureClaimsTable, tick, real daily claim/marker SQL, triggerWeeklyJobForTenant profile/dedup helper | injected worker fetch calls helper directly; startJob posts to loopback HTTP 202 sink; not orchestrator/Hermes adapter |

Synthetic IDs are allocated by INSERT RETURNING from the empty companion; no
private tenant IDs, accounts, due slots or credentials are guessed. A single
Facebook connection has explicit fixture-user/fixture-connection/fixture-page
identifiers. The bridge uses COMPOSIO_ENABLED=true and ANALYTICS_PROVIDER=composio
only in its injected environment, with config:null; no external ID resolution.
The weekly slot is today's UTC weekday, hour 0, with last timestamps initially
null. Publishing admission remains at the source's default-off gate.

The executable asserts:

1. Scheduled schema/protocol readiness before any tick; one successful dispatch
   persisted as canonical published; second tick emits no publish; a stale
   provider-started attempt with missing durable child success becomes
   manual_reconciliation, without another provider request.
2. One connected account projected; successful sync stores followers=17;
   injected HTTP503 produces persisted partial status; a stale running sync is
   persisted failed by the real worker sweep and a later sync succeeds.
3. Claims table exists before worker code can provision it; one due slot is
   claimed and one HTTP202 synthetic submission returns without completion
   polling; the next same-slot tick claims nothing; helper duplicate lookup
   causes no second submission; no claim marker remains.
4. Public relation/column/default/constraint/index/trigger metadata fingerprint
   equals before/after. The existing weekly startup issues CREATE TABLE IF NOT
   EXISTS even with an existing table; this check proves **no schema change**, not
   absence of a DDL statement or non-owner startup compatibility.

A failed assertion or schema mismatch exits 1 and emits no success receipt.
Success emits one final JSON receipt with timestamps, verifier source SHA256,
network namespace, supplied candidate labels, schema hashes and aggregate counts.
Discard the companion after evidence capture: synthetic rows intentionally remain
for isolated inspection; this executable never drops/restores a database.

## Evidence limits and remaining release obligations

`status:synthetic_components_passed`, `deployed:false`, `rolloutAccepted:false`
is mandatory. Never wire this command into replacement phases quiesced, appReady
or accepted as the canonical verifier. It does not test real app route auth,
actual provider adapters, Hermes execution-port protocol/callbacks, private-row
or asset compatibility, standing-process startup, namespace containment/drain or
claim reconciliation. The POST202 sink is **not an actual Hermes submission**.
The schema hash is a bounded catalog comparison, not a complete pg_dump diff.

Canonical reviewer t_422e831a must review this mapping/executable before Dora
runs it in the selected isolated image against the restored schema companion.
Dora separately supplies reviewed host isolation/checkpoint and real app/schema,
three-worker startup, provider/Hermes protocol and callback verification against
the egress-disabled restored copy. All rollout/QA children remain held until
those checks and the fresh release checkpoint/canonical acceptance pass.

Local development proof uses a disposable PG16 cluster initialized from current
repo schema, then emptied, and WSL network namespace without default routes.
That proves the executable's component assertions, NOT restored-schema
compatibility, a published image, or release acceptance. Test-only supplied digest
labels in local receipts are not registry evidence.
