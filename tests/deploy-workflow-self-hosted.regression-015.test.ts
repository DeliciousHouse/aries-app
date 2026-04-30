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

const prAgentWorkflow = readFileSync(
  path.join(PROJECT_ROOT, '.github', 'workflows', 'pr-agent-autofix-automerge.yml'),
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

test('deploy workflow builds and force-recreates the exact commit image', () => {
  assert.match(
    workflow,
    /if \[\[ "\$\{EVENT_NAME\}" == "push" \]\]; then\s*image_tag="\$\{CURRENT_SHA\}"/,
    'push deploys should target the current commit SHA, not mutable :latest',
  );
  assert.match(
    workflow,
    /- name: Publish exact deploy image[\s\S]*?\.\/scripts\/release\/publish-image\.sh/,
    'deploy workflow should publish the exact target image before trying to pull it on the host',
  );
  assert.match(
    workflow,
    /ARIES_APP_IMAGE="\$\{TARGET_IMAGE\}" docker compose pull "\$\{SERVICE_NAME\}"/,
    'deploy workflow should pull the pinned target image before recreate',
  );
  assert.match(
    workflow,
    /docker compose up -d --no-deps --force-recreate --pull always "\$\{SERVICE_NAME\}"/,
    'deploy workflow should force-recreate the live app so new image and env take effect',
  );
  assert.doesNotMatch(
    workflow,
    /image_tag="latest"/,
    'deploy workflow should not deploy mutable :latest for push events',
  );
});