/**
 * Regression coverage for #645: LinkedIn connect resolves + persists the member
 * person URN behind ARIES_LINKEDIN_ENABLED.
 *
 * Locked behaviors:
 *  1. Flag ON + active LinkedIn conn (direct data shape) → URN persisted in
 *     external_account_id; LINKEDIN_GET_MY_INFO called exactly once.
 *  2. Flag ON + wrapper-nested id shape → URN persisted correctly.
 *  3. Flag OFF (default) → NO executeTool call; external_account_id null;
 *     connect path byte-identical to pre-fix.
 *  4. Flag ON but executeTool returns unsuccessful → connect still succeeds
 *     (fail-soft), row upserted, external_account_id null, no throw.
 *  5. Platform isolation: LINKEDIN_GET_MY_INFO is NOT called for a facebook conn.
 *
 * Self-contained: fake gateway/config/db, no real Postgres, no Composio SDK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import type { GatewayConnection } from '@/backend/integrations/composio/composio-client';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';
const userId = 'aries-tenant-42';

/**
 * An active LinkedIn GatewayConnection whose externalAccountId is null — which
 * mirrors the real Composio payload and is the precondition that triggers the
 * LinkedIn URN-resolve branch (`!externalAccountId && platform === 'linkedin'`).
 */
function linkedInConn(id: string, status = 'ACTIVE'): GatewayConnection {
  return {
    id,
    status,
    statusReason: null,
    authConfigId: 'auth_cfg_linkedin',
    toolkitSlug: 'linkedin',
    externalAccountId: null, // real Composio metadata lacks the member id
    externalAccountName: null,
    raw: {},
  };
}

/**
 * Set/restore a subset of process.env keys around an async callback.
 * Pass `undefined` as the value to delete the key during the callback.
 */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return fn().finally(() => {
    for (const [k, original] of prev) {
      if (original === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original;
      }
    }
  });
}

// ── 1. Flag ON: URN resolved and persisted (direct data shape) ───────────────

test('flag ON + active linkedin conn: LINKEDIN_GET_MY_INFO called + URN persisted', async () => {
  // FAILS before the fix: no LinkedIn branch → no executeTool call,
  // external_account_id stays null.
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, async () => {
    const gateway = fakeGateway({
      connections: [linkedInConn('ca_li_1')],
      executeResult: {
        successful: true,
        error: null,
        data: { id: 'abc123', localizedFirstName: 'Jane', localizedLastName: 'Doe' },
      },
    });
    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    await provider.refreshConnectionStatus(userId, 'linkedin', { tenantId });

    // Exactly one LINKEDIN_GET_MY_INFO call, for the right connectedAccountId
    const liCalls = gateway.calls.filter((c) => c.slug === 'LINKEDIN_GET_MY_INFO');
    assert.equal(liCalls.length, 1, 'must call LINKEDIN_GET_MY_INFO exactly once');
    assert.equal(liCalls[0].options.connectedAccountId, 'ca_li_1');

    // external_account_id is $7 (params[6]) in the INSERT
    const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
    assert.ok(upsert, 'expected an INSERT upsert query');
    assert.equal(
      upsert!.params[6],
      'urn:li:person:abc123',
      'external_account_id must be the full urn:li:person:<id>',
    );
  });
});

// ── 2. Wrapper-nested id shape ────────────────────────────────────────────────

test('flag ON + wrapper-nested id shape: URN persisted from results[0].response.data.id', async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, async () => {
    const gateway = fakeGateway({
      connections: [linkedInConn('ca_li_2')],
      executeResult: {
        successful: true,
        error: null,
        data: {
          results: [
            {
              response: {
                successful: true,
                data: { id: 'xyz789' },
              },
            },
          ],
        },
      },
    });
    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    await provider.refreshConnectionStatus(userId, 'linkedin', { tenantId });

    const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
    assert.ok(upsert, 'expected an INSERT upsert query');
    assert.equal(
      upsert!.params[6],
      'urn:li:person:xyz789',
      'external_account_id must be resolved from the wrapper shape',
    );
  });
});

// ── 3. Flag OFF: dormant — no executeTool, external_account_id null ──────────

