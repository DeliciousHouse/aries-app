import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const telemetryScripts = ['typecheck', 'lint'];

test('typecheck and lint avoid POSIX-only inline env assignments', () => {
  for (const scriptName of telemetryScripts) {
    const script = packageJson.scripts[scriptName];
    assert.ok(script, `${scriptName} script exists`);
    assert.match(
      script,
      /cross-env NEXT_TELEMETRY_DISABLED=1/,
      `${scriptName} must set NEXT_TELEMETRY_DISABLED with cross-env`,
    );
    assert.doesNotMatch(
      script,
      /(^|&&\s*)[A-Za-z_][A-Za-z0-9_]*=/,
      `${scriptName} must not start with a POSIX-only env assignment`,
    );
  }
});

test('cross-env is pinned as a dev dependency', () => {
  assert.ok(
    packageJson.devDependencies['cross-env'],
    'cross-env must remain a dev dependency so the scripts keep working on Windows',
  );
});
