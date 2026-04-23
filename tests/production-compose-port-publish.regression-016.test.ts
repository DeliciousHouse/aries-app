import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const baseCompose = readFileSync(
  path.join(PROJECT_ROOT, 'docker-compose.yml'),
  'utf8',
);

const localCompose = readFileSync(
  path.join(PROJECT_ROOT, 'docker-compose.local.yml'),
  'utf8',
);

// Regression: deploy uses the base compose file on the host. The production
// port publish therefore has to live in docker-compose.yml rather than only in
// the local override file, or the external reverse proxy loses its upstream.
test('base compose owns the production aries-app port publish', () => {
  const baseAriesApp = baseCompose.match(/services:\n  aries-app:\n[\s\S]*?(?=\nnetworks:|\nvolumes:|$)/);
  assert.ok(baseAriesApp, 'expected to find the base aries-app service definition');
  assert.match(
    baseAriesApp![0],
    /ports:\n\s+- "\$\{PORT:-3000\}:\$\{PORT:-3000\}"/,
    'docker-compose.yml should publish the app port for production deploys',
  );

  const localAriesApp = localCompose.match(/services:\n  aries-app:\n[\s\S]*?(?=\n  aries-app-dev:|$)/);
  assert.ok(localAriesApp, 'expected to find the local override aries-app service block');
  assert.doesNotMatch(
    localAriesApp![0],
    /\n\s+ports:\n/,
    'docker-compose.local.yml should no longer be the only place the production aries-app port is exposed',
  );

  assert.match(
    localCompose,
    /  aries-app-dev:\n[\s\S]*?\n\s+ports:\n\s+- "\$\{PORT:-3000\}:\$\{PORT:-3000\}"/,
    'the optional dev container can still publish the port inside the local override',
  );
});
