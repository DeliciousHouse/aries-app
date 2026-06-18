/**
 * Regression coverage for #641: Reddit publish dispatched through Composio
 * REDDIT_CREATE_REDDIT_POST, gated behind ARIES_REDDIT_ENABLED.
 *
 * Failure modes locked:
 *  1. Image post (flag ON, subreddit env set): dispatches REDDIT_CREATE_REDDIT_POST
 *     with {subreddit, title, kind:'link', url}; externalPostId = t3_ name from
 *     nested json.data.name.
 *  2. Text-only post: kind='self', text=content (no url field).
 *  3. Subreddit resolution: env set → that subreddit; env unset + externalAccountName
 *     → u_<name>; both unset → ComposioCapabilityMissingError (never-posted).
 *  4. Title derivation: multi-line → first non-empty line; >300 chars → truncated
 *     with ellipsis; empty content → 'New post'.
 *  5. Slug unset → ComposioCapabilityMissingError. Dry-run → no gateway calls.
 *     Not-approved → PublishGuardError. executeTool successful:false →
 *     ComposioToolError (never-posted).
 *  6. normalizeTargetPlatforms: flag OFF → ['reddit'] returns null; flag ON →
 *     ['reddit'] accepted.
 *  7. Dispatch-guard predicate: isMetaProvider('reddit') false; combined guard
 *     rejects reddit as unsupported when flag off, passes when on.
 *  8. post-id extraction: t3_ fullname extracted from nested json.data.name shape;
 *     media_key not grabbed.
 *  9. metaPlatform routing: provider='reddit' reaches the seam with platform='reddit',
 *     NOT coerced to 'facebook'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
} from '@/backend/integrations/composio/errors';
import { publishNeverReachedPlatform } from '@/backend/integrations/publish-outcome';
import { isMetaProvider } from '@/backend/integrations/meta-publishing';
import { isRedditEnabled } from '@/backend/integrations/providers/integration-config';
import { normalizeTargetPlatforms } from '@/backend/social-content/scheduled-posts';
import { dispatchPublish } from '@/backend/integrations/publish-dispatch';
import type { ComposioGateway, GatewayToolResult } from '@/backend/integrations/composio/composio-client';
import type { PublisherProvider } from '@/backend/integrations/providers/interfaces';
import type { PublishPostInput } from '@/backend/integrations/providers/types';
import type { RecordedExecute } from './composio/helpers';
import { fakeConfig, fakeDb } from './composio/helpers';

const tenantId = '42';

// ── withEnv helper ────────────────────────────────────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
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
  return Promise.resolve(fn()).finally(() => {
    for (const [k, original] of prev) {
      if (original === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original;
      }
    }
  });
}

// ── Simple gateway (no uploadFile for Reddit — no pre-upload step) ────────────

function makeRedditGateway(opts?: {
  defaultResult?: GatewayToolResult;
  shouldThrow?: Error;
}): ComposioGateway & { calls: RecordedExecute[] } {
  const calls: RecordedExecute[] = [];
  const defaultResult: GatewayToolResult =
    opts?.defaultResult ?? { data: {}, successful: true, error: null };

  return {
    calls,
    async findOrCreateManagedAuthConfig(toolkitSlug) {
      return `ac_${toolkitSlug}`;
    },
    async initiateConnection() {
      return { connectionRequestId: 'cr_1', redirectUrl: null };
    },
    async listConnections() {
      return [];
    },
    async getConnection() {
      return null;
    },
    async deleteConnection() {
      /* no-op */
    },
    async executeTool(slug, options) {
      const rec = { slug, options };
      calls.push(rec);
      if (opts?.shouldThrow) throw opts.shouldThrow;
      return defaultResult;
    },
    async uploadFile(_input) {
      // Reddit does NOT call uploadFile — if this is ever reached the test should fail.
      throw new Error('uploadFile must never be called for a Reddit publish');
    },
  };
}

// ── Actions config for Reddit ─────────────────────────────────────────────────

const REDDIT_ACTIONS = {
  publish_post: 'REDDIT_CREATE_REDDIT_POST',
} as const;

// ── fakeDb with a reddit connected account ────────────────────────────────────

