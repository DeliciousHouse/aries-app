import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('assertMarketingRuntimeSchemas resolves the repo spec when CODE_ROOT assumes the container root', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;

  process.env.CODE_ROOT = '/app';

  try {
    const { describeSpecResolution } = await import('../lib/runtime-paths');
    const { assertMarketingRuntimeSchemas } = await import('../backend/marketing/runtime-state');
    const resolution = describeSpecResolution('marketing_job_state_schema.v1.json');

    assert.equal(
      resolution.resolvedSpecPath,
      path.join(PROJECT_ROOT, 'specs', 'marketing_job_state_schema.v1.json'),
    );
    assert.equal(resolution.requestedCodeRoot, '/app');
    assert.equal(resolution.triedSpecPaths.includes('/app/specs/marketing_job_state_schema.v1.json'), true);
    assert.equal(resolution.triedSpecPaths.includes('/app/aries-app/specs/marketing_job_state_schema.v1.json'), true);
    assert.doesNotThrow(() => assertMarketingRuntimeSchemas());
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
  }
});
