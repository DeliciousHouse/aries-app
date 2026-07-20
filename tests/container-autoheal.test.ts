import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = process.cwd();
const composeSource = readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
const deploySource = readFileSync(
  path.join(PROJECT_ROOT, '.github', 'workflows', 'deploy.yml'),
  'utf8',
);
const deployParitySource = readFileSync(
  path.join(PROJECT_ROOT, 'tests', 'deploy-manifest-parity.test.ts'),
  'utf8',
);
const autohealScriptPath = path.join(PROJECT_ROOT, 'scripts', 'aries-autoheal.sh');

function composeServiceBlock(serviceName: string): string {
  const lines = composeSource.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `expected docker-compose.yml to define ${serviceName}`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9][A-Za-z0-9._-]*:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
    if (/^(networks|volumes):\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('production compose scopes the immutable autoheal watcher to Aries only', () => {
  const app = composeServiceBlock('aries-app');
  const autoheal = composeServiceBlock('aries-autoheal');

  assert.match(app, /labels:\n\s+com\.delicioushouse\.aries\.autoheal: "true"/);
  assert.doesNotMatch(app, /\n\s+autoheal: "true"/);
  assert.match(
    autoheal,
    /image: willfarrell\/autoheal:1\.2\.0@sha256:31f580ef0279eaced5b38d631b08c474d70d8403c1c2fdd6ddcf2e879d5f3f7c/,
  );
  assert.match(
    autoheal,
    /labels:\n\s+com\.delicioushouse\.aries\.autoheal\.watcher: "true"/,
  );
  assert.match(
    autoheal,
    /AUTOHEAL_CONTAINER_LABEL: com\.delicioushouse\.aries\.autoheal/,
  );
  assert.match(autoheal, /AUTOHEAL_CONTAINER_LABEL_VALUE: "true"/);
  assert.match(autoheal, /AUTOHEAL_INTERVAL: 30/);
  assert.match(autoheal, /AUTOHEAL_MAX_RESTARTS_PER_WINDOW: 3/);
  assert.match(autoheal, /AUTOHEAL_RESTART_WINDOW_SECONDS: 900/);
  assert.match(autoheal, /entrypoint: \["\/bin\/sh", "\/usr\/local\/bin\/aries-autoheal\.sh"\]/);
  assert.match(autoheal, /\.\/scripts\/aries-autoheal\.sh:\/usr\/local\/bin\/aries-autoheal\.sh:ro/);
  assert.match(autoheal, /aries-autoheal-state:\/var\/lib\/aries-autoheal/);
  assert.match(autoheal, /- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(autoheal, /restart: unless-stopped/);
});

test('always-unhealthy policy stops restarting at the window cap and retries after cooldown', () => {
  assert.equal(existsSync(autohealScriptPath), true, 'expected bounded autoheal policy script');

  const stateDir = mkdtempSync(path.join(PROJECT_ROOT, '.aries-autoheal-policy-'));
  const shellStateDir = path.relative(PROJECT_ROOT, stateDir).split(path.sep).join('/');
  const containerId = 'a'.repeat(64);
  const policyEnv = {
    ...process.env,
    AUTOHEAL_STATE_DIR: shellStateDir,
    AUTOHEAL_MAX_RESTARTS_PER_WINDOW: '3',
    AUTOHEAL_RESTART_WINDOW_SECONDS: '900',
  };
  const runPolicy = (command: '--decision' | '--record', now: number) => {
    const result = spawnSync(
      'sh',
      [autohealScriptPath, command, containerId, String(now)],
      { cwd: PROJECT_ROOT, env: policyEnv, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };

  try {
    for (const now of [1_000, 1_001, 1_002]) {
      assert.equal(runPolicy('--decision', now), 'restart');
      runPolicy('--record', now);
    }

    assert.equal(
      runPolicy('--decision', 1_003),
      'suppressed',
      'a persistently unhealthy container must stay unhealthy after the bounded budget',
    );
    assert.equal(
      runPolicy('--decision', 2_000),
      'restart',
      'the watcher may try again after the cooldown window expires',
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('production deploy starts autoheal before the web container and treats its image separately', () => {
  const autohealStart =
    'docker compose up -d --no-deps --force-recreate --pull always aries-autoheal';
  const autohealStartIndex = deploySource.indexOf(autohealStart);
  const appStartIndex = deploySource.indexOf(
    'ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose pull "${SERVICE_NAME}"',
  );

  assert.notEqual(autohealStartIndex, -1, 'deploy should force-recreate the autoheal sidecar');
  assert.notEqual(appStartIndex, -1, 'deploy should retain the app image pull');
  assert.ok(
    autohealStartIndex < appStartIndex,
    'autoheal should be running before the web container is recreated',
  );
  assert.match(
    deploySource,
    /\[\[ "\$\{worker_service\}" == "aries-autoheal" \]\] && continue/,
    'the app-image parity loop must not compare autoheal to the Aries image',
  );
  assert.match(
    deployParitySource,
    /const recreateExemptServices: string\[\] = \['aries-autoheal'\]/,
    'the manifest parity test should exempt the separately deployed external image',
  );
});