function redditDb(opts?: { externalAccountName?: string | null; noRow?: boolean }) {
  const name = opts?.externalAccountName === undefined ? 'someuser' : opts.externalAccountName;
  return fakeDb({
    connectionRow: opts?.noRow
      ? null
      : {
          id: 1,
          tenant_id: 42,
          external_user_id: 'aries-tenant-42',
          platform: 'reddit',
          provider: 'composio',
          connected_account_id: 'ca_reddit_123',
          auth_config_id: 'auth_cfg_test',
          external_account_id: null,
          external_account_name: name,
          status: 'connected',
          capabilities_json: null,
          last_capability_check_at: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Image post (flag ON, subreddit env set)
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 Reddit image post: single REDDIT_CREATE_REDDIT_POST call with {subreddit, title, kind:link, url}', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/testcommunity', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const createPostResult: GatewayToolResult = {
        // Reddit wraps the created post id in data.json.data.name (t3_ fullname)
        data: { json: { data: { name: 't3_abc123', url: 'https://reddit.com/r/testcommunity/comments/abc123' } } },
        successful: true,
        error: null,
      };
      const gateway = makeRedditGateway({ defaultResult: createPostResult });

      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      const result = await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'Hello\nbody text that should NOT be the title',
        mediaUrls: ['https://img.example.com/photo.png'],
        approved: true,
      });

      // Exactly one executeTool call (no uploadFile step for Reddit)
      assert.equal(gateway.calls.length, 1, 'exactly one executeTool call for Reddit image post');
      const call = gateway.calls[0];
      assert.equal(call.slug, 'REDDIT_CREATE_REDDIT_POST', 'must call the reddit publish action slug');

      const args = call.options.arguments as Record<string, unknown>;
      assert.equal(args.subreddit, 'r/testcommunity', 'subreddit must come from COMPOSIO_REDDIT_TARGET_SUBREDDIT');
      assert.equal(args.title, 'Hello', 'title must be the first non-empty line of content');
      assert.equal(args.kind, 'link', 'image post must use kind=link');
      assert.equal(args.url, 'https://img.example.com/photo.png', 'url must be the first mediaUrl');
      assert.equal(args.text, undefined, 'text must NOT be present for an image (link-kind) post');

      // Result
      assert.equal(result.status, 'published');
      assert.equal(result.externalPostId, 't3_abc123', 'externalPostId must be the t3_ fullname from json.data.name');
      assert.equal(result.platform, 'reddit');
      assert.equal(result.provider, 'composio');
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Text-only post
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 Reddit text-only post: kind=self, text=content, no url field', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/testcommunity', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const createPostResult: GatewayToolResult = {
        data: { json: { data: { name: 't3_textonly' } } },
        successful: true,
        error: null,
      };
      const gateway = makeRedditGateway({ defaultResult: createPostResult });

      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      const result = await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'Just text, no image at all',
        mediaUrls: [],
        approved: true,
      });

      assert.equal(gateway.calls.length, 1, 'exactly one executeTool call for text-only');
      const call = gateway.calls[0];
      assert.equal(call.slug, 'REDDIT_CREATE_REDDIT_POST');

      const args = call.options.arguments as Record<string, unknown>;
      assert.equal(args.kind, 'self', 'text-only post must use kind=self');
      assert.equal(args.text, 'Just text, no image at all', 'text must be the full content');
      assert.equal(args.url, undefined, 'url must NOT be present for a text (self-kind) post');
      assert.equal(args.subreddit, 'r/testcommunity');
      assert.equal(args.title, 'Just text, no image at all', 'title should be the first line');

      assert.equal(result.status, 'published');
      assert.equal(result.externalPostId, 't3_textonly');
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Subreddit resolution
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 subreddit: env set → uses COMPOSIO_REDDIT_TARGET_SUBREDDIT', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/mysubreddit', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_sr' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb({ externalAccountName: 'ignored_user' }),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'test',
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      assert.equal(args.subreddit, 'r/mysubreddit', 'env value must take precedence over username fallback');
    },
  );
});

test('#641 subreddit: env unset + externalAccountName → u_<name>', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: undefined, ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_profile' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb({ externalAccountName: 'someuser' }),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'profile post',
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      assert.equal(
        args.subreddit,
        'u_someuser',
        'should fall back to u_<externalAccountName> when env is unset',
      );
    },
  );
});

