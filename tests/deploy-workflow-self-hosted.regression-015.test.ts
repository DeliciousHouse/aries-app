import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const workflow = readFileSync(
  path.join(PROJECT_ROOT, '.github', 'workflows', 'deploy.yml'),
  'utf8',
);

const prAgentWorkflow = readFileSync(
  path.join(PROJECT_ROOT, '.github', 'workflows', 'pr-agent-autofix-automerge.yml'),
  'utf8',
);

const publishImageScript = readFileSync(
  path.join(PROJECT_ROOT, 'scripts', 'release', 'publish-image.sh'),
  'utf8',
);

// Regression: deploy workflow must run on the deploy host itself instead of SSHing into a remote VM.
test('deploy workflow uses a self-hosted runner on the deploy host with no SSH hop', () => {
  assert.match(
    workflow,
    /runs-on:\s*\[self-hosted, Linux, X64\]/,
    'deploy job should target a self-hosted Linux runner on the deployment host',
  );
  assert.match(
    workflow,
    /- name: Log in to GHCR[\s\S]*?docker\/login-action@/,
    'deploy workflow should authenticate the local host Docker daemon to GHCR before pulling the image',
  );
  assert.match(
    workflow,
    /repo_path="\$\{DEPLOY_PATH\}"/,
    'deploy script should operate directly on the local deployment checkout path',
  );
  assert.match(
    workflow,
    /WORKFLOW_GIT_TOKEN:\s*\$\{\{\s*secrets\.GHCR_WORKFLOW_TOKEN\s*\|\|\s*github\.token\s*\}\}/,
    'deploy workflow should expose a workflow-scoped Git token for local fetches instead of depending on SSH user state',
  );
  assert.match(
    workflow,
    /origin_url="https:\/\/x-access-token:\$\{WORKFLOW_GIT_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
    'deploy workflow should build an HTTPS origin URL from the workflow token for self-hosted fetches',
  );
  assert.match(
    workflow,
    /git -C "\$\{repo_path\}" fetch --prune --tags "\$\{origin_url\}"[\s\S]*?refs\/remotes\/origin\/\*/,
    'deploy workflow should refresh origin refs through the authenticated HTTPS URL before resetting the checkout',
  );
  assert.doesNotMatch(
    workflow,
    /Configure SSH/,
    'deploy workflow should not configure SSH once the job runs on the deploy host itself',
  );
  assert.doesNotMatch(
    workflow,
    /ssh -p/,
    'deploy workflow should not shell into a remote VM anymore',
  );
  assert.doesNotMatch(
    workflow,
    /DEPLOY_SSH_PRIVATE_KEY|DEPLOY_HOST|DEPLOY_USER/,
    'deploy workflow should not require remote-host SSH secrets after the self-hosted migration',
  );
});

test('publish image script supports SHA-only deploy publishing', () => {
  assert.doesNotMatch(
    publishImageScript,
    /\bnode\s+-p\b/,
    'publish script should not depend on host Node being on PATH before publishing',
  );
  assert.match(
    publishImageScript,
    /command -v python3[\s\S]*?package\.json[\s\S]*?Aries marketing automation runtime/,
    'publish script should read package metadata without Node and fall back to a stable image description',
  );
  assert.match(
    publishImageScript,
    /PUBLISH_SHA_ONLY="\$\{PUBLISH_SHA_ONLY:-0\}"/,
    'publish script should expose a SHA-only mode for rollback-safe deploy publishes',
  );
  assert.match(
    publishImageScript,
    /if \[\[ "\$\{PUBLISH_SHA_ONLY\}" != "1" \]\]; then[\s\S]*?-t "\$\{GHCR_IMAGE\}:\$\{DEFAULT_BRANCH\}"[\s\S]*?-t "\$\{GHCR_IMAGE\}:latest"[\s\S]*?fi/,
    'mutable branch/latest tags should only be pushed outside SHA-only mode',
  );
});