test('flag OFF (default): no LINKEDIN_GET_MY_INFO call, external_account_id null', async () => {
  // Pre-fix AND post-fix with flag OFF must be byte-identical: no extra call,
  // no URN in the row.
  await withEnv({ ARIES_LINKEDIN_ENABLED: undefined }, async () => {
    const gateway = fakeGateway({
      connections: [linkedInConn('ca_li_3')],
      // This result must never be consumed:
      executeResult: {
        successful: true,
        error: null,
        data: { id: 'should_not_be_used' },
      },
    });
    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    await provider.refreshConnectionStatus(userId, 'linkedin', { tenantId });

    const liCalls = gateway.calls.filter((c) => c.slug === 'LINKEDIN_GET_MY_INFO');
    assert.equal(liCalls.length, 0, 'LINKEDIN_GET_MY_INFO must NOT be called when flag is off');

    const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
    assert.ok(upsert, 'expected an INSERT upsert query');
    assert.equal(
      upsert!.params[6],
      null,
      'external_account_id must be null when ARIES_LINKEDIN_ENABLED is off',
    );
  });
});

test('flag OFF via false string: still dormant', async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: 'false' }, async () => {
    const gateway = fakeGateway({ connections: [linkedInConn('ca_li_3')] });
    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    await provider.refreshConnectionStatus(userId, 'linkedin', { tenantId });

    const liCalls = gateway.calls.filter((c) => c.slug === 'LINKEDIN_GET_MY_INFO');
    assert.equal(liCalls.length, 0, 'LINKEDIN_GET_MY_INFO must NOT be called when flag is false');
  });
});

// ── 4. Fail-soft: unsuccessful executeTool → connect still succeeds ──────────

test('flag ON but executeTool unsuccessful: connect succeeds, external_account_id null', async () => {
  // The best-effort try/catch must never surface the failure to the caller.
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, async () => {
    const gateway = fakeGateway({
      connections: [linkedInConn('ca_li_4')],
      executeResult: { successful: false, error: 'scope_missing', data: null },
    });
    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);

    // Must not throw
    const result = await provider.refreshConnectionStatus(userId, 'linkedin', { tenantId });
    assert.ok(result, 'refreshConnectionStatus must return a ConnectedAccount on resolver failure');

    const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
    assert.ok(upsert, 'row must still be upserted (connect must not be blocked)');
    // The connected_account_id ($5 = params[4]) must be persisted
    assert.equal(upsert!.params[4], 'ca_li_4', 'connected_account_id must still be stored');
    // external_account_id ($7 = params[6]) must be null
    assert.equal(
      upsert!.params[6],
      null,
      'external_account_id must be null when resolver fails',
    );
  });
});

test('flag ON but executeTool throws: connect still succeeds (best-effort catch)', async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, async () => {
    // Override executeTool to throw synchronously
    const gateway = fakeGateway({ connections: [linkedInConn('ca_li_5')] });
    // Patch the gateway's executeTool to throw
    const origExecute = gateway.executeTool.bind(gateway);
    gateway.executeTool = async (slug, opts) => {
      if (slug === 'LINKEDIN_GET_MY_INFO') throw new Error('network timeout');
      return origExecute(slug, opts);
    };

    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);

    const result = await provider.refreshConnectionStatus(userId, 'linkedin', { tenantId });
    assert.ok(result, 'connect must not throw when executeTool throws');

    const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
    assert.ok(upsert, 'row must be upserted even when executeTool throws');
    assert.equal(upsert!.params[6], null, 'external_account_id null on thrown error');
  });
});

// ── 5. Platform isolation: LINKEDIN_GET_MY_INFO not called for other platforms ─

test('flag ON: LINKEDIN_GET_MY_INFO NOT called for a facebook connection', async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, async () => {
    const fbConn: GatewayConnection = {
      id: 'ca_fb_1',
      status: 'ACTIVE',
      statusReason: null,
      authConfigId: 'auth_cfg_fb',
      toolkitSlug: 'facebook',
      externalAccountId: null,
      externalAccountName: null,
      raw: {},
    };
    // executeTool will be called by the FB page-resolver (different slug), not LinkedIn
    const gateway = fakeGateway({
      connections: [fbConn],
      executeResult: {
        successful: true,
        error: null,
        data: { data: [{ id: 'P1', name: 'Test Page' }] },
      },
    });
    const db = fakeDb();
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    await provider.refreshConnectionStatus(userId, 'facebook', { tenantId });

    const liCalls = gateway.calls.filter((c) => c.slug === 'LINKEDIN_GET_MY_INFO');
    assert.equal(
      liCalls.length,
      0,
      'LINKEDIN_GET_MY_INFO must never be called for a facebook connection',
    );
  });
});
