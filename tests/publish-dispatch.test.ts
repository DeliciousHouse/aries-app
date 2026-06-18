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

// ── Regression test for #631: metaPlatform() routing for 'x' ────────────────

test('#631 metaPlatform routing: provider=x reaches the seam with platform=x, NOT coerced to facebook', async () => {
  // Before the fix, metaPlatform('x') fell through to 'facebook' (the else branch).
  // An X post would silently dispatch to a Facebook Page via the Composio seam
  // with the wrong platform key — the FB branch checks page_id resolution and
  // would throw or post to the wrong account.
  const calls: PublishPostInput[] = [];
  const provider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput) => {
      calls.push(input);
      return {
        provider: 'composio',
        platform: 'x' as const,
        externalPostId: 'tweet_x_123',
        externalCampaignId: null,
        externalAdId: null,
        status: 'published' as const,
        url: 'https://twitter.com/status/tweet_x_123',
        rawResponse: {},
      };
    },
  } as unknown as PublisherProvider;

  const out = await dispatchPublish(
    { tenantId: '42', provider: 'x', content: 'hello x', mediaUrls: [], scheduledFor: null },
    {
      selector: () => 'composio',
      composioEnabled: () => true,
      directPublish: async () => {
        throw new Error('x must never reach the direct-Meta path');
      },
      publisherProvider: () => provider,
    },
  );

  assert.equal(calls.length, 1, 'exactly one publishPost call');
  assert.equal(
    calls[0].platform,
    'x',
    'x provider must reach the seam with platform=x (NOT coerced to facebook)',
  );
  assert.notEqual(calls[0].platform, 'facebook', 'x must NOT be coerced to facebook — that is the pre-fix bug');
  assert.equal(out.platformPostId, 'tweet_x_123');
  // connectionId is composio:<platform>; must contain 'x' not 'facebook'
  assert.ok(
    out.connectionId.includes(':x'),
    `connectionId must reference 'x', got: ${out.connectionId}`,
  );
});

// ── Regression test for #646: metaPlatform() routing for 'linkedin' ─────────

test('#646 metaPlatform routing: provider=linkedin reaches the seam with platform=linkedin, NOT coerced to facebook', async () => {
  // Before the fix, metaPlatform('linkedin') fell through to 'facebook' (the else branch).
  // A LinkedIn post would silently dispatch to a Facebook Page via the Composio seam
  // with the wrong platform key.
  const calls: PublishPostInput[] = [];
  const provider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput) => {
      calls.push(input);
      return {
        provider: 'composio',
        platform: 'linkedin' as const,
        externalPostId: 'urn:li:share:dispatch_test',
        externalCampaignId: null,
        externalAdId: null,
        status: 'published' as const,
        url: 'https://www.linkedin.com/feed/update/urn:li:share:dispatch_test',
        rawResponse: {},
      };
    },
  } as unknown as PublisherProvider;

  const out = await dispatchPublish(
    { tenantId: '42', provider: 'linkedin', content: 'hello linkedin', mediaUrls: [], scheduledFor: null },
    {
      selector: () => 'composio',
      composioEnabled: () => true,
      directPublish: async () => {
        throw new Error('linkedin must never reach the direct-Meta path');
      },
      publisherProvider: () => provider,
    },
  );

  assert.equal(calls.length, 1, 'exactly one publishPost call');
  assert.equal(
    calls[0].platform,
    'linkedin',
    'linkedin provider must reach the seam with platform=linkedin (NOT coerced to facebook)',
  );
  assert.notEqual(calls[0].platform, 'facebook', 'linkedin must NOT be coerced to facebook — that is the pre-fix bug');
  assert.equal(out.platformPostId, 'urn:li:share:dispatch_test');
  assert.ok(
    out.connectionId.includes(':linkedin'),
    `connectionId must reference 'linkedin', got: ${out.connectionId}`,
  );
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

// ── Regression tests for #671: per-platform publish routing decoupled ────────
//
// Before the fix, `dispatchPublish` applied the `direct_meta` fast path
// unconditionally for all platforms.  An X/Reddit/LinkedIn request with
// selector='direct_meta' (the shipped prod default) would call directPublish,
// which reaches normalizeMetaProvider and throws 'unsupported_provider' (400) —
// so those platforms could never publish regardless of COMPOSIO_ENABLED.
//
// The fix gates the direct_meta fast path on `!composioOnly`, and for
// composio-only platforms (x, reddit, linkedin) routes to the Composio
// publisher REGARDLESS of the global selector when Composio is enabled.

