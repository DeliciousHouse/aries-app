/**
 * Unit tests for resolveLinkedInAuthorUrn (#645).
 *
 * Locked behaviors:
 *  - Direct data shape  → { urn, name }
 *  - Wrapper/batch shape → { urn, name } (second toolkit-version format)
 *  - !successful        → null  (never invents a URN)
 *  - Missing / empty id → null
 *  - Wrapper inner !successful → null
 *  - Slug override via COMPOSIO_LINKEDIN_ACCOUNT_INFO_ACTION
 *
 * Entirely self-contained: fake gateway + config, no Postgres, no Composio SDK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLinkedInAuthorUrn,
  DEFAULT_GET_MY_INFO_SLUG,
} from '@/backend/integrations/composio/linkedin-author-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

// ── 1. Direct shape (flat data object with id on data) ───────────────────────

test('direct shape: resolves urn + full localized name', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { id: 'abc123', localizedFirstName: 'Jane', localizedLastName: 'Doe' },
    },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.deepEqual(result, { urn: 'urn:li:person:abc123', name: 'Jane Doe' });
});

test('direct shape: uses DEFAULT_GET_MY_INFO_SLUG and passes connectedAccountId', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'abc123' } },
  });
  await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_42');
  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  assert.equal(gateway.calls[0].slug, DEFAULT_GET_MY_INFO_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_li_42');
});

test('honors COMPOSIO_LINKEDIN_ACCOUNT_INFO_ACTION action-slug override', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'abc123' } },
  });
  await resolveLinkedInAuthorUrn(
    gateway,
    fakeConfig({ actions: { account_info: 'CUSTOM_LINKEDIN_INFO_V2' } }),
    'ca_li_1',
  );
  assert.equal(gateway.calls[0].slug, 'CUSTOM_LINKEDIN_INFO_V2');
});

// ── 2. Wrapper / batch shape ─────────────────────────────────────────────────

test('wrapper shape: resolves URN from results[0].response.data.id', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: {
        results: [
          {
            response: {
              successful: true,
              data: { id: 'xyz789', localizedFirstName: 'Bob', localizedLastName: 'Smith' },
            },
          },
        ],
      },
    },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_2');
  assert.equal(result?.urn, 'urn:li:person:xyz789');
  assert.equal(result?.name, 'Bob Smith');
});

test('wrapper shape: successful:false on inner response → null (never invents URN)', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: {
        results: [
          {
            response: {
              successful: false,
              data: { id: 'xyz789' },
            },
          },
        ],
      },
    },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_2');
  assert.equal(result, null);
});

// ── 3. Fail-safe: must return null, never invent a URN ───────────────────────

test('unsuccessful top-level result → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: false, error: 'unauthorized', data: null },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.equal(result, null);
});

test('successful result but data is null → null', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: null } });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.equal(result, null);
});

test('successful result but data is empty object (no id) → null', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: {} } });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.equal(result, null);
});

test('successful result but id is a blank string → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: '   ' } },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.equal(result, null);
});

test('successful result with id but no name fields → name is null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'minimal_id' } },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.equal(result?.urn, 'urn:li:person:minimal_id');
  assert.equal(result?.name, null);
});

// ── 4. URN format: always full urn:li:person:<id> ────────────────────────────

test('URN is always the full urn:li:person:<id> prefix (never a bare id)', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'rawid99' } },
  });
  const result = await resolveLinkedInAuthorUrn(gateway, fakeConfig(), 'ca_li_1');
  assert.ok(result?.urn.startsWith('urn:li:person:'), 'urn must include the urn:li:person: prefix');
  assert.equal(result?.urn, 'urn:li:person:rawid99');
});
