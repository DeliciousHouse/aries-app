import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GET as getOnboardingStatus } from '../app/api/onboarding/status/[tenantId]/route';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const statusScreenSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'onboarding', 'status.tsx'),
  'utf8',
);
const statusRouteSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'api', 'onboarding', 'status', '[tenantId]', 'route.ts'),
  'utf8',
);

test('/api/onboarding/status maps request success separately from tenant existence for not-found tenants', async () => {
  const oldDataRoot = process.env.DATA_ROOT;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'aries-onboarding-status-not-found-'));

  try {
    process.env.DATA_ROOT = dataRoot;

    const response = await getOnboardingStatus(
      new Request('http://localhost/api/onboarding/status/tenant_missing'),
      { params: Promise.resolve({ tenantId: 'tenant_missing' }) },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.request_status, 'ok');
    assert.equal(body.onboarding_status, 'ok');
    assert.equal(body.provisioning_status, 'not_found');
    assert.equal(body.progress_hint, 'not_started');
    assert.deepEqual(body.artifacts, {
      draft: false,
      validated: false,
      validation_report: false,
      idempotency_marker: false,
    });
  } finally {
    if (oldDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = oldDataRoot;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('onboarding status screen labels not-found tenants without a top-level OK badge', () => {
  assert.match(statusRouteSource, /request_status: 'ok'/, 'status API should expose request success explicitly');
  assert.match(statusScreenSource, /const tenantNotFound = success\?\.provisioning_status === 'not_found'/);
  assert.match(statusScreenSource, /Tenant not found/);
  assert.match(statusScreenSource, /The status request succeeded, but Aries could not find onboarding artifacts for this tenant ID yet\./);
  assert.match(statusScreenSource, /<strong>request_status<\/strong>[\s\S]*?Request succeeded/);
  assert.match(statusScreenSource, /<strong>tenant_status<\/strong>[\s\S]*?<StatusBadge status="not_found" \/>/);
  assert.match(statusScreenSource, /tenantNotFound \? \([\s\S]*?<strong>tenant_status<\/strong>[\s\S]*?\) : \([\s\S]*?<strong>onboarding_status<\/strong>/);
});
