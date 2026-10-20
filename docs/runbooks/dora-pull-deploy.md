# Dora pull deploy (master -> production)

Owner-authorized on 2026-10-20: every master commit whose `full-suite`
check passes ships to https://aries.deliciouswines.org without a manual release.

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
4. If the swap fails, the candidates are stopped and renamed `*-failed-<sha>`, and the
   retained originals are restored and health-checked. That SHA is then skipped until
   master moves.

Not covered: durable outside-container ingress/egress containment. Code must not guess
production firewall controls (replacement runbook). Workers drain on SIGTERM during the
120 s stop.

Schema changes are refused: the controller writes `~/.local/share/aries-deploy/blocked`,
the unit fails, and an operator must migrate and deploy by hand
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