test('#641 subreddit: both unset → ComposioCapabilityMissingError AND publishNeverReachedPlatform=true', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: undefined, ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway();
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb({ externalAccountName: null }), // no externalAccountName
      );

      let caught: unknown;
      try {
        await provider.publishPost({
          tenantId,
          platform: 'reddit',
          content: 'no subreddit',
          mediaUrls: [],
          approved: true,
        });
        assert.fail('expected rejection');
      } catch (e) {
        caught = e;
      }

      assert.ok(
        caught instanceof ComposioCapabilityMissingError,
        'both-unset subreddit must throw ComposioCapabilityMissingError',
      );
      assert.equal(
        publishNeverReachedPlatform(caught),
        true,
        'subreddit-missing error must be classified as definitely-never-posted (safe rollback)',
      );
      // No executeTool call was made
      assert.equal(gateway.calls.length, 0, 'executeTool must not be called when subreddit is missing');
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Title derivation
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 title: multi-line content → first non-empty line used as title', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_multi' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: '\n\nFirst actual line\nSecond line\nThird line',
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      assert.equal(
        args.title,
        'First actual line',
        'title must be the first non-empty line, skipping blank lines',
      );
    },
  );
});

test('#641 title: content >300 chars → truncated to 300 chars with ellipsis', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const longContent = 'A'.repeat(400);
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_long' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: longContent,
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      const title = args.title as string;
      assert.ok(
        title.length <= 300,
        `title must be ≤300 chars; got ${title.length}`,
      );
      assert.ok(
        title.endsWith('…'),
        'truncated title must end with ellipsis character',
      );
      // The truncation: 299 chars of content + '…' = 300
      assert.equal(title.length, 300, 'truncated title must be exactly 300 chars');
    },
  );
});

test('#641 title: empty content → fallback "New post"', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_empty' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: '',
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      assert.equal(args.title, 'New post', 'empty content must produce the fallback title');
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Guard conditions: slug unset, dry-run, not-approved, tool failure
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 Reddit publish_post slug unset → ComposioCapabilityMissingError (never guess a slug)', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const provider = new ComposioPublisherProvider(
        makeRedditGateway(),
        fakeConfig({ actions: {} /* no publish_post */ }),
        redditDb(),
      );

      await assert.rejects(
        () =>
          provider.publishPost({
            tenantId,
            platform: 'reddit',
            content: 'hello',
            mediaUrls: [],
            approved: true,
          }),
        ComposioCapabilityMissingError,
        'missing publish_post slug must throw ComposioCapabilityMissingError',
      );
    },
  );
});

test('#641 Reddit dry-run returns preview without calling the gateway', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway();
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      const result = await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'preview',
        mediaUrls: ['https://img.example.com/photo.png'],
        dryRun: true,
      });

      assert.equal(result.status, 'preview', 'dry-run must return preview status');
      assert.equal(gateway.calls.length, 0, 'dry-run must not call executeTool');
    },
  );
});

test('#641 Reddit not-approved throws PublishGuardError', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const provider = new ComposioPublisherProvider(
        makeRedditGateway(),
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      await assert.rejects(
        () =>
          provider.publishPost({
            tenantId,
            platform: 'reddit',
            content: 'not approved',
            mediaUrls: [],
            approved: false,
          }),
        PublishGuardError,
        'unapproved Reddit post must throw PublishGuardError',
      );
    },
  );
});

test('#641 Reddit executeTool successful:false → ComposioToolError (never-posted)', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: null, successful: false, error: 'SUBREDDIT_NOEXIST' },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      let caught: unknown;
      try {
        await provider.publishPost({
          tenantId,
          platform: 'reddit',
          content: 'fail',
          mediaUrls: [],
          approved: true,
        });
        assert.fail('expected rejection');
      } catch (e) {
        caught = e;
      }

      assert.ok(caught instanceof ComposioToolError, 'unsuccessful executeTool must throw ComposioToolError');
      assert.equal(
        publishNeverReachedPlatform(caught),
        true,
        'tool-unsuccessful must be classified as definitely-never-posted (safe to roll back)',
      );
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. normalizeTargetPlatforms dormancy
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 normalizeTargetPlatforms: flag OFF → [\'reddit\'] returns null (reddit not accepted)', async () => {
  await withEnv({ ARIES_REDDIT_ENABLED: undefined }, () => {
    const result = normalizeTargetPlatforms(['reddit']);
    assert.equal(
      result,
      null,
      "['reddit'] must return null when ARIES_REDDIT_ENABLED is unset (schedule request would 400)",
    );
  });
});

test('#641 normalizeTargetPlatforms: flag OFF → [\'facebook\', \'instagram\'] still accepted', async () => {
  await withEnv({ ARIES_REDDIT_ENABLED: undefined }, () => {
    const result = normalizeTargetPlatforms(['facebook', 'instagram']);
    assert.deepEqual(result, ['facebook', 'instagram'], 'facebook+instagram must work regardless of reddit flag');
  });
});

test('#641 normalizeTargetPlatforms: flag ON → [\'reddit\'] accepted', async () => {
  await withEnv({ ARIES_REDDIT_ENABLED: '1' }, () => {
    const result = normalizeTargetPlatforms(['reddit']);
    assert.deepEqual(result, ['reddit'], "['reddit'] must be accepted when ARIES_REDDIT_ENABLED=1");
  });
});

test('#641 normalizeTargetPlatforms: flag ON → [\'facebook\', \'instagram\', \'reddit\'] accepted', async () => {
  await withEnv({ ARIES_REDDIT_ENABLED: '1' }, () => {
    const result = normalizeTargetPlatforms(['facebook', 'instagram', 'reddit']);
    assert.deepEqual(result, ['facebook', 'instagram', 'reddit'], 'all three platforms valid when reddit flag ON');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Dispatch-guard predicates
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 dispatch guard: isMetaProvider(reddit) is false — reddit is never routed via the direct-Meta fast path', () => {
  assert.equal(
    isMetaProvider('reddit'),
    false,
    "reddit must not be a Meta provider — a bug here would route Reddit posts to a Facebook Page",
  );
});

test('#641 dispatch guard flag-OFF: combined predicate rejects reddit as unsupported_provider', async () => {
  // Replicates the exact condition in scheduled-dispatch/route.ts:
  //   const isRedditPublish = platform === 'reddit' && isRedditEnabled();
  //   if (!isMetaProvider(platform) && !isXPublish && !isRedditPublish) → push unsupported_provider
  await withEnv({ ARIES_REDDIT_ENABLED: undefined }, () => {
    const platform = 'reddit';
    const isRedditPublish = platform === 'reddit' && isRedditEnabled();
    const shouldReject = !isMetaProvider(platform) && !isRedditPublish;
    assert.equal(
      shouldReject,
      true,
      'reddit must be rejected (unsupported_provider) when ARIES_REDDIT_ENABLED is unset',
    );
  });
});

test('#641 dispatch guard flag-ON: combined predicate passes reddit through to dispatchPublish', async () => {
  await withEnv({ ARIES_REDDIT_ENABLED: '1' }, () => {
    const platform = 'reddit';
    const isRedditPublish = platform === 'reddit' && isRedditEnabled();
    const shouldReject = !isMetaProvider(platform) && !isRedditPublish;
    assert.equal(
      shouldReject,
      false,
      'reddit must NOT be rejected when ARIES_REDDIT_ENABLED=1',
    );
  });
});

test('#641 dispatch guard: facebook/instagram pass regardless of reddit flag (no regression)', async () => {
  for (const platform of ['facebook', 'instagram'] as const) {
    assert.equal(
      isMetaProvider(platform),
      true,
      `${platform} must remain a Meta provider unaffected by the Reddit flag`,
    );
    assert.equal(!isMetaProvider(platform), false, `${platform} must pass the Meta guard`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. post-id extraction robustness
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 post-id extraction: t3_ fullname extracted from nested json.data.name shape', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      // The Reddit API response nests the created post under data.json.data.name
      // (the t3_ fullname). The idKeys override in the reddit branch must recurse
      // through 'json' to find 'name'.
      const gateway = makeRedditGateway({
        defaultResult: {
          data: {
            // Intentionally add a media_key at the top level — must NOT be picked up
            media_key: 'MEDIA_KEY_SHOULD_NOT_BE_ID',
            json: {
              data: {
                name: 't3_xyz789',
                url: 'https://reddit.com/r/test/comments/xyz789',
              },
            },
          },
          successful: true,
          error: null,
        },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      const result = await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'id extraction test',
        mediaUrls: [],
        approved: true,
      });

      assert.equal(
        result.externalPostId,
        't3_xyz789',
        'externalPostId must be the t3_ fullname from json.data.name, not media_key',
      );
      assert.notEqual(
        result.externalPostId,
        'MEDIA_KEY_SHOULD_NOT_BE_ID',
        'media_key at top level must NOT be mistaken for the post id',
      );
    },
  );
});

test('#641 post-id extraction: flat id field also works (fallback shape)', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      // Some Composio tool versions may return a flat {id: 't3_flat'} shape
      const gateway = makeRedditGateway({
        defaultResult: {
          data: { id: 't3_flat' },
          successful: true,
          error: null,
        },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      const result = await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'flat shape test',
        mediaUrls: [],
        approved: true,
      });

      assert.equal(result.externalPostId, 't3_flat', 'flat id field must also be accepted');
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. metaPlatform routing: provider='reddit' reaches the seam with platform='reddit'
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 metaPlatform routing: provider=reddit reaches the seam with platform=reddit, NOT coerced to facebook', async () => {
  // Before the fix, metaPlatform('reddit') would fall through to 'facebook' (the else branch).
  // A Reddit post would silently dispatch to a Facebook Page via the Composio seam.
  const calls: PublishPostInput[] = [];
  const provider: PublisherProvider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput) => {
      calls.push(input);
      return {
        provider: 'composio',
        platform: 'reddit' as const,
        externalPostId: 't3_routed_correctly',
        externalCampaignId: null,
        externalAdId: null,
        status: 'published' as const,
        url: 'https://reddit.com/r/test/comments/routed_correctly',
        rawResponse: {},
      };
    },
    publishAd: async () => {
      throw new Error('not implemented');
    },
    uploadMedia: async () => {
      throw new Error('not implemented');
    },
    getPublishStatus: async () => {
      throw new Error('not implemented');
    },
  } as unknown as PublisherProvider;

  const out = await dispatchPublish(
    { tenantId: '42', provider: 'reddit', content: 'hello reddit', mediaUrls: [], scheduledFor: null },
    {
      selector: () => 'composio',
      composioEnabled: () => true,
      directPublish: async () => {
        throw new Error('reddit must never reach the direct-Meta path');
      },
      publisherProvider: () => provider,
    },
  );

  assert.equal(calls.length, 1, 'exactly one publishPost call');
  assert.equal(
    calls[0].platform,
    'reddit',
    'reddit provider must reach the seam with platform=reddit (NOT coerced to facebook)',
  );
  assert.notEqual(calls[0].platform, 'facebook', 'reddit must NOT be coerced to facebook');
  assert.equal(out.platformPostId, 't3_routed_correctly');
  // connectionId is composio:<platform>; must reference 'reddit' not 'facebook'
  assert.ok(
    out.connectionId.includes(':reddit'),
    `connectionId must reference 'reddit', got: ${out.connectionId}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Connection missing
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 Reddit with no active connection throws ComposioConnectionMissingError', async () => {
  await withEnv(
    { COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test', ARIES_REDDIT_ENABLED: '1' },
    async () => {
      const provider = new ComposioPublisherProvider(
        makeRedditGateway(),
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb({ noRow: true }),
      );

      await assert.rejects(
        () =>
          provider.publishPost({
            tenantId,
            platform: 'reddit',
            content: 'no connection',
            mediaUrls: [],
            approved: true,
          }),
        ComposioConnectionMissingError,
        'missing Reddit connection must throw ComposioConnectionMissingError',
      );
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. flair_id is included when COMPOSIO_REDDIT_FLAIR_ID is set
// ═══════════════════════════════════════════════════════════════════════════════

test('#641 flair_id included when COMPOSIO_REDDIT_FLAIR_ID is set', async () => {
  await withEnv(
    {
      COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test',
      COMPOSIO_REDDIT_FLAIR_ID: 'flair-abc-123',
      ARIES_REDDIT_ENABLED: '1',
    },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_flair' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'flair test',
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      assert.equal(args.flair_id, 'flair-abc-123', 'flair_id must be included when env var is set');
    },
  );
});

test('#641 flair_id omitted when COMPOSIO_REDDIT_FLAIR_ID is unset', async () => {
  await withEnv(
    {
      COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test',
      COMPOSIO_REDDIT_FLAIR_ID: undefined,
      ARIES_REDDIT_ENABLED: '1',
    },
    async () => {
      const gateway = makeRedditGateway({
        defaultResult: { data: { json: { data: { name: 't3_noflair' } } }, successful: true, error: null },
      });
      const provider = new ComposioPublisherProvider(
        gateway,
        fakeConfig({ actions: REDDIT_ACTIONS }),
        redditDb(),
      );

      await provider.publishPost({
        tenantId,
        platform: 'reddit',
        content: 'no flair test',
        mediaUrls: [],
        approved: true,
      });

      const args = gateway.calls[0].options.arguments as Record<string, unknown>;
      assert.equal(args.flair_id, undefined, 'flair_id must be omitted when env var is not set');
    },
  );
});
