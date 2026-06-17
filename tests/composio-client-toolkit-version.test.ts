import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToolExecuteOptions,
  createComposioGateway,
} from '@/backend/integrations/composio/composio-client';
import type { ComposioConfig } from '@/backend/integrations/composio/composio-config';

// ── buildToolExecuteOptions (pure) ──────────────────────────────────────────────
// This is exactly the params object the gateway hands to composio.tools.execute,
// which the @composio/core SDK rejects without a toolkit version.

test('default (no configured version) → version="latest" + dangerouslySkipVersionCheck', () => {
  const out = buildToolExecuteOptions({ connectedAccountId: 'ca_1', arguments: { a: 1 } });
  assert.equal(out.version, 'latest');
  assert.equal(out.dangerouslySkipVersionCheck, true);
  assert.equal(out.connectedAccountId, 'ca_1');
  assert.deepEqual(out.arguments, { a: 1 });
});

test('a pinned concrete version is passed as-is with NO skip flag', () => {
  const out = buildToolExecuteOptions({ connectedAccountId: 'ca_1' }, '20250909_00');
  assert.equal(out.version, '20250909_00');
  assert.equal(out.dangerouslySkipVersionCheck, undefined);
});

test('explicit "latest" (any case) still pairs with the skip flag', () => {
  assert.equal(buildToolExecuteOptions({}, 'latest').dangerouslySkipVersionCheck, true);
  assert.equal(buildToolExecuteOptions({}, 'LATEST').dangerouslySkipVersionCheck, true);
});

test('blank/whitespace version falls back to latest', () => {
  const out = buildToolExecuteOptions({}, '   ');
  assert.equal(out.version, 'latest');
  assert.equal(out.dangerouslySkipVersionCheck, true);
});

// ── executeTool wiring (asserts the arg the real client receives) ───────────────

function configWith(toolkitVersion?: string): ComposioConfig {
  return {
    apiKey: 'test-key',
    toolkitVersion,
    authConfigIdFor: () => null,
    toolkitSlugFor: (p) => p,
    actionSlugFor: () => null,
  };
}

/** A fake @composio/core client recording the tools.execute call. */
function fakeClient() {
  const calls: Array<{ slug: string; options: Record<string, unknown> }> = [];
  const client = {
    tools: {
      async execute(slug: string, options: Record<string, unknown>) {
        calls.push({ slug, options });
        return { data: { ok: true }, successful: true, error: null };
      },
    },
  };
  return { client, calls };
}

test('executeTool forwards version + dangerouslySkipVersionCheck to composio.tools.execute (latest default)', async () => {
  const { client, calls } = fakeClient();
  const gateway = createComposioGateway(
    configWith('latest'),
    async () => client as unknown as import('@composio/core').Composio,
  );

  const res = await gateway.executeTool('FACEBOOK_LIST_MANAGED_PAGES', {
    connectedAccountId: 'ca_live',
    arguments: { user_id: 'me' },
  });

  assert.equal(res.successful, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, 'FACEBOOK_LIST_MANAGED_PAGES');
  // The fix: the SDK call carries a toolkit version (else "Toolkit version not specified").
  assert.equal(calls[0].options.version, 'latest');
  assert.equal(calls[0].options.dangerouslySkipVersionCheck, true);
  assert.equal(calls[0].options.connectedAccountId, 'ca_live');
  assert.deepEqual(calls[0].options.arguments, { user_id: 'me' });
});

test('executeTool forwards a pinned concrete version (no skip flag)', async () => {
  const { client, calls } = fakeClient();
  const gateway = createComposioGateway(
    configWith('20250909_00'),
    async () => client as unknown as import('@composio/core').Composio,
  );

  await gateway.executeTool('FACEBOOK_CREATE_POST', { connectedAccountId: 'ca_1', arguments: { message: 'hi' } });

  assert.equal(calls[0].options.version, '20250909_00');
  assert.equal(calls[0].options.dangerouslySkipVersionCheck, undefined);
});
