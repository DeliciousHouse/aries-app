import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildIntegrationsPageData, handleIntegrationsGet } from '../app/api/integrations/handlers';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousStatusPublic = process.env.MARKETING_STATUS_PUBLIC;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-integrations-public-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.MARKETING_STATUS_PUBLIC = '1';

  try {
    return await run();
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousStatusPublic === undefined) delete process.env.MARKETING_STATUS_PUBLIC;
    else process.env.MARKETING_STATUS_PUBLIC = previousStatusPublic;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/integrations does not fall back to public latest-tenant data', async () => {
  await withRuntimeEnv(async () => {
    const response = await handleIntegrationsGet(async () => {
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as { status: string; reason: string };

    assert.equal(response.status, 403);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');
  });
});

test('buildIntegrationsPageData stays callable as an async compatibility wrapper', async () => {
  const body = await buildIntegrationsPageData('');

  assert.equal(body.status, 'ok');
  assert.equal(Array.isArray(body.cards), true);
});

// ---------------------------------------------------------------------------
// AA-217 v2 — the publish_policy TRANSPORT.
//
// This payload is the only way `ARIES_ANY_PLATFORM_PUBLISH_ENABLED` reaches the
// dashboard's Generate gate and the weekly intake form; neither can read a
// server flag. The two ends are joined by a field NAME, not by a shared type, so
// a rename on either side would silently revert both clients to legacy Meta-only
// copy with nothing failing. These tests are that missing compile-time link.
// ---------------------------------------------------------------------------

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const withPublishFlag = <T>(value: string | undefined, run: () => Promise<T>) =>
  withEnv({ ARIES_ANY_PLATFORM_PUBLISH_ENABLED: value }, run);

test('/api/integrations emits publish_policy, and it tracks the server flag', async () => {
  const off = await withPublishFlag('0', () => buildIntegrationsPageData(''));
  assert.equal(off.publish_policy?.any_platform_publish_enabled, false, 'flag off => false, not absent');
  assert.equal(Array.isArray(off.publish_policy?.publishable_platforms), true);
  assert.ok(
    off.publish_policy!.publishable_platforms.includes('facebook')
      && off.publish_policy!.publishable_platforms.includes('instagram'),
    'the Meta pair is always publishable',
  );

  const on = await withPublishFlag('1', () => buildIntegrationsPageData(''));
  assert.equal(on.publish_policy?.any_platform_publish_enabled, true);
  assert.ok(
    !on.publish_policy!.publishable_platforms.includes('linkedin'),
    'an unconfigured crosspost platform is not publishable, whatever the publish flag says',
  );

  const linkedInReady = await withEnv(
    {
      ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1',
      ARIES_LINKEDIN_ENABLED: 'true',
      COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
    },
    () => buildIntegrationsPageData(''),
  );
  assert.ok(
    linkedInReady.publish_policy!.publishable_platforms.includes('linkedin'),
    'a configured crosspost platform IS published as publishable',
  );
});

test('publish_policy from the real payload flips the dashboard Generate gate', async () => {
  const { createDashboardHomeViewModel } = await import('@/frontend/aries-v1/view-models/dashboard-home');
  const linkedInOnly = [
    {
      platform: 'linkedin',
      display_name: 'LinkedIn',
      connection_state: 'connected',
      available_actions: ['disconnect'],
    },
  ] as never;
  const viewModel = (publishPolicy: unknown) =>
    createDashboardHomeViewModel({
      posts: [],
      reviews: [],
      profile: { incomplete: false } as never,
      integrationCards: linkedInOnly,
      publishPolicy: publishPolicy as never,
    }).generateThisWeek;

  const off = await withPublishFlag('0', () => buildIntegrationsPageData(''));
  assert.equal(
    viewModel(off.publish_policy).gate,
    'no_meta_connection',
    'flag off => the legacy Meta-only verdict and copy, unchanged',
  );

  const on = await withEnv(
    {
      ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1',
      ARIES_LINKEDIN_ENABLED: 'true',
      COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
    },
    () => buildIntegrationsPageData(''),
  );
  assert.equal(
    viewModel(on.publish_policy).enabled,
    true,
    'flag on + LinkedIn publishable => the tenant is unblocked, proving the field names still line up',
  );

  // Flag on but LinkedIn not deliverable on this deployment: still blocked, but
  // with the channel-neutral copy rather than "connect Facebook or Instagram".
  const onUnconfigured = await withPublishFlag('1', () => buildIntegrationsPageData(''));
  assert.equal(viewModel(onUnconfigured.publish_policy).gate, 'channel_not_connected');

  // A payload from an older server carries no policy at all: legacy behaviour.
  assert.equal(viewModel(undefined).gate, 'no_meta_connection');
});
