import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const distComposePath = path.join(repoRoot, 'dist', 'docker-compose.yml');
const distComposeSource = fs.readFileSync(distComposePath, 'utf8');

test('tracked dist deploy shim requires an explicit prebuilt Aries image and cannot build stale sources', () => {
  assert.match(
    distComposeSource,
    /image:\s*\$\{ARIES_APP_IMAGE:\?Set ARIES_APP_IMAGE to a root-built Aries image tag\}/,
  );
  assert.doesNotMatch(distComposeSource, /^\s*build:\s*/m);
  assert.doesNotMatch(distComposeSource, /^\s*-\s+\.\:\/app\/aries-app\s*$/m);
});

test('tracked dist deploy shim uses the canonical runtime lobster cwd defaults', () => {
  assert.match(distComposeSource, /OPENCLAW_LOBSTER_CWD:\s*\$\{OPENCLAW_LOBSTER_CWD:-\/app\/lobster\}/);
  assert.match(
    distComposeSource,
    /OPENCLAW_LOCAL_LOBSTER_CWD:\s*\$\{OPENCLAW_LOCAL_LOBSTER_CWD:-\/app\/lobster\}/,
  );
});

test('tracked dist deploy shim cannot reintroduce the stale public onboarding path', () => {
  assert.doesNotMatch(distComposeSource, /\/onboarding\/start/);
});
