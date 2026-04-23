import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const workflow = readFileSync(
  path.join(PROJECT_ROOT, '.github', 'workflows', 'deploy.yml'),
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
    /- name: Log in to GHCR[\s\S]*?docker\/login-action@v3/,
    'deploy workflow should authenticate the local host Docker daemon to GHCR before pulling the image',
  );
  assert.match(
    workflow,
    /repo_path="\$\{DEPLOY_PATH\}"/,
    'deploy script should operate directly on the local deployment checkout path',
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