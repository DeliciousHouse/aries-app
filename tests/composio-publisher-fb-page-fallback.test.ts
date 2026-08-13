/**
 * AA-243 regression: publishPost's Facebook page-id FALLBACK (the read-only
 * FACEBOOK_LIST_MANAGED_PAGES enumeration that runs when
 * connected_accounts.external_account_id is null) must never leak a raw
 * @composio/core throw out of publishPost.
 *
 * Before the fix, resolveFacebookManagedPage did not catch, the SDK error
 * classes are not in publishNeverReachedPlatform's recognized set, and
 * publishPost has no outer catch — so publish-dispatch raised
 * provider_publish_outcome_unknown (outcomeUnknown:true) and the row parked in
 * manual reconciliation claiming the post MAY be live. It provably is not: the
 * enumeration cannot create a post and runs before any publish call.
 *
 * After the fix the resolver swallows the throw to null and publishPost's own
 * no-page path throws ComposioCapabilityMissingError — a recognized, terminal,
 * definitely-never-posted verdict.
 *
 * Fixtures are the REAL @composio/core error classes, constructed the way the
 * SDK constructs them — never hand-rolled stand-ins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioToolNotFoundError, handleToolExecutionError } from '@composio/core';

import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { ComposioCapabilityMissingError } from '@/backend/integrations/composio/errors';
import { DEFAULT_LIST_MANAGED_PAGES_SLUG } from '@/backend/integrations/composio/facebook-page-resolver';
import { publishNeverReachedPlatform } from '@/backend/integrations/publish-outcome';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';

/** The fakeDb default row, minus the stored page id — forces the fallback. */
function rowWithoutPageId(): Record<string, unknown> {
  return {
    id: 1,
    tenant_id: 42,
    external_user_id: 'aries-tenant-42',
    platform: 'facebook',
    provider: 'composio',
    connected_account_id: 'ca_123',
    auth_config_id: 'auth_cfg_test',
    external_account_id: null,
    external_account_name: null,
    status: 'connected',
    capabilities_json: null,
    last_capability_check_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

/** Each SDK throw shape the un-caught gateway can surface from executeTool. */
const sdkThrows: Array<{ label: string; make: () => Error }> = [
  {
    label: 'ComposioToolNotFoundError (tool-schema retrieve rethrow)',
    make: () =>
      new ComposioToolNotFoundError(
        `Unable to retrieve tool with slug ${DEFAULT_LIST_MANAGED_PAGES_SLUG}`,
        { cause: new Error('getaddrinfo ENOTFOUND backend.composio.dev') },
      ),
  },
  {
    label: 'handleToolExecutionError-produced error (execution transport failure)',
    make: () => handleToolExecutionError(DEFAULT_LIST_MANAGED_PAGES_SLUG, new Error('socket hang up')),
  },
];

for (const { label, make } of sdkThrows) {
  test(`AA-243: a page-id fallback throw [${label}] surfaces as capability-missing (never-posted), not outcome-unknown`, async () => {
    const gateway = fakeGateway({
      onExecute: (rec) => {
        if (rec.slug === DEFAULT_LIST_MANAGED_PAGES_SLUG) throw make();
      },
    });
    const provider = new ComposioPublisherProvider(
      gateway,
      fakeConfig({ actions: { publish_post: 'FB_POST' } }),
      fakeDb({ connectionRow: rowWithoutPageId() }),
    );

    let caught: unknown = null;
    try {
      await provider.publishPost({
        tenantId,
        platform: 'facebook',
        content: 'hello',
        mediaUrls: [],
        approved: true,
      });
      assert.fail('publishPost must reject when the page id cannot be resolved');
    } catch (error) {
      caught = error;
    }

    // The caller's own no-page classification — NOT the leaked SDK error.
    assert.ok(
      caught instanceof ComposioCapabilityMissingError,
      `expected ComposioCapabilityMissingError, got ${String(caught)}`,
    );
    // The verdict the dispatcher acts on: definitely never posted (safe to roll
    // back the claim; no manual_reconciliation parking).
    assert.ok(
      publishNeverReachedPlatform(caught),
      'the failure must classify as definitely-never-posted',
    );
    // Only the read-only page enumeration was attempted — no publish call was
    // ever made, which is what makes never-posted provable here.
    assert.deepEqual(
      gateway.calls.map((c) => c.slug),
      [DEFAULT_LIST_MANAGED_PAGES_SLUG],
      'no publish tool call may be attempted after the fallback fails',
    );
  });
}
