import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('production compose labels aries-app for a pinned restart-on-unhealthy sidecar', () => {
  const app = composeServiceBlock('aries-app');
  const autoheal = composeServiceBlock('aries-autoheal');

  assert.match(app, /labels:\n\s+autoheal: "true"/);
  assert.match(autoheal, /image: willfarrell\/autoheal:1\.2\.0/);
  assert.match(autoheal, /AUTOHEAL_CONTAINER_LABEL: autoheal/);
  assert.match(autoheal, /AUTOHEAL_INTERVAL: 30/);
  assert.match(autoheal, /- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(autoheal, /restart: unless-stopped/);
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
