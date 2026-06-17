import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchPublish } from '../backend/integrations/publish-dispatch';
import { MetaPublishError } from '../backend/integrations/meta-publishing';
import type { MetaPublishRequest, MetaPublishSuccess } from '../backend/integrations/meta-publishing';
import type { PublisherProvider } from '../backend/integrations/providers/interfaces';
import type { PublishPostInput, PublishResult } from '../backend/integrations/providers/types';
import { ComposioConnectionMissingError, ComposioToolError } from '../backend/integrations/composio/errors';

function baseRequest(overrides: Partial<MetaPublishRequest> = {}): MetaPublishRequest {
  return {
    tenantId: '15',
    provider: 'facebook',
    content: 'caption',
    mediaUrls: ['https://aries.example.com/api/internal/hermes/media/x.png'],
    scheduledFor: null,
    ...overrides,
  };
}

// A PublisherProvider stub that records the publishPost input and returns a fixed result.
function stubProvider(result: PublishResult): { provider: PublisherProvider; calls: PublishPostInput[] } {
  const calls: PublishPostInput[] = [];
  const provider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput) => {
      calls.push(input);
      return result;
    },
  } as unknown as PublisherProvider;
  return { provider, calls };
}

test('direct_meta selector calls publishToMetaGraph directly and returns its result unchanged', async () => {
  const directResult: MetaPublishSuccess = {
    provider: 'facebook',
    mode: 'live',
    platformPostId: 'fb_123',
    scheduledFor: null,
    connectionId: 'conn_oauth_7',
  };
  const directCalls: MetaPublishRequest[] = [];
  let seamUsed = false;

  const out = await dispatchPublish(baseRequest(), {
    selector: () => 'direct_meta',
    directPublish: async (r) => {
      directCalls.push(r);
      return directResult;
    },
    publisherProvider: () => {
      seamUsed = true;
      return stubProvider({} as PublishResult).provider;
    },
  });

  assert.equal(seamUsed, false, 'provider seam must NOT be constructed on the direct path');
  assert.equal(directCalls.length, 1);
  assert.deepEqual(out, directResult, 'direct path is byte-identical to publishToMetaGraph');
});

test('composio selector routes through the seam and maps PublishResult -> MetaPublishSuccess (live)', async () => {
  const { provider, calls } = stubProvider({
    provider: 'composio',
    platform: 'facebook',
    externalPostId: 'fb_999',
    externalCampaignId: null,
    externalAdId: null,
    status: 'published',
    url: 'https://facebook.com/p/fb_999',
    rawResponse: { ok: true },
  });

  const out = await dispatchPublish(baseRequest({ content: 'hello', provider: 'facebook' }), {
    selector: () => 'composio',
    directPublish: async () => {
      throw new Error('direct path must not be used when composio is selected');
    },
    publisherProvider: () => provider,
  });

  // input mapping
  assert.equal(calls.length, 1);
  assert.equal(calls[0].platform, 'facebook');
  assert.equal(calls[0].content, 'hello');
  assert.equal(calls[0].approved, true, 'already-approved dispatch must pass the publish guard');
  assert.equal(calls[0].dryRun, false);

  // result mapping
  assert.equal(out.provider, 'facebook');
  assert.equal(out.mode, 'live');
  assert.equal(out.platformPostId, 'fb_999');
  assert.equal(out.scheduledFor, null);
  assert.equal(out.connectionId, 'composio:facebook');
});

test('composio scheduled result maps to mode=scheduled and preserves scheduledFor', async () => {
  const { provider } = stubProvider({
    provider: 'composio',
    platform: 'instagram',
    externalPostId: 'ig_555',
    externalCampaignId: null,
    externalAdId: null,
    status: 'scheduled',
    url: null,
    rawResponse: {},
  });

  const out = await dispatchPublish(baseRequest({ provider: 'instagram', scheduledFor: '2026-07-01T10:00:00Z' }), {
    selector: () => 'composio',
    publisherProvider: () => provider,
  });

  assert.equal(out.provider, 'instagram');
  assert.equal(out.mode, 'scheduled');
  assert.equal(out.platformPostId, 'ig_555');
  assert.equal(out.scheduledFor, '2026-07-01T10:00:00Z');
});

test('provider string maps to the integration platform (instagram vs facebook fallback)', async () => {
  const { provider, calls } = stubProvider({
    provider: 'composio',
    platform: 'instagram',
    externalPostId: 'ig_1',
    externalCampaignId: null,
    externalAdId: null,
    status: 'published',
    url: null,
    rawResponse: {},
  });

  await dispatchPublish(baseRequest({ provider: 'INSTAGRAM' }), {
    selector: () => 'composio',
    publisherProvider: () => provider,
  });
  assert.equal(calls[0].platform, 'instagram');

  const fb = stubProvider({
    provider: 'composio',
    platform: 'facebook',
    externalPostId: 'fb_1',
    externalCampaignId: null,
    externalAdId: null,
    status: 'published',
    url: null,
    rawResponse: {},
  });
  await dispatchPublish(baseRequest({ provider: 'meta' }), {
    selector: () => 'composio',
    publisherProvider: () => fb.provider,
  });
  assert.equal(fb.calls[0].platform, 'facebook', 'non-instagram provider falls back to facebook');
});