// Regression: PR merges made by GITHUB_TOKEN do not emit normal push-triggered workflows.
// The agent merge workflow must explicitly dispatch Deploy with the merge SHA, and Deploy
// must build/pull that exact SHA instead of recycling :latest.
test('agent automerge dispatches an exact-SHA deploy after the PR is actually merged', () => {
  assert.match(
    prAgentWorkflow,
    /actions:\s*write/,
    'PR agent needs actions: write so it can dispatch the Deploy workflow after GITHUB_TOKEN merges',
  );
  assert.match(
    prAgentWorkflow,
    /mergeCommit[\s\S]*?\.mergeCommit\.oid/,
    'PR agent should read the actual merge commit SHA after GitHub finishes merging',
  );
  assert.match(
    prAgentWorkflow,
    /gh workflow run Deploy[\s\S]*?-f image_tag="\$\{merge_sha\}"[\s\S]*?-f git_ref="\$\{merge_sha\}"/,
    'PR agent should dispatch Deploy pinned to the exact merge SHA',
  );
});

test('agent automerge skips Claude action when the PR edits the agent workflow itself', () => {
  assert.match(
    prAgentWorkflow,
    /claude_allowed=/,
    'PR agent should expose a claude_allowed output from the guardrail step',
  );
  assert.match(
    prAgentWorkflow,
    /\.github\/workflows\/pr-agent-autofix-automerge\.yml/,
    'PR agent should detect edits to its own workflow file',
  );
  assert.match(
    prAgentWorkflow,
    /Claude PR autofix[\s\S]*?if: steps\.pr\.outputs\.should_run == 'true' && steps\.pr\.outputs\.claude_allowed == 'true'/,
    'Claude action should be skipped for self-modifying workflow PRs to avoid default-branch validation failures',
  );
});

test('agent automerge exits before checkout when a retrigger sees an already-terminal PR', () => {
  assert.match(
    prAgentWorkflow,
    /gh pr view "\$pr_number" --json [^\n]*\bstate\b/,
    'PR agent should request PR state before any checkout side effects',
  );
  assert.match(
    prAgentWorkflow,
    /pr_state="\$\(jq -r '\.state' \/tmp\/pr\.json\)"[\s\S]*?\[ "\$pr_state" = "MERGED" \] \|\| \[ "\$pr_state" = "CLOSED" \][\s\S]*?should_run=false[\s\S]*?exit 0[\s\S]*?is_cross_repo=/,
    'PR agent should short-circuit merged or closed PRs before guardrails and checkout steps run',
  );
});

test('deploy workflow builds and force-recreates the exact commit image', () => {
  assert.match(
    workflow,
    /if \[\[ "\$\{EVENT_NAME\}" == "push" \]\]; then\s*image_tag="\$\{CURRENT_SHA\}"/,
    'push deploys should target the current commit SHA, not mutable :latest',
  );
  assert.match(
    workflow,
    /- name: Publish exact deploy image[\s\S]*?git fetch --no-tags origin "\$\{default_branch\}"[\s\S]*?publish_sha_only=1[\s\S]*?PUBLISH_SHA_ONLY="\$\{publish_sha_only\}" \.\/scripts\/release\/publish-image\.sh/,
    'manual rollback deploys should publish only the requested SHA instead of retagging default-branch aliases',
  );
  assert.match(
    workflow,
    /Publishing \$\{TARGET_IMAGE_TAG\} plus \$\{default_branch\}\/latest aliases because it is the current default branch head\./,
    'push deploys and current default-branch deploys should still update default-branch/latest aliases',
  );
  assert.match(
    publishImageScript,
    /if \[\[ "\$\{PUBLISH_SHA_ONLY\}" != "1" \]\]; then[\s\S]*?-t "\$\{GHCR_IMAGE\}:\$\{DEFAULT_BRANCH\}"[\s\S]*?-t "\$\{GHCR_IMAGE\}:latest"/,
    'publish-image should omit mutable branch/latest tags when PUBLISH_SHA_ONLY=1',
  );
  assert.match(
    workflow,
    /ARIES_APP_IMAGE="\$\{TARGET_IMAGE\}" docker compose pull "\$\{SERVICE_NAME\}"/,
    'deploy workflow should pull the pinned target image before recreate',
  );
  assert.match(
    workflow,
    /replace_application_and_verify "\$\{TARGET_IMAGE\}" "\$\{target_image_id\}" "\$\{SERVICE_NAME\}"/,
    'deploy workflow should use the executable recreate-and-health verifier',
  );
   assert.doesNotMatch(
     workflow,
     /image_tag="latest"/,
     'deploy workflow should not deploy mutable :latest for push events',
   );
   assert.match(
     publishImageScript,
     /PUBLISH_SHA_ONLY="\$\{PUBLISH_SHA_ONLY:-0\}"/,
     'publish script should support SHA-only publishes for rollback-safe deploys',
   );
   assert.match(
     publishImageScript,
     /if \[\[ "\$\{PUBLISH_SHA_ONLY\}" != "1" \]\]; then[\s\S]*?-t "\$\{GHCR_IMAGE\}:\$\{DEFAULT_BRANCH\}"[\s\S]*?-t "\$\{GHCR_IMAGE\}:latest"/,
     'publish script should only update branch/latest tags when SHA-only mode is disabled',
   );
 });

