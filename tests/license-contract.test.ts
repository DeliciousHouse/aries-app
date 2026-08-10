import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

test('repository legal files and metadata stay aligned with Apache-2.0', () => {
  const license = readRepoFile('LICENSE');
  const licenseHash = createHash('sha256').update(license).digest('hex');

  // Official text: https://www.apache.org/licenses/LICENSE-2.0.txt
  assert.equal(licenseHash, 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');

  assert.equal(
    readRepoFile('NOTICE'),
    [
      'Aries AI',
      'Copyright 2026 Sugar & Leather, LLC',
      '',
      'This product includes software developed by Sugar & Leather, LLC',
      '(https://sugarandleather.com).',
      '',
    ].join('\n'),
  );

  const packageJson = JSON.parse(readRepoFile('package.json')) as { license?: string };
  const packageLock = JSON.parse(readRepoFile('package-lock.json')) as {
    packages?: Record<string, { license?: string }>;
  };
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal(packageLock.packages?.['']?.license, 'Apache-2.0');
});

test('contributor policy documents the approved SPDX header scope', () => {
  const contributing = readRepoFile('CONTRIBUTING.md');

  assert.match(contributing, /new human-authored source files use `SPDX-License-Identifier: Apache-2\.0`/i);
  assert.match(contributing, /when the file format safely supports comments/i);
  assert.match(contributing, /existing files are not bulk-(?:updated|churned)/i);

  for (const excluded of [
    'generated',
    'vendored',
    'minified',
    'binary/media',
    'lock',
    'fixture',
    'cannot safely carry comments',
  ]) {
    assert.match(contributing, new RegExp(excluded, 'i'));
  }

  assert.match(contributing, /third-party notices and license texts are preserved/i);
  assert.match(contributing, /SPDX identifier never replaces required third-party attribution/i);
});
