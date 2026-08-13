import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const syncScriptPath = path.join(PROJECT_ROOT, 'scripts', 'release', 'sync-env-image-pin.sh');
const guardScriptPath = path.join(PROJECT_ROOT, 'scripts', 'check-image-pin.sh');

function runSync(envFile: string, imageRef: string) {
  return spawnSync('bash', [syncScriptPath, envFile, imageRef], { encoding: 'utf8' });
}

// Regression: the 2026-08-12 stale-pin rollbacks. The deploy pins every compose
// invocation with an env override, so without an explicit .env rewrite the host
// pin drifts behind the running containers and a later bare `docker compose up`
// silently rolls production back.
test('deploy workflow syncs the .env ARIES_APP_IMAGE pin after the sidecar verification gate', () => {
  const workerGate = workflow.indexOf(
    'echo "Post-deploy check: all sidecar workers are running on the target image."',
  );
  const pinSync = workflow.indexOf('./scripts/release/sync-env-image-pin.sh .env "${pin_ref}"');
  assert.notEqual(workerGate, -1, 'deploy workflow is missing the sidecar verification gate');
  assert.notEqual(pinSync, -1, 'deploy workflow must rewrite the host .env ARIES_APP_IMAGE pin');
  assert.ok(
    workerGate < pinSync,
    'the pin must only be rewritten after app + sidecars are verified on the target image (never pin an image that did not fully roll out)',
  );
  assert.match(
    workflow,
    /if ! \.\/scripts\/release\/sync-env-image-pin\.sh \.env "\$\{pin_ref\}"; then[\s\S]*?exit 1/,
    'a failed pin sync must fail the deploy — green-with-stale-pin re-arms the rollback footgun',
  );
  // The pin must be the immutable REGISTRY digest (hybrid tag@digest form),
  // never the local image ID that sits nearby in the same step:
  // target_image_id is `docker image inspect -f '{{.Id}}'` output, which is
  // not pullable and means nothing to compose on any host.
  assert.match(
    workflow,
    /pin_repo_digest="\$\(docker image inspect -f '\{\{range \.RepoDigests\}\}\{\{println \.\}\}\{\{end\}\}' "\$\{TARGET_IMAGE\}"/,
    'the pin value must come from RepoDigests (registry digest), with the tag kept for readability',
  );
  assert.match(
    workflow,
    /pin_ref="\$\{TARGET_IMAGE\}@\$\{pin_repo_digest##\*@\}"/,
    'the pin must use the hybrid name:tag@sha256:digest form',
  );
  assert.doesNotMatch(
    workflow,
    /sync-env-image-pin\.sh \.env "\$\{target_image_id\}"/,
    'never write the LOCAL image ID into the .env pin',
  );
});