test('a live publish with no post id throws MetaPublishError(outcomeUnknown) — never roll back + retry', async () => {
  const { provider } = stubProvider({
    provider: 'composio',
    platform: 'facebook',
    externalPostId: null,
    externalCampaignId: null,
    externalAdId: null,
    status: 'published',
    url: null,
    rawResponse: {},
  });

  await assert.rejects(
    () =>
      dispatchPublish(baseRequest(), {
        selector: () => 'composio',
        publisherProvider: () => provider,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError, 'must be a MetaPublishError so handlers classify it');
      assert.equal(err.outcomeUnknown, true, 'no-id-after-success is outcome-unknown (no auto-retry)');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('pre-publish errors (missing connection, broker successful:false) propagate unchanged (definitely never posted)', async () => {
  const connErr = new ComposioConnectionMissingError('facebook');
  const connProvider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async () => {
      throw connErr;
    },
  } as unknown as PublisherProvider;
  await assert.rejects(
    () => dispatchPublish(baseRequest(), { selector: () => 'composio', publisherProvider: () => connProvider }),
    (err: unknown) => err === connErr, // unchanged → handlers treat as definitely-never-posted (safe retry)
  );

  const toolErr = new ComposioToolError('FACEBOOK_CREATE_POST', 'tool reported unsuccessful');
  const toolProvider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async () => {
      throw toolErr;
    },
  } as unknown as PublisherProvider;
  await assert.rejects(
    () => dispatchPublish(baseRequest(), { selector: () => 'composio', publisherProvider: () => toolProvider }),
    (err: unknown) => err === toolErr,
  );
});

test('an unexpected transport failure mid-publish becomes MetaPublishError(outcomeUnknown) — the post may be live', async () => {
  const flaky = {
    kind: 'composio',
    supports: () => true,
    publishPost: async () => {
      throw new Error('ECONNRESET talking to the broker');
    },
  } as unknown as PublisherProvider;

  await assert.rejects(
    () => dispatchPublish(baseRequest(), { selector: () => 'composio', publisherProvider: () => flaky }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, true);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('the real default (no deps): unset COMPOSIO_ENABLED takes the direct path and never builds the seam', async () => {
  const prevEnabled = process.env.COMPOSIO_ENABLED;
  const prevSelector = process.env.PUBLISH_PROVIDER;
  delete process.env.COMPOSIO_ENABLED;
  delete process.env.PUBLISH_PROVIDER;
  const directResult: MetaPublishSuccess = {
    provider: 'facebook',
    mode: 'live',
    platformPostId: 'fb_default',
    scheduledFor: null,
    connectionId: 'conn_oauth_1',
  };
  let seamUsed = false;
  try {
    const out = await dispatchPublish(baseRequest(), {
      // selector intentionally NOT injected → exercises real effectivePublishProvider
      directPublish: async () => directResult,
      publisherProvider: () => {
        seamUsed = true;
        return stubProvider({} as PublishResult).provider;
      },
    });
    assert.equal(seamUsed, false, 'default env must resolve to direct_meta and never construct the seam');
    assert.deepEqual(out, directResult);
  } finally {
    if (prevEnabled === undefined) delete process.env.COMPOSIO_ENABLED;
    else process.env.COMPOSIO_ENABLED = prevEnabled;
    if (prevSelector === undefined) delete process.env.PUBLISH_PROVIDER;
    else process.env.PUBLISH_PROVIDER = prevSelector;
  }
});

test('auto selector also routes through the seam (not the direct path)', async () => {
  const { provider, calls } = stubProvider({
    provider: 'direct_meta',
    platform: 'facebook',
    externalPostId: 'fb_auto',
    externalCampaignId: null,
    externalAdId: null,
    status: 'published',
    url: null,
    rawResponse: {},
  });

  const out = await dispatchPublish(baseRequest(), {
    selector: () => 'auto',
    directPublish: async () => {
      throw new Error('auto must go through the seam, not the bare direct path');
    },
    publisherProvider: () => provider,
  });

  assert.equal(calls.length, 1);
  // The auto provider can resolve to direct_meta internally; the mapped marker reflects that.
  assert.equal(out.connectionId, 'direct_meta:facebook');
  assert.equal(out.platformPostId, 'fb_auto');
});
