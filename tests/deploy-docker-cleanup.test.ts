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
const CLEANUP_MARKER = '# --- Disk hygiene: reclaim stale Docker artifacts before the preflight ---';
const PREFLIGHT_MARKER = '# --- Disk preflight: fail fast if Docker storage filesystem is too full ---';

function cleanupBlock(): string {
  const cleanupStart = workflow.indexOf(CLEANUP_MARKER);
  const preflightStart = workflow.indexOf(PREFLIGHT_MARKER);
  assert.notEqual(cleanupStart, -1, 'deploy workflow is missing the preflight Docker cleanup block');
  assert.notEqual(preflightStart, -1, 'deploy workflow is missing the 10 GB disk preflight');
  assert.ok(cleanupStart < preflightStart, 'Docker cleanup must run before the disk preflight');
  return workflow.slice(cleanupStart, preflightStart);
}

function executableCleanupBlock(): string {
  return cleanupBlock()
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

test('deploy cleanup is age-bounded, target-repository-only, rollback-safe, and non-destructive', () => {
  const cleanup = cleanupBlock();

  assert.match(
    workflow,
    /- name: Set up Docker Buildx\s*\n\s*id: buildx\s*\n\s*uses: docker\/setup-buildx-action@/,
    'the selected Buildx builder needs a stable step id',
  );
  assert.match(
    workflow,
    /BUILDX_BUILDER_NAME:\s*\$\{\{\s*steps\.buildx\.outputs\.name\s*\}\}/,
    'the deploy step must receive the exact builder selected by setup-buildx-action',
  );
  assert.match(
    cleanup,
    /docker buildx prune[\s\S]*?--builder "\$\{BUILDX_BUILDER_NAME\}"[\s\S]*?--filter "until=168h"/,
    'build cache cleanup must target the selected Buildx builder and only cache older than seven days',
  );
  assert.match(
    cleanup,
    /target_image_repository="\$\{TARGET_IMAGE%:\*\}"/,
    'the cleanup repository must be derived from the immutable target image',
  );
  assert.match(
    cleanup,
    /docker image ls --no-trunc --filter "reference=\$\{target_image_repository\}:\*"/,
    'candidate enumeration must be limited to the immutable target repository',
  );
  assert.match(
    cleanup,
    /\[\[ "\$\{listed_repository\}" == "\$\{target_image_repository\}" \]\] \|\| continue/,
    'candidate rows must be rechecked against the exact repository before deletion',
  );
  assert.match(cleanup, /168 \* 60 \* 60/, 'image cleanup must use the same seven-day age bound');
  assert.match(cleanup, /if \(\( image_index < 3 \)\); then/, 'the newest three target images must be retained');
  assert.match(
    cleanup,
    /docker ps -aq[\s\S]*?container_referenced_image_ids/,
    'all container-referenced image ids must be protected, including stopped containers',
  );
  assert.match(
    cleanup,
    /if \(\( created_epoch >= cleanup_cutoff_epoch \)\); then/,
    'target images newer than seven days must be retained even outside the newest three',
  );
  assert.match(
    cleanup,
    /docker image rm "\$\{image_ref\}"/,
    'cleanup must remove only exact target-repository tags, never an image id shared by another repository',
  );
  assert.doesNotMatch(cleanup, /docker image prune|docker builder prune/);
  assert.doesNotMatch(
    cleanup,
    /docker\s+(?:container|volume|network|system)\s+(?:prune|rm)\b|docker\s+compose\s+(?:down|rm)\b|\brm\s+-rf\b/,
    'disk hygiene must never delete containers, volumes, networks, mounted data, or production data',
  );
  assert.doesNotMatch(cleanup, /^\s*exit\b/m, 'cleanup failures must not block the deploy');
  assert.match(cleanup, /WARNING:[^\n]*continuing/);
  assert.match(workflow, /DISK_PREFLIGHT_REQUIRED_GB=10/, 'the deploy disk threshold must remain 10 GB');
});

test('deploy cleanup keeps newest, recent, referenced, local, and unrelated images when cleanup commands fail', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-deploy-cleanup-'));
  const binDir = path.join(tempRoot, 'bin');
  const dockerLog = path.join(tempRoot, 'docker.log');
  const fakeDocker = path.join(binDir, 'docker');
  const fakeDate = path.join(binDir, 'date');
  const harness = path.join(tempRoot, 'cleanup.sh');
  const targetRepository = 'ghcr.io/delicioushouse/aries-app';

  try {
    mkdirSync(binDir);
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
if [[ "$1" == "buildx" && "$2" == "prune" ]]; then
  exit 41
fi
if [[ "$*" == "ps -aq" ]]; then
  printf 'container-old6\\n'
  exit 0
fi
if [[ "$1" == "inspect" && "\${*: -1}" == "container-old6" ]]; then
  printf 'sha256:old6\\n'
  exit 0
fi
if [[ "$1" == "image" && "$2" == "ls" ]]; then
  cat <<'ROWS'
sha256:new1|${targetRepository}|sha-new1
sha256:new2|${targetRepository}|sha-new2
sha256:new3|${targetRepository}|sha-new3
sha256:recent4|${targetRepository}|sha-recent4
sha256:old5|${targetRepository}|sha-old5
sha256:old6|${targetRepository}|sha-old6
sha256:old7|${targetRepository}|sha-old7
sha256:local|aries-app|local
sha256:unrelated|ghcr.io/other/app|old
ROWS
  exit 0
fi
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  image_id="\${*: -1}"
  case "\${image_id}" in
    sha256:new1) created='new1-created' ;;
    sha256:new2) created='new2-created' ;;
    sha256:new3) created='new3-created' ;;
    sha256:recent4) created='recent4-created' ;;
    sha256:old5) created='old5-created' ;;
    sha256:old6) created='old6-created' ;;
    sha256:old7) created='old7-created' ;;
    *) exit 42 ;;
  esac
  printf '%s|%s\\n' "\${image_id}" "\${created}"
  exit 0
fi
if [[ "$1" == "image" && "$2" == "rm" ]]; then
  [[ "\${*: -1}" != "${targetRepository}:sha-old5" ]] || exit 43
  exit 0
fi
exit 44
`,
      { mode: 0o755 },
    );
    writeFileSync(
      fakeDate,
      `#!/usr/bin/env bash
set -u
if [[ "$*" == "-u +%s" ]]; then
  [[ "\${FAIL_NOW_DATE:-0}" != "1" ]] || exit 47
  printf '2000000\\n'
  exit 0
fi
if [[ "$1" == "-u" && "$2" == "-d" && "$4" == "+%s" ]]; then
  case "$3" in
    new1-created) printf '1900000\\n' ;;
    new2-created) printf '1800000\\n' ;;
    new3-created) printf '1700000\\n' ;;
    recent4-created) printf '1500000\\n' ;;
    old5-created) printf '1300000\\n' ;;
    old6-created) printf '1200000\\n' ;;
    old7-created) printf '1100000\\n' ;;
    *) exit 45 ;;
  esac
  exit 0
fi
exit 46
`,
      { mode: 0o755 },
    );
    writeFileSync(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
${executableCleanupBlock()}
`,
      { mode: 0o755 },
    );
    chmodSync(fakeDocker, 0o755);
    chmodSync(fakeDate, 0o755);
    chmodSync(harness, 0o755);

    const result = spawnSync('bash', [harness], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_IMAGE: `${targetRepository}:0123456789abcdef0123456789abcdef01234567`,
        BUILDX_BUILDER_NAME: 'builder-from-setup-action',
        DOCKER_LOG: dockerLog,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.status, 0, `cleanup must stay nonfatal; stderr=${result.stderr}`);
    const calls = readFileSync(dockerLog, 'utf8');
    assert.match(
      calls,
      /buildx prune --builder builder-from-setup-action --all --force --filter until=168h --keep-storage=2GB/,
    );
    assert.match(
      calls,
      new RegExp(`image ls --no-trunc --filter reference=${targetRepository.replaceAll('/', '\\/')}:\\*`),
    );
    const removals = calls
      .split('\n')
      .filter((line) => line.startsWith('image rm '));
    assert.deepEqual(removals, [
      `image rm ${targetRepository}:sha-old5`,
      `image rm ${targetRepository}:sha-old7`,
    ]);
    assert.doesNotMatch(calls, /image rm .*sha-(?:new1|new2|new3|recent4|old6)|image rm aries-app:local|image rm ghcr\.io\/other\/app/);
    assert.match(`${result.stdout}\n${result.stderr}`, /WARNING:[^\n]*continuing/);

    const cutoffFailureLog = path.join(tempRoot, 'docker-cutoff-failure.log');
    writeFileSync(cutoffFailureLog, '');
    const cutoffFailure = spawnSync('bash', [harness], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_IMAGE: `${targetRepository}:0123456789abcdef0123456789abcdef01234567`,
        BUILDX_BUILDER_NAME: 'builder-from-setup-action',
        DOCKER_LOG: cutoffFailureLog,
        FAIL_NOW_DATE: '1',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(
      cutoffFailure.status,
      0,
      `an unavailable cleanup clock must not block deploy; stderr=${cutoffFailure.stderr}`,
    );
    const cutoffFailureCalls = readFileSync(cutoffFailureLog, 'utf8');
    assert.match(cutoffFailureCalls, /buildx prune --builder builder-from-setup-action/);
    assert.doesNotMatch(cutoffFailureCalls, /image ls|image rm/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