test('pin sync and guard scripts are executable bash with valid syntax', () => {
  for (const scriptPath of [syncScriptPath, guardScriptPath]) {
    assert.ok(statSync(scriptPath).mode & 0o111, `${scriptPath} must be executable`);
    const check = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${scriptPath} failed bash -n: ${check.stderr}`);
  }
});

test('sync-env-image-pin replaces the existing pin without clobbering other variables', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-env-pin-replace-'));
  try {
    const envFile = path.join(tempRoot, '.env');
    writeFileSync(
      envFile,
      [
        '# production env',
        'DB_PASSWORD=s3cret with spaces',
        'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app@sha256:a050fa08deadbeef',
        '',
        'ARIES_WEB_CONCURRENCY=4',
        'EMAIL_FROM=Aries AI <noreply@example.com>',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );

    const result = runSync(envFile, 'ghcr.io/delicioushouse/aries-app:fe86ffce00000000000000000000000000000000');
    assert.equal(result.status, 0, result.stderr);

    const updated = readFileSync(envFile, 'utf8');
    assert.equal(
      updated,
      [
        '# production env',
        'DB_PASSWORD=s3cret with spaces',
        'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:fe86ffce00000000000000000000000000000000',
        '',
        'ARIES_WEB_CONCURRENCY=4',
        'EMAIL_FROM=Aries AI <noreply@example.com>',
      ].join('\n') + '\n',
      'only the pin line may change; position, comments, blanks, and other variables are preserved',
    );
    assert.equal(statSync(envFile).mode & 0o777, 0o600, 'the .env permissions must survive the rewrite');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('sync-env-image-pin appends when the variable line is missing and converges duplicates', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-env-pin-append-'));
  try {
    const envFile = path.join(tempRoot, '.env');
    writeFileSync(envFile, 'DB_NAME=aries\n');

    let result = runSync(envFile, 'ghcr.io/delicioushouse/aries-app:abc');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      'DB_NAME=aries\nARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:abc\n',
    );

    // A duplicated pin (hand edits happen) must converge to one line.
    writeFileSync(
      envFile,
      'ARIES_APP_IMAGE=old-one\nDB_NAME=aries\nARIES_APP_IMAGE=old-two\n',
    );
    result = runSync(envFile, 'ghcr.io/delicioushouse/aries-app:def');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:def\nDB_NAME=aries\n',
    );

    // Idempotent: running again changes nothing.
    result = runSync(envFile, 'ghcr.io/delicioushouse/aries-app:def');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:def\nDB_NAME=aries\n',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('sync-env-image-pin creates a missing .env instead of leaving the compose default in charge', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-env-pin-create-'));
  try {
    const envFile = path.join(tempRoot, '.env');
    const result = runSync(envFile, 'ghcr.io/delicioushouse/aries-app:abc');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(envFile, 'utf8'), 'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:abc\n');
    assert.equal(
      statSync(envFile).mode & 0o777,
      0o600,
      'a freshly created .env must be owner-only — it will hold secrets',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// The fake docker below emulates: one running aries-app container, plus image
// metadata for the pinned ref. RUNNING_IMAGE_ID / PINNED_IMAGE_ID control
// whether the pin agrees with reality.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
if [[ "$*" == "compose ps --services" ]]; then
  printf 'aries-app\\naries-autoheal\\n'
  exit 0
fi
if [[ "$*" == "compose ps -q aries-app" ]]; then
  printf 'app-container\\n'
  exit 0
fi
if [[ "$*" == "inspect -f {{.State.Running}} app-container" ]]; then
  printf 'true\\n'
  exit 0
fi
if [[ "$*" == "inspect -f {{.Image}} app-container" ]]; then
  printf '%s\\n' "\${RUNNING_IMAGE_ID}"
  exit 0
fi
if [[ "$*" == "inspect -f {{.Config.Image}} app-container" ]]; then
  printf 'ghcr.io/delicioushouse/aries-app:running\\n'
  exit 0
fi
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  ref="\${5:-}"
  if [[ -n "\${PINNED_IMAGE_ACCEPT:-}" && "\${ref}" != "\${PINNED_IMAGE_ACCEPT}" ]]; then
    exit 1
  fi
  if [[ -n "\${PINNED_IMAGE_ID}" ]]; then
    printf '%s\\n' "\${PINNED_IMAGE_ID}"
    exit 0
  fi
  exit 1
fi
exit 0
`;

test('check-image-pin refuses when the .env pin disagrees with the running container', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-pin-guard-mismatch-'));
  try {
    writeFileSync(
      path.join(tempRoot, '.env'),
      'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:stale\n',
    );
    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeDocker = path.join(binDir, 'docker');
    writeFileSync(fakeDocker, FAKE_DOCKER, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const result = spawnSync('bash', [guardScriptPath], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARIES_APP_IMAGE: '',
        RUNNING_IMAGE_ID: 'sha256:running-image',
        PINNED_IMAGE_ID: 'sha256:stale-image',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    assert.equal(result.status, 1, `mismatch must refuse; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /MISMATCH aries-app/);
    assert.match(result.stderr, /silent rollback/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('check-image-pin passes when the pin matches the running container', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-pin-guard-match-'));
  try {
    writeFileSync(
      path.join(tempRoot, '.env'),
      'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:current\n',
    );
    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeDocker = path.join(binDir, 'docker');
    writeFileSync(fakeDocker, FAKE_DOCKER, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const result = spawnSync('bash', [guardScriptPath], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARIES_APP_IMAGE: '',
        RUNNING_IMAGE_ID: 'sha256:same-image',
        PINNED_IMAGE_ID: 'sha256:same-image',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    assert.equal(result.status, 0, `match must pass; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /OK — 1 running service\(s\) match/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('check-image-pin resolves a hybrid tag@digest pin via the repo@digest fallback', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-pin-guard-hybrid-'));
  try {
    writeFileSync(
      path.join(tempRoot, '.env'),
      'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:abc123@sha256:feedface\n',
    );
    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeDocker = path.join(binDir, 'docker');
    writeFileSync(fakeDocker, FAKE_DOCKER, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const result = spawnSync('bash', [guardScriptPath], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARIES_APP_IMAGE: '',
        RUNNING_IMAGE_ID: 'sha256:same-image',
        PINNED_IMAGE_ID: 'sha256:same-image',
        // Only the tag-stripped repo@digest form resolves locally; the guard
        // must fall back to it instead of reporting the pin as missing.
        PINNED_IMAGE_ACCEPT: 'ghcr.io/delicioushouse/aries-app@sha256:feedface',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    assert.equal(result.status, 0, `hybrid pin must resolve; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /OK — 1 running service\(s\) match/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('check-image-pin refuses when the pinned image is not present on the host', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-pin-guard-absent-'));
  try {
    writeFileSync(
      path.join(tempRoot, '.env'),
      'ARIES_APP_IMAGE=ghcr.io/delicioushouse/aries-app:never-pulled\n',
    );
    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeDocker = path.join(binDir, 'docker');
    writeFileSync(fakeDocker, FAKE_DOCKER, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const result = spawnSync('bash', [guardScriptPath], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARIES_APP_IMAGE: '',
        RUNNING_IMAGE_ID: 'sha256:running-image',
        PINNED_IMAGE_ID: '',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    assert.equal(result.status, 1, `absent pinned image must refuse; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /not even pulled/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
