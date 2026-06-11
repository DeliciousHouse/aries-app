import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSlackConfigForTenant } from '../backend/integrations/slack/config-store';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A pool stub that returns one notify_channel_id row (or none) and records queries. */
function chanPool(channelId: string | null): {
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> };
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return channelId
        ? { rowCount: 1, rows: [{ notify_channel_id: channelId }] }
        : { rowCount: 0, rows: [] };
    },
  };
  return { pool, queries };
}

const tokenOk = async () => ({ accessToken: 'xoxb-tenant', connectionId: 'c1', externalAccountId: null });
const tokenNull = async () => null;

// ── loadSlackConfigForTenant ───────────────────────────────────────────────────

test('present: per-tenant token + channel resolves the per-tenant config', async () => {
  const { pool, queries } = chanPool('C0TENANT');
  const res = await loadSlackConfigForTenant(15, { pool: pool as never, getToken: tokenOk, env: {} });
  assert.deepEqual(res, { botToken: 'xoxb-tenant', channel: 'C0TENANT' });
  // Exactly one channel SELECT, status-filtered, parameterized on the numeric tenant.
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /status = 'connected'/);
  assert.match(queries[0].sql, /provider = 'slack'/);
  assert.deepEqual(queries[0].params, [15]);
});

test('absent: no connection and no env opt-in resolves to null without a channel query', async () => {
  const { pool, queries } = chanPool(null);
  const res = await loadSlackConfigForTenant(15, { pool: pool as never, getToken: tokenNull, env: {} });
  assert.equal(res, null);
  // Token gate short-circuits before the channel SELECT.
  assert.equal(queries.length, 0, 'no channel query when there is no per-tenant token');
});

test('env opt-in: no per-tenant config but both env vars set resolves the global config', async () => {
  const { pool } = chanPool(null);
  const res = await loadSlackConfigForTenant(15, {
    pool: pool as never,
    getToken: tokenNull,
    env: { SLACK_SINGLE_TENANT_CHANNEL: 'C0GLOBAL', SLACK_BOT_TOKEN: 'xoxb-global' },
  });
  assert.deepEqual(res, { botToken: 'xoxb-global', channel: 'C0GLOBAL' });
});

test('env opt-in requires BOTH the channel and the token', async () => {
  const { pool } = chanPool(null);
  const res = await loadSlackConfigForTenant(15, {
    pool: pool as never,
    getToken: tokenNull,
    env: { SLACK_BOT_TOKEN: 'xoxb-global' }, // channel missing
  });
  assert.equal(res, null);
});

test('decrypt-fail (getToken returns null) falls through to null', async () => {
  // getDecryptedAccessTokenContextForTenantProvider returns null on decrypt failure;
  // the resolver treats that identically to "no connection" — fail-open to no-config.
  const { pool } = chanPool('C0TENANT');
  const res = await loadSlackConfigForTenant(15, { pool: pool as never, getToken: tokenNull, env: {} });
  assert.equal(res, null);
});

test('missing channel with a valid token falls through (never returns a partial config)', async () => {
  const { pool } = chanPool(null);
  const res = await loadSlackConfigForTenant(15, { pool: pool as never, getToken: tokenOk, env: {} });
  assert.equal(res, null, 'must not return { botToken, channel:"" }');
});

test('missing channel + valid tenant token + env opt-in: global wins (tenant token never mixed with global channel)', async () => {
  const { pool } = chanPool(null);
  const res = await loadSlackConfigForTenant(15, {
    pool: pool as never,
    getToken: tokenOk,
    env: { SLACK_SINGLE_TENANT_CHANNEL: 'C0GLOBAL', SLACK_BOT_TOKEN: 'xoxb-global' },
  });
  assert.deepEqual(res, { botToken: 'xoxb-global', channel: 'C0GLOBAL' });
});

test('null tenantId skips the per-tenant path and uses the env opt-in', async () => {
  let getTokenCalled = false;
  const getToken = async () => {
    getTokenCalled = true;
    return null;
  };
  const res = await loadSlackConfigForTenant(null, {
    getToken,
    env: { SLACK_SINGLE_TENANT_CHANNEL: 'C0G', SLACK_BOT_TOKEN: 'xoxb-g' },
  });
  assert.deepEqual(res, { botToken: 'xoxb-g', channel: 'C0G' });
  assert.equal(getTokenCalled, false, 'never resolves a token for a null tenant');
});

test('fail-open: getToken throwing does not throw — falls through to env opt-in', async () => {
  const getToken = async () => {
    throw new Error('db down');
  };
  const res = await loadSlackConfigForTenant(15, {
    getToken,
    env: { SLACK_SINGLE_TENANT_CHANNEL: 'C0G', SLACK_BOT_TOKEN: 'xoxb-g' },
  });
  assert.deepEqual(res, { botToken: 'xoxb-g', channel: 'C0G' });
});

test('fail-open: a throwing channel query does not throw — falls through to env opt-in', async () => {
  const pool = {
    query: async () => {
      throw new Error('channel query failed');
    },
  };
  const res = await loadSlackConfigForTenant(15, {
    pool: pool as never,
    getToken: tokenOk,
    env: { SLACK_SINGLE_TENANT_CHANNEL: 'C0G', SLACK_BOT_TOKEN: 'xoxb-g' },
  });
  assert.deepEqual(res, { botToken: 'xoxb-g', channel: 'C0G' });
});

test('fail-open with no env opt-in: an error resolves to null, never throws', async () => {
  const getToken = async () => {
    throw new Error('db down');
  };
  const res = await loadSlackConfigForTenant(15, { getToken, env: {} });
  assert.equal(res, null);
});
