import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const CUTOVER_SCRIPT = path.join(
  PROJECT_ROOT,
  'scripts',
  'release',
  'apply-schema-with-worker-restore.sh',
);

test('legacy worker killed mid-provider is not restored when unresolved-claim proof fails before schema', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-legacy-mid-provider-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  try {
    mkdirSync(binDir);
    writeFileSync(fakeDocker, `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" ]]; then printf 'old-worker-container\\n'; exit 0; fi
if [[ "$*" == "inspect -f {{.State.Running}} old-worker-container" ]]; then printf 'true\\n'; exit 0; fi
if [[ "$*" == "inspect -f {{.Image}} old-worker-container" ]]; then printf 'sha-old\\n'; exit 0; fi
if [[ "$*" == "inspect old-worker-container" ]]; then
  printf '%s\\n' '[{"Id":"old-worker-container","Name":"/aries-scheduled-posts-worker-1","Image":"sha-old","Config":{"Image":"ghcr.io/example/aries:old"},"HostConfig":{},"NetworkSettings":{"Networks":{}}}]'
  exit 0
fi
if [[ "$*" == "compose stop aries-scheduled-posts-worker" ]]; then
  printf 'legacy-provider-request-killed\\n' >> "\${DOCKER_LOG}"
  exit 0
fi
if [[ "$*" == *"assert-no-unresolved-scheduled-claims.mjs"* ]]; then
  printf 'unresolved-in-flight-claim\\n' >> "\${DOCKER_LOG}"
  exit 73
fi
if [[ "$*" == *"scripts/init-db.js"* ]]; then exit 42; fi
exit 0
`, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync('bash', [CUTOVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_IMAGE: 'ghcr.io/example/aries:target',
        DOCKER_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.notEqual(result.status, 0);
    const calls = readFileSync(logPath, 'utf8');
    assert.match(calls, /legacy-provider-request-killed/);
    assert.match(calls, /assert-no-unresolved-scheduled-claims\.mjs/);
    assert.match(calls, /unresolved-in-flight-claim/);
    assert.match(calls, /scripts\/init-db\.js/, 'schema failure is injected after the legacy provider request is killed');
    assert.doesNotMatch(calls, /start old-worker-container/);
    assert.match(`${result.stdout}\n${result.stderr}`, /refusing to restore.*unresolved/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('functional readiness timeout is bounded, cleaned up, and leaves publishing stopped', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-readiness-timeout-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  const harness = path.join(tempRoot, 'harness.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(fakeDocker, `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$*" == "compose ps -q aries-scheduled-posts-worker" || "$*" == "compose ps -aq aries-scheduled-posts-worker" ]]; then printf 'old-worker-container\\n'; exit 0; fi
if [[ "$*" == "inspect -f {{.State.Running}} old-worker-container" ]]; then printf 'true\\n'; exit 0; fi
if [[ "$*" == "inspect -f {{.Image}} old-worker-container" ]]; then printf 'sha-old\\n'; exit 0; fi
if [[ "$*" == "inspect old-worker-container" ]]; then
  printf '%s\\n' '[{"Id":"old-worker-container","Name":"/aries-scheduled-posts-worker-1","Image":"sha-old","Config":{"Image":"ghcr.io/example/aries:old"},"HostConfig":{},"NetworkSettings":{"Networks":{}}}]'
  exit 0
fi
if [[ "$*" == *"assert-no-unresolved-scheduled-claims.mjs"* ]]; then exit 0; fi
if [[ "$*" == "compose config --format json" ]]; then
  printf '%s\\n' '{"services":{"aries-scheduled-posts-worker":{"image":"ghcr.io/example/aries:target"}}}'
  exit 0
fi
if [[ "$*" == *"ARIES_SCHEDULED_POSTS_READINESS_CHECK=1"* ]]; then sleep 8; exit 0; fi
exit 0
`, { mode: 0o755 });
    writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail
source "${CUTOVER_SCRIPT.replace(/\\/g, '/')}"
mark_scheduled_worker_protocol_boundary
replace_scheduled_worker_and_verify 'ghcr.io/example/aries:target' 'sha-target'
`, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    chmodSync(harness, 0o755);

    const startedAt = Date.now();
    const result = spawnSync('bash', [harness], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_IMAGE: 'ghcr.io/example/aries:target',
        DOCKER_LOG: logPath,
        ARIES_SCHEDULED_WORKER_READINESS_TIMEOUT_SECONDS: '1',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.notEqual(result.status, 0);
    assert.ok(elapsedMs < 5_000, `readiness timeout must be bounded; elapsed=${elapsedMs}ms`);
    const calls = readFileSync(logPath, 'utf8');
    assert.match(calls, /ARIES_SCHEDULED_POSTS_READINESS_CHECK=1/);
    assert.match(calls, /rm -f aries-scheduled-worker-readiness-/);
    assert.doesNotMatch(calls, /compose up -d --no-deps --force-recreate --pull always aries-scheduled-posts-worker/);
    assert.doesNotMatch(calls, /start old-worker-container/);
    assert.match(`${result.stdout}\n${result.stderr}`, /functional readiness failed.*publishing remains stopped/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
