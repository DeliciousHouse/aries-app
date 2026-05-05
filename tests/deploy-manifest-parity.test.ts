import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const distComposePath = path.join(repoRoot, 'dist', 'docker-compose.yml');

test('legacy dist deploy shim stays out of the tracked runtime surface', () => {
  const trackedDistCompose = execFileSync('git', ['ls-files', '--', distComposePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  assert.equal(trackedDistCompose, '');
});

test('runtime env examples advertise Hermes defaults with legacy OpenClaw opt-in', () => {
  const composeSource = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const envExampleSource = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  assert.match(
    composeSource,
    /ARIES_EXECUTION_PROVIDER:\s*\$\{ARIES_EXECUTION_PROVIDER:-hermes\}/,
  );
  assert.match(
    composeSource,
    /ARIES_MARKETING_EXECUTION_PROVIDER:\s*\$\{ARIES_MARKETING_EXECUTION_PROVIDER:-hermes\}/,
  );
  assert.match(composeSource, /HERMES_GATEWAY_URL:\s*\$\{HERMES_GATEWAY_URL:-\}/);
  assert.match(composeSource, /HERMES_API_SERVER_KEY:\s*\$\{HERMES_API_SERVER_KEY:-\}/);
  assert.match(composeSource, /HERMES_SESSION_KEY:\s*\$\{HERMES_SESSION_KEY:-main\}/);
  assert.match(composeSource, /INTERNAL_API_SECRET:\s*\$\{INTERNAL_API_SECRET\}/);
  assert.doesNotMatch(composeSource, /OPENAI_CLIENT_ID/);
  assert.doesNotMatch(composeSource, /OPENAI_CLIENT_SECRET/);
  assert.match(composeSource, /OAUTH_TOKEN_ENCRYPTION_KEY:\s*\$\{OAUTH_TOKEN_ENCRYPTION_KEY\}/);

  assert.match(envExampleSource, /^ARIES_EXECUTION_PROVIDER=hermes$/m);
  assert.match(envExampleSource, /^ARIES_MARKETING_EXECUTION_PROVIDER=hermes$/m);
  assert.match(envExampleSource, /^# ARIES_EXECUTION_PROVIDER=legacy-openclaw$/m);
  assert.match(envExampleSource, /^# ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw$/m);
  assert.match(envExampleSource, /^HERMES_GATEWAY_URL=/m);
  assert.match(envExampleSource, /^HERMES_API_SERVER_KEY=/m);
  assert.match(envExampleSource, /^HERMES_SESSION_KEY=main$/m);
  assert.doesNotMatch(envExampleSource, /^OPENAI_CLIENT_ID=/m);
  assert.doesNotMatch(envExampleSource, /^OPENAI_CLIENT_SECRET=/m);
  assert.match(envExampleSource, /^OAUTH_TOKEN_ENCRYPTION_KEY=/m);
});

test('legacy dist deploy shim cannot reintroduce the stale public onboarding path', () => {
  if (!fs.existsSync(distComposePath)) {
    assert.ok(true);
    return;
  }

  const distComposeSource = fs.readFileSync(distComposePath, 'utf8');
  assert.doesNotMatch(distComposeSource, /\/onboarding\/start/);
});
