import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

const DISPLAY_FILES = [
  'frontend/marketing/job-status.tsx',
  'frontend/aries-v1/review-item.tsx',
  'frontend/aries-v1/post-workspace.tsx',
];

for (const filePath of DISPLAY_FILES) {
  test(`${filePath}: imports formatInTenantZone`, () => {
    const src = readRepoFile(filePath);
    assert.match(src, /formatInTenantZone/, `${filePath} must import and use formatInTenantZone`);
  });

  test(`${filePath}: does not use bare .toLocaleString() on render path`, () => {
    const src = readRepoFile(filePath);
    assert.doesNotMatch(
      src,
      /new Date\([^)]+\)\.toLocaleString\(\)/,
      `${filePath} must not use bare new Date(...).toLocaleString() — use formatInTenantZone instead`,
    );
  });
}

test('admin debug panel: does not use bare .toLocaleString() on render path', () => {
  const src = readRepoFile('app/admin/marketing/jobs/[jobId]/debug/debug-panel-client.tsx');
  assert.doesNotMatch(
    src,
    /new Date\([^)]+\)\.toLocaleString\(\)/,
    'debug-panel-client must not use bare new Date(...).toLocaleString()',
  );
});

test('admin debug panel: formatTenantTime and formatUtcTime both present for side-by-side display', () => {
  const src = readRepoFile('app/admin/marketing/jobs/[jobId]/debug/debug-panel-client.tsx');
  assert.match(src, /formatTenantTime/, 'debug panel must have formatTenantTime for tenant-zone display');
  assert.match(src, /formatUtcTime/, 'debug panel must keep formatUtcTime for UTC display');
});

test('post workspace publish window uses tenant-zone range helper instead of raw ISO interpolation', () => {
  const src = readRepoFile('frontend/aries-v1/post-workspace.tsx');
  assert.match(src, /formatTenantDateRangeLabel/, 'workspace header must format publish windows in the tenant zone');
  assert.doesNotMatch(
    src,
    /\$\{status\.postWindow\.start\}\s*-\s*\$\{status\.postWindow\.end\}/,
    'workspace header must not expose raw ISO postWindow ranges',
  );
});

test('insights active-times copy names the business timezone when audience timezone differs', () => {
  const src = readRepoFile('frontend/insights/AudienceSection.tsx');
  assert.match(src, /useTenantTimezone/, 'insights must read the same tenant timezone source as Calendar and Publish Status');
  assert.match(src, /business timezone is/, 'insights must explain any audience-data timezone difference');
});