test('#671 PROVING: x/reddit/linkedin bypass direct_meta fast path when composio is enabled', async () => {
  // PROVING TEST — fails against pre-fix code.
  //
  // Before the fix:
  //   if (selector() === 'direct_meta') return directPublish(request);  // ran for ALL platforms
  //
  // After the fix:
  //   if (!composioOnly && selector() === 'direct_meta') ...             // composio-only platforms skip it
  //
  // With the pre-fix code, directCalled would be true and calls.length would be 0
  // for each composio-only platform, causing both assertions to fail.

  for (const p of ['x', 'reddit', 'linkedin'] as const) {
    let directCalled = false;
    const calls: PublishPostInput[] = [];

    const recordingProvider = {
      kind: 'composio',
      supports: () => true,
      publishPost: async (input: PublishPostInput) => {
        calls.push(input);
        return {
          provider: 'composio' as const,
          platform: p,
          externalPostId: `${p}_post_671`,
          externalCampaignId: null,
          externalAdId: null,
          status: 'published' as const,
          url: null,
          rawResponse: {},
        };
      },
    } as unknown as PublisherProvider;

    const out = await dispatchPublish(
      { tenantId: '15', provider: p, content: `hello ${p}`, mediaUrls: [], scheduledFor: null },
      {
        selector: () => 'direct_meta',   // the prod default selector
        composioEnabled: () => true,
        directPublish: async () => {
          directCalled = true;
          // Return a plausible result so the pre-fix path can be inspected via
          // assertion — we do NOT throw here so the test fails on the assertion,
          // not on an unexpected exception from directPublish.
          // provider must be a SupportedMetaProvider (facebook|instagram); p is
          // always a composio-only platform here so this return is never reached
          // after the fix (asserted below as directCalled===false).
          return {
            provider: 'facebook' as const,
            mode: 'live' as const,
            platformPostId: 'WRONG_direct_path',
            scheduledFor: null,
            connectionId: 'conn_wrong',
          };
        },
        publisherProvider: () => recordingProvider,
      },
    );

    assert.equal(
      directCalled,
      false,
      `${p}: directPublish must NOT be called — composio-only platforms bypass the direct_meta fast path`,
    );
    assert.equal(calls.length, 1, `${p}: publisherProvider.publishPost must be called exactly once`);
    assert.equal(calls[0].platform, p, `${p}: publishPost must receive platform=${p}`);
    assert.equal(out.platformPostId, `${p}_post_671`, `${p}: result must map through from the composio provider`);
    assert.ok(
      out.connectionId.includes(`:${p}`),
      `${p}: connectionId must reference ${p}, got: ${out.connectionId}`,
    );
  }
});

test('#671 facebook and instagram stay on the direct_meta path (not composio-only)', async () => {
  // FB and IG are NOT composio-only platforms. Under `direct_meta` they must
  // still take the direct path — no change from the pre-fix behavior for them.
  for (const p of ['facebook', 'instagram'] as const) {
    let directCalled = false;
    let providerBuilt = false;
    const directResult: MetaPublishSuccess = {
      provider: p,
      mode: 'live',
      platformPostId: `${p}_direct_671`,
      scheduledFor: null,
      connectionId: `conn_oauth_${p}`,
    };

    const out = await dispatchPublish(
      { tenantId: '15', provider: p, content: `hello ${p}`, mediaUrls: [], scheduledFor: null },
      {
        selector: () => 'direct_meta',
        composioEnabled: () => true,
        directPublish: async (_r) => {
          directCalled = true;
          return directResult;
        },
        publisherProvider: () => {
          providerBuilt = true;
          return stubProvider({} as PublishResult).provider;
        },
      },
    );

    assert.equal(directCalled, true, `${p}: directPublish must be called on the direct_meta path`);
    assert.equal(providerBuilt, false, `${p}: composio seam must NOT be built under direct_meta`);
    assert.deepEqual(out, directResult, `${p}: result must be byte-identical to the direct path`);
  }
});

test('#671 composio-only platform with composio disabled throws terminal provider_not_configured', async () => {
  // When Composio is disabled (COMPOSIO_ENABLED=false / composioEnabled()===false),
  // dispatching to a composio-only platform (x, reddit, linkedin) must throw a
  // terminal MetaPublishError before contacting any provider.  This signals to
  // handlers that the post was NEVER sent (safe to surface; never auto-retry).
  for (const p of ['x', 'reddit', 'linkedin'] as const) {
    let directCalled = false;
    let providerBuilt = false;

    await assert.rejects(
      () =>
        dispatchPublish(
          { tenantId: '15', provider: p, content: `hello ${p}`, mediaUrls: [], scheduledFor: null },
          {
            selector: () => 'direct_meta',
            composioEnabled: () => false,
            directPublish: async () => {
              directCalled = true;
              throw new Error('directPublish must not be called for composio-only platform');
            },
            publisherProvider: () => {
              providerBuilt = true;
              return stubProvider({} as PublishResult).provider;
            },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof MetaPublishError, `${p}: must throw MetaPublishError`);
        assert.equal(err.retryable, false, `${p}: error must be non-retryable (terminal)`);
        assert.equal(err.code, 'provider_not_configured', `${p}: error code must be provider_not_configured`);
        return true;
      },
    );

    assert.equal(directCalled, false, `${p}: directPublish must not be called`);
    assert.equal(providerBuilt, false, `${p}: publisherProvider must not be constructed`);
  }
});
