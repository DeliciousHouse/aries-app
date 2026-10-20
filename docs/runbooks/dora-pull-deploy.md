# Dora pull deploy (master -> production)

Owner-authorized on 2026-10-20: every master commit whose `full-suite`
check passes ships to https://aries.deliciouswines.org without a manual release.

Implementation is not yet installation-ready. PR #1123 remains closed pending
the full containment/reconciliation contract and operational rehearsal. Current
source still lacks authoritative all-worker/runtime acceptance; do not enable
the timer from this intermediate revision. Health and synthetic component tests
are not release acceptance.

1. `Tests` passes on a master push. `publish-master-image.yml` then pushes
   `ghcr.io/delicioushouse/aries-app:sha-<full SHA>` with the matching OCI revision label.
2. Every 10 minutes the user timer `aries-deploy.timer` on ubuntu-docker runs
   `scripts/release/dora_pull_deploy.py`. It deploys only when all of these hold:
   - master is ahead of the running revision, which it reads from the running image's label;
   - its own newest full-suite check succeeded;
   - the image is published;
   - the compare diff touches no `migrations/` or `scripts/init-db.js` file and adds or
     removes no DDL in code outside `tests/`.
3. When those hold, the controller:
   - writes a `pg_dump` of `aries_snapshot`, verified with `pg_restore --list` (the last
     5 are kept in `~/backups-aries/auto-*.dump`);
   - runs `ubuntu-docker-replace.mjs --execute`, with `dora_deploy_verifier.py` as the
     verifier. Its phases:
     - quiesced: refuses the swap while `assert-no-unresolved-scheduled-claims.mjs` reports any
       in-flight or unknown-outcome publish.
     - appReady: binds the new app container to the exact candidate image ID and OCI revision.
     - accepted: binds all four services the same way, then requires root, DB and Hermes
       health, `ARIES_SCHEDULED_POSTS_READINESS_CHECK=1` and no unresolved claims.
4. A failed or interrupted swap leaves its transaction unresolved. Keep the journal,
   plan and originals. Never restart old images, restore production data or mark
   deployed from HTTP health/schema regex. The replacement tool owns candidate
   stop/readback; uncertain identities or stop outcomes require forward recovery
   under the retained host fence. No incidental retained-container deletion.

Not covered: durable outside-container ingress/egress containment. Code must not guess
production firewall controls (replacement runbook). Workers drain on SIGTERM during the
stop budget. Insights and weekly now await their active cycle before closing the
pool, reject new cycles while stopping, and exit nonzero on drain timeout. This
process-local drain is not authoritative reconciliation or a host fence. Weekly
startup checks pre-existing claims columns/constraints without DDL. Strict local
execution-run inventory refuses missing/corrupt records and age-truncated scans;
it cannot recover remotely pruned history or prove provider outcomes.

The marketing port now persists the original submission key, exact wire-body
SHA256 and endpoint/key-epoch hash before POST. These are local bindings, NOT the
native Hermes fingerprint or authenticated profile/history proof. Missing legacy
identity stays unknown; same-record redispatch is refused. All transports converge
on the existing callback handler, which persists pending/applying before effects
and unknown afterward. A crash/interrupted write is unresolved, not replayable.
HTTP accepted, event_ids and native terminal state do not mean delivered. There
is no delivered transition until per-effect reconciliation exists. Strict inventory
also refuses leftover temporary writes and active locks.

The route execution provider also persists its new run's original identity before
dispatch, using the existing Aries run ID as its native idempotency header. This
checkpoint also records direct comment classification, brand-kit enrichment,
posting-time advisor and feedback-severity submissions through
`backend/execution/direct-hermes-submission.ts`. The original ID, exact wire hash
and local gateway/key binding are durable before POST. Lost replies remain unknown.
Reusing that original ID refuses unknown outcomes or returns its already-bound
native ID without POST. A new invocation is a new admission; equal prompt text
is not identity, and these consumers do not yet carry durable retry identity
across separate invocations. Polling and downstream result application are not
per-effect acceptance. Native admission/history still require runtime authority.

`callback_receipts.effects` now includes approval intent: explicit approval ID and
expected-record SHA256, persisted before writing the approval store. The exported
`reconcileHermesMarketingCallbackReceipt` beside the marketing callback reads that
exact approval, checks tenant/job/native receipt binding and digest, and returns
effect outcomes without writing or replaying the callback. Missing legacy intent,
changed records and unsupported targets remain unknown. The actual callback carries
its receipt through nested async writers with Node AsyncLocalStorage. Asset ingestion
records checksum intent before SQL and captures its returned row ID; all three post
synthesis paths record exact idempotency keys and field digests before SQL; the shared
schedule writer records the post, platforms and exact slot before mutation. The
Hermes execution port records child Aries identity before dispatch. Readback queries
are tenant/job-scoped, bounded to detect duplicate rows, and never replay. Child
readback joins its local accepted submission binding, not authenticated native history
or child completion. Caller-invented effects cannot substitute for persisted intent.
This does not yet prove complete effect enumeration, durable media bytes, runtime
document/projection state, direct-consumer retry lineage, Slack/Honcho/provider outcomes
or reel recovery. The class-level unresolved entries deliberately remain; individual
row proofs never yield `delivered`. Crash-before/after-write
tests exercise the actual handler, not a replacement delivery endpoint. Do not
install this checkpoint or release the existing rehearsal/reviewer gates.

Deferred Slack approval notifications and Honcho approval/publish/schedule/performance
writes persist target/key/input-digest intent before the first await or setImmediate.
Enabled dispatch remains unknown even if a local dedup row exists: that row is not
exact remote payload/delivery proof. Disabled dispatch records not_applicable before
returning, and readback preserves only that exact stored decision, never today's flags.
Receipt persistence failure prevents dispatch. No message bodies or credentials are
stored in these intents. Class-level unknowns still prevent whole-callback acceptance;
these changes neither establish exclusive ingress nor release host/runtime holds.

Schema changes are refused: the controller writes `~/.local/share/aries-deploy/blocked`,
and the unit fails. Resolve the compatibility boundary through the existing operations lane;
this is not permission for a manual release or a production-data restore
(`apply-schema-with-worker-restore.sh` and the replacement runbook).

## Install or upgrade (from a reviewed master commit, on ubuntu-docker)

    git -C ~/aries-deploy-src fetch origin master && git -C ~/aries-deploy-src checkout --detach origin/master
    install -d -m 700 ~/.local/lib/aries-deploy
    cp ~/aries-deploy-src/scripts/release/{dora_pull_deploy.py,dora_deploy_verifier.py,ubuntu-docker-replace.mjs,ubuntu-docker-preflight.mjs} ~/.local/lib/aries-deploy/
    chmod 700 ~/.local/lib/aries-deploy/*.py
    cp ~/aries-deploy-src/scripts/release/systemd/aries-deploy.{service,timer} ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now aries-deploy.timer

## Operate

    python3 ~/.local/lib/aries-deploy/dora_pull_deploy.py --status    # production vs master
    python3 ~/.local/lib/aries-deploy/dora_pull_deploy.py --dry-run   # all gates, no swap
    journalctl --user -u aries-deploy.service -n 20
    systemctl --user disable --now aries-deploy.timer                 # pause auto-deploy
