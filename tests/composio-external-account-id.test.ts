import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { toGatewayConnection } from '../backend/integrations/composio/composio-client';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

/** A connection model shaped like the live API: `data` is the OAuth blob. */
function model(toolkitSlug: string, data: Record<string, unknown>) {
  return {
    id: 'ca_1',
    status: 'ACTIVE',
    authConfig: { id: 'ac_1' },
    toolkit: { slug: toolkitSlug },
    data,
  };
}

// ── The wildcard ─────────────────────────────────────────────────────────────

test('AA-242: a bare `id` in the OAuth blob is NOT taken as the account id', () => {
  const conn = toGatewayConnection(
    model('linkedin', {
      status: 'ACTIVE',
      access_token: 'tok',
      id_token: 'eyJhbGciOi...',
      id: 'not-an-account-id',
      scope: 'r_liteprofile',
    }),
  );

  assert.equal(
    conn.externalAccountId,
    null,
    'a bare `id` from the credential blob must never become the account id',
  );
});

test('AA-242: the explicitly account-shaped keys still work', () => {
  // The fix must not blind the mapper to a real value. These keys are named
  // for what they are, so a provider supplying one means it.
  assert.equal(
    toGatewayConnection(model('facebook', { external_account_id: '1234567890' })).externalAccountId,
    '1234567890',
  );
  assert.equal(
    toGatewayConnection(model('facebook', { externalAccountId: '1234567890' })).externalAccountId,
    '1234567890',
  );
  assert.equal(
    toGatewayConnection(model('facebook', { account_id: '1234567890' })).externalAccountId,
    '1234567890',
  );
});

// ── The shape gate ───────────────────────────────────────────────────────────

test('AA-242: a wrong-shaped LinkedIn value is dropped, not persisted', () => {
  // The publisher reads this straight into `author`. A bare id (or anything
  // that is not a person/organization URN) would be sent to LinkedIn as an
  // author, and — because the value is sticky — could never be back-healed.
  const conn = toGatewayConnection(
    model('linkedin', { external_account_id: 'AbC123xyz' }),
  );
  assert.equal(conn.externalAccountId, null, 'a non-URN LinkedIn id must be rejected');
});

test('AA-242: a real LinkedIn person URN is accepted unchanged', () => {
  // The resolver stores the COMPLETE urn:li:person:<id> because the publisher
  // does no reformatting. The gate must not mangle or reject it.
  assert.equal(
    toGatewayConnection(model('linkedin', { external_account_id: 'urn:li:person:AbC123' }))
      .externalAccountId,
    'urn:li:person:AbC123',
  );
  assert.equal(
    toGatewayConnection(model('linkedin', { external_account_id: 'urn:li:organization:99' }))
      .externalAccountId,
    'urn:li:organization:99',
  );
});

test('AA-242: a wrong-shaped Facebook page id is dropped, not persisted', () => {
  const conn = toGatewayConnection(model('facebook', { external_account_id: 'urn:li:person:oops' }));
  assert.equal(conn.externalAccountId, null, 'a non-numeric FB page id must be rejected');
});

test('AA-242: a numeric Facebook page id is accepted', () => {
  assert.equal(
    toGatewayConnection(model('facebook', { external_account_id: '102938475610293' }))
      .externalAccountId,
    '102938475610293',
  );
});

test('AA-242: a platform with no known id shape is left alone', () => {
  // The gate encodes only shapes that are actually known. Inventing a rule for
  // a platform whose identifier format has not been verified would reject valid
  // values — the same "guessing" failure in the other direction.
  assert.equal(
    toGatewayConnection(model('reddit', { external_account_id: 'some_reddit_handle' }))
      .externalAccountId,
    'some_reddit_handle',
  );
});

// ── Why null rather than throw, and why the stickiness matters ────────────────

test('AA-242: rejecting to null leaves the back-heal path OPEN', () => {
  // This is the whole reason the gate prefers null over a thrown error or a
  // persisted value. Both resolver branches are gated on `!externalAccountId`,
  // so null is the state in which repair happens; a wrong value is the state in
  // which repair is permanently suppressed.
  const provider = read('backend', 'integrations', 'composio', 'composio-account-provider.ts');
  assert.match(
    provider,
    /if \(!externalAccountId && platform === 'facebook'/,
    'the FB back-heal must still be gated on a MISSING id',
  );
  assert.match(provider, /!externalAccountId &&\s*\n\s*platform === 'linkedin'/, 'and the LinkedIn one');

  // …and a rejected value really is null, so that gate is reachable.
  assert.equal(
    toGatewayConnection(model('linkedin', { external_account_id: 'AbC123xyz' })).externalAccountId,
    null,
  );
});

test('AA-242: the store still preserves a good stored value against a later null', () => {
  // The COALESCE is correct and must stay: connect can legitimately report null
  // (the id is not in the connection metadata for FB/LinkedIn), and clobbering
  // a resolved URN with that null would break publishing every reconcile.
  // It is only dangerous in combination with a WRONG value, which is what the
  // gate above now prevents.
  const store = read('backend', 'integrations', 'composio', 'connection-store.ts');
  assert.match(
    store,
    /external_account_id = COALESCE\(EXCLUDED\.external_account_id, connected_accounts\.external_account_id\)/,
  );
});

test('AA-242: the key list no longer contains a bare id wildcard', () => {
  // Source-level, because the danger is the LIST, not any one call: a future
  // key added to it is matched against a provider-controlled blob.
  const client = read('backend', 'integrations', 'composio', 'composio-client.ts');
  const list = client.match(/for \(const key of \[([^\]]*)\] of?f?\s*\)|for \(const key of \[([^\]]*)\]\)/);
  assert.ok(list, 'the key list must still be findable');
  const listText = (list[1] ?? list[2] ?? '');
  assert.doesNotMatch(
    listText,
    /'id'/,
    `the bare 'id' wildcard must not be in the account-id key list: ${listText}`,
  );
  assert.match(listText, /'external_account_id'/, 'the explicit keys remain');
});