test('schema failure restores the exact old worker container and preserves the nonzero status', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-schema-restore-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  try {
    mkdirSync(binDir);
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -u
printf '%s | PGOPTIONS=%s\\n' "$*" "\${PGOPTIONS:-}" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" ]]; then
  printf 'old-worker-container\\n'
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  printf 'true\\n'
  exit 0
fi
if [[ "$*" == *"scripts/init-db.js" ]]; then
  exit 42
fi
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync(
      'bash',
      [path.join(PROJECT_ROOT, 'scripts', 'release', 'apply-schema-with-worker-restore.sh')],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TARGET_IMAGE: 'ghcr.io/example/aries:target',
          DOCKER_LOG: logPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );

    assert.equal(result.status, 42, `schema exit code must survive restore; stderr=${result.stderr}`);
    const calls = readFileSync(logPath, 'utf8');
    const stop = calls.indexOf('compose stop aries-scheduled-posts-worker');
    const schema = calls.indexOf('compose run --rm --no-deps --entrypoint node aries-app scripts/init-db.js');
    const restore = calls.indexOf('start old-worker-container');
    assert.ok(stop !== -1 && schema !== -1 && restore !== -1);
    assert.ok(stop < schema && schema < restore, 'old worker is restored only after the forced schema failure');
    assert.match(calls, /scripts\/init-db\.js \| PGOPTIONS=-c lock_timeout=5s -c statement_timeout=120s/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('any failure after schema apply but before the new worker starts restores the exact old container', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-pre-worker-restore-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  const harness = path.join(tempRoot, 'harness.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -u
printf '%s | PGOPTIONS=%s\\n' "$*" "\${PGOPTIONS:-}" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" ]]; then
  printf 'old-worker-container\\n'
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  printf 'true\\n'
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(fakeDocker, 0o755);
    writeFileSync(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
source "${path.join(PROJECT_ROOT, 'scripts', 'release', 'apply-schema-with-worker-restore.sh').replace(/\\/g, '/')}"
exit 37
`,
      { mode: 0o755 },
    );

    const result = spawnSync('bash', [harness], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_IMAGE: 'ghcr.io/example/aries:target',
        DOCKER_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.status, 37, `pre-worker failure status must survive restore; stderr=${result.stderr}`);
    const calls = readFileSync(logPath, 'utf8');
    assert.match(calls, /compose run --rm --no-deps --entrypoint node aries-app scripts\/init-db\.js/);
    assert.match(calls, /start old-worker-container/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('successful direct schema-only execution restarts the exact old worker', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-schema-direct-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  try {
    mkdirSync(binDir);
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" ]]; then
  printf 'old-worker-container\\n'
elif [[ "$*" == "inspect -f {{.State.Running}} old-worker-container" ]]; then
  printf 'true\\n'
elif [[ "$*" == "inspect -f {{.Image}} old-worker-container" ]]; then
  printf 'sha-old\\n'
elif [[ "$*" == "inspect old-worker-container" ]]; then
  printf '%s\\n' '[{"Id":"old-worker-container","Name":"/aries-scheduled-posts-worker-1","Image":"sha-old","Config":{"Image":"ghcr.io/example/aries:old"},"HostConfig":{},"NetworkSettings":{"Networks":{}}}]'
fi
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync(
      'bash',
      [path.join(PROJECT_ROOT, 'scripts', 'release', 'apply-schema-with-worker-restore.sh')],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TARGET_IMAGE: 'ghcr.io/example/aries:target',
          DOCKER_LOG: logPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(logPath, 'utf8');
    const schema = calls.indexOf('scripts/init-db.js');
    const restore = calls.indexOf('start old-worker-container');
    assert.ok(schema !== -1 && restore > schema, 'schema-only success must not strand the previous worker stopped');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('every required pre-rollout worker inspection failure aborts before stop or schema mutation', async (t) => {
  for (const gate of ['running', 'image', 'snapshot']) {
    await t.test(gate, () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), `aries-worker-preflight-${gate}-`));
      const binDir = path.join(tempRoot, 'bin');
      const logPath = path.join(tempRoot, 'docker.log');
      const fakeDocker = path.join(binDir, 'docker');
      try {
        mkdirSync(binDir);
        writeFileSync(
          fakeDocker,
          `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" ]]; then
  printf 'old-worker-container\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.State.Running}} old-worker-container" ]]; then
  [[ "\${GATE}" != "running" ]] || exit 71
  printf 'true\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} old-worker-container" ]]; then
  [[ "\${GATE}" != "image" ]] || exit 72
  printf 'sha-old\\n'; exit 0
fi
if [[ "$*" == "inspect old-worker-container" ]]; then
  [[ "\${GATE}" != "snapshot" ]] || exit 73
  printf '%s\\n' '[{"Id":"old-worker-container","Name":"/aries-scheduled-posts-worker-1","Image":"sha-old","Config":{"Image":"ghcr.io/example/aries:old"},"HostConfig":{},"NetworkSettings":{"Networks":{}}}]'
  exit 0
fi
exit 0
`,
          { mode: 0o755 },
        );
        chmodSync(fakeDocker, 0o755);

        const result = spawnSync(
          'bash',
          [path.join(PROJECT_ROOT, 'scripts', 'release', 'apply-schema-with-worker-restore.sh')],
          {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            env: {
              ...process.env,
              TARGET_IMAGE: 'ghcr.io/example/aries:target',
              DOCKER_LOG: logPath,
              GATE: gate,
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            },
          },
        );

        assert.notEqual(result.status, 0, `${gate} inspection failure must abort the rollout`);
        const calls = readFileSync(logPath, 'utf8');
        assert.doesNotMatch(calls, /compose stop aries-scheduled-posts-worker/);
        assert.doesNotMatch(calls, /scripts\/init-db\.js/);
        assert.match(`${result.stdout}\n${result.stderr}`, /pre-rollout worker snapshot/i);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test('every post-boundary replacement failure leaves publishing stopped instead of restoring a stale worker', async (t) => {
  for (const gate of [
    'readiness-db',
    'readiness-schema',
    'readiness-protocol',
    'recreate',
    'inspect',
    'running',
    'image',
    'manifest',
  ]) {
    await t.test(gate, () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), `aries-worker-${gate}-`));
      const binDir = path.join(tempRoot, 'bin');
      const stateDir = path.join(tempRoot, 'state');
      const logPath = path.join(tempRoot, 'docker.log');
      const fakeDocker = path.join(binDir, 'docker');
      const fakeRestore = path.join(binDir, 'restore-exact-worker');
      const harness = path.join(tempRoot, 'harness.sh');
      try {
        mkdirSync(binDir);
        mkdirSync(stateDir);
        writeFileSync(
          fakeDocker,
          `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" || "$*" == "compose ps -aq aries-scheduled-posts-worker" ]]; then
  if [[ -f "\${STATE_DIR}/replaced" && ! -f "\${STATE_DIR}/removed" ]]; then
    printf 'new-worker-container\\n'
  else
    printf 'old-worker-container\\n'
  fi
  exit 0
fi
if [[ "$*" == "inspect -f {{.State.Running}} old-worker-container" ]]; then
  printf 'true\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} old-worker-container" ]]; then
  printf 'sha-old\\n'; exit 0
fi
if [[ "$*" == "inspect old-worker-container" ]]; then
  [[ ! -f "\${STATE_DIR}/replaced" ]] || exit 1
  printf '%s\\n' '[{"Id":"old-worker-container","Name":"/aries-scheduled-posts-worker-1","Image":"sha-old","Config":{"Image":"ghcr.io/example/aries:old","Env":["A=1"],"Cmd":["node","worker.mjs"],"Labels":{"com.docker.compose.service":"aries-scheduled-posts-worker"}},"HostConfig":{"Binds":["/srv/aries/.env:/app/.env:ro"],"RestartPolicy":{"Name":"unless-stopped"}},"NetworkSettings":{"Networks":{"aries_default":{"Aliases":["aries-scheduled-posts-worker"]}}}}]'
  exit 0
fi
if [[ "$*" == *"compose up -d --no-deps --force-recreate --pull always aries-scheduled-posts-worker"* ]]; then
  touch "\${STATE_DIR}/replaced"
  [[ "\${GATE}" != "recreate" ]] || exit 51
  exit 0
fi
if [[ "$*" == "inspect -f {{.State.Running}} new-worker-container" ]]; then
  [[ "\${GATE}" != "inspect" ]] || exit 52
  [[ "\${GATE}" != "running" ]] || { printf 'false\\n'; exit 0; }
  printf 'true\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} new-worker-container" ]]; then
  [[ "\${GATE}" != "image" ]] || { printf 'sha-wrong\\n'; exit 0; }
  printf 'sha-target\\n'; exit 0
fi
if [[ "$*" == "compose config --format json" ]]; then
  [[ "\${GATE}" != "manifest" ]] || exit 53
  printf '%s\\n' '{"services":{"aries-scheduled-posts-worker":{"image":"ghcr.io/example/aries:target"}}}'
  exit 0
fi
if [[ "$*" == *"ARIES_SCHEDULED_POSTS_READINESS_CHECK=1"* ]]; then
  case "\${GATE}" in
    readiness-db|readiness-schema|readiness-protocol) exit 54 ;;
  esac
  exit 0
fi
if [[ "$*" == "rm -f new-worker-container" ]]; then
  touch "\${STATE_DIR}/removed"; exit 0
fi
if [[ "$*" == "start restored-old-container" ]]; then
  printf 'restored-old-container\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.State.Running}} restored-old-container" ]]; then
  printf 'true\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} restored-old-container" ]]; then
  printf 'sha-old\\n'; exit 0
fi
exit 0
`,
          { mode: 0o755 },
        );
        writeFileSync(
          fakeRestore,
          `#!/usr/bin/env bash
set -eu
printf 'restore-snapshot %s\\n' "$1" >> "\${DOCKER_LOG}"
cp "$1" "\${STATE_DIR}/restored-snapshot.json"
printf 'restored-old-container\\n'
`,
          { mode: 0o755 },
        );
        writeFileSync(
          harness,
          `#!/usr/bin/env bash
set -euo pipefail
source "${path.join(PROJECT_ROOT, 'scripts', 'release', 'apply-schema-with-worker-restore.sh').replace(/\\/g, '/')}"
mark_scheduled_worker_protocol_boundary
replace_scheduled_worker_and_verify 'ghcr.io/example/aries:target' 'sha-target'
`,
          { mode: 0o755 },
        );
        chmodSync(fakeDocker, 0o755);
        chmodSync(fakeRestore, 0o755);
        chmodSync(harness, 0o755);

        const result = spawnSync('bash', [harness], {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_IMAGE: 'ghcr.io/example/aries:target',
            DOCKER_LOG: logPath,
            STATE_DIR: stateDir,
            GATE: gate,
            RESTORE_CONTAINER_COMMAND: fakeRestore,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          },
        });

        assert.notEqual(result.status, 0, `${gate} failure must fail the deployment`);
        const calls = readFileSync(logPath, 'utf8');
        const readinessFailure = gate.startsWith('readiness-');
        const preStartFailure = readinessFailure || gate === 'manifest';
        if (readinessFailure) assert.match(calls, /ARIES_SCHEDULED_POSTS_READINESS_CHECK=1/);
        if (preStartFailure) {
          assert.doesNotMatch(
            calls,
            /compose up -d --no-deps --force-recreate --pull always aries-scheduled-posts-worker/,
            'publishing must remain stopped until manifest and one-shot functional readiness succeed',
          );
        } else {
          assert.match(calls, /rm -f new-worker-container/);
        }
        assert.match(calls, /compose stop aries-scheduled-posts-worker/);
        assert.doesNotMatch(calls, /restore-snapshot /);
        assert.doesNotMatch(calls, /start restored-old-container/);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /protocol boundary crossed; refusing to restore the previous scheduled worker/i,
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test('application health failure after the protocol boundary leaves publishing stopped', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-app-health-boundary-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  const harness = path.join(tempRoot, 'harness.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" || "$*" == "compose ps -aq aries-scheduled-posts-worker" ]]; then
  printf 'old-worker-container\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.State.Running}} old-worker-container" ]]; then
  printf 'true\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} old-worker-container" ]]; then
  printf 'sha-old\\n'; exit 0
fi
if [[ "$*" == "inspect old-worker-container" ]]; then
  printf '%s\\n' '[{"Id":"old-worker-container","Name":"/aries-scheduled-posts-worker-1","Image":"sha-old","Config":{"Image":"ghcr.io/example/aries:old"},"HostConfig":{},"NetworkSettings":{"Networks":{}}}]'
  exit 0
fi
if [[ "$*" == "compose ps -q aries-app" ]]; then
  printf 'new-app-container\\n'; exit 0
fi
if [[ "$*" == "image inspect -f {{.Id}} ghcr.io/example/aries:target" ]]; then
  printf 'sha-target\\n'; exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} new-app-container" ]]; then
  printf 'sha-target\\n'; exit 0
fi
if [[ "$*" == "compose exec -T aries-app wget -qO- http://127.0.0.1:3000/" ]]; then
  exit 1
fi
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
source "${path.join(PROJECT_ROOT, 'scripts', 'release', 'apply-schema-with-worker-restore.sh').replace(/\\/g, '/')}"
mark_scheduled_worker_protocol_boundary
replace_application_and_verify 'ghcr.io/example/aries:target' 'sha-target' 'aries-app' 2 0
`,
      { mode: 0o755 },
    );
    chmodSync(fakeDocker, 0o755);
    chmodSync(harness, 0o755);

    const result = spawnSync('bash', [harness], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_IMAGE: 'ghcr.io/example/aries:target',
        DOCKER_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.notEqual(result.status, 0, 'application health failure must fail the deployment');
    const calls = readFileSync(logPath, 'utf8');
    assert.match(calls, /compose up -d --no-deps --force-recreate --pull always aries-app/);
    assert.match(calls, /compose exec -T aries-app wget -qO- http:\/\/127\.0\.0\.1:3000\//);
    assert.match(calls, /compose stop aries-scheduled-posts-worker/);
    assert.doesNotMatch(calls, /start old-worker-container/);
    assert.doesNotMatch(calls, /compose up .*aries-scheduled-posts-worker/);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /protocol boundary crossed; refusing to restore the previous scheduled worker/i,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
