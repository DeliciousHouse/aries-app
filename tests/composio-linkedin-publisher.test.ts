/**
 * Regression coverage for #646: LinkedIn publish dispatched through Composio
 * LINKEDIN_CREATE_LINKED_IN_POST, gated behind ARIES_LINKEDIN_ENABLED.
 *
 * Failure modes locked:
 *  1. Image post (flag ON, connection has URN): uploadFile staged once →
 *     EXACTLY ONE executeTool(LINKEDIN_CREATE_LINKED_IN_POST, {author, commentary,
 *     images:[descriptor]}); result published; externalPostId from response.
 *     NO second upload executeTool (the key LinkedIn-vs-X difference: LinkedIn
 *     has no separate upload action; the descriptor goes directly into images[]).
 *  2. Missing URN → ComposioCapabilityMissingError (linkedin_profile_missing fix);
 *     publishNeverReachedPlatform===true AND no executeTool AND no uploadFile call.
 *  3. Text-only: no uploadFile; args {author, commentary} with NO `images` key.
 *  4. Commentary truncation: content >3000 chars → commentary.length ≤ 3000,
 *     ends with ellipsis.
 *  5. Slug unset → ComposioCapabilityMissingError. Dry-run → no gateway calls.
 *     Not-approved → PublishGuardError. uploadFile throw → ComposioToolError
 *     (definitely-never-posted, no create call).
 *  6. Dormancy: normalizeTargetPlatforms(['linkedin']) → null when
 *     ARIES_LINKEDIN_ENABLED unset; ['linkedin'] when =1.
 *     Dispatch-guard predicate 'linkedin' && isLinkedInEnabled() false→true.
 *     isMetaProvider('linkedin')===false.
 *  7. metaPlatform routing: provider='linkedin' reaches the seam with
 *     platform='linkedin', NOT coerced to 'facebook'.
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
import { isLinkedInEnabled } from '@/backend/integrations/providers/integration-config';
import { normalizeTargetPlatforms } from '@/backend/social-content/scheduled-posts';
import { dispatchPublish } from '@/backend/integrations/publish-dispatch';
import type {
  ComposioGateway,
  ComposioFileDescriptor,
  ComposioFileUploadInput,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import type { PublisherProvider } from '@/backend/integrations/providers/interfaces';
import type { PublishPostInput } from '@/backend/integrations/providers/types';
import type { RecordedExecute } from './composio/helpers';
import { fakeConfig, fakeDb } from './composio/helpers';

const tenantId = '42';
const LINKEDIN_URN = 'urn:li:person:abc123';

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

// ── Gateway that tracks uploadFile + executeTool separately ───────────────────

/**
 * Build a gateway for LinkedIn tests. Tracks uploadFile calls independently
 * from executeTool calls, so we can assert exactly one executeTool (no upload
 * executeTool step exists for LinkedIn — it uses uploadFile+descriptor only).
 */
function makeLinkedInGateway(opts?: {
  defaultResult?: GatewayToolResult;
  uploadFileShouldThrow?: Error;
}): ComposioGateway & {
  calls: RecordedExecute[];
  uploadFileCalls: Array<{ file: string; toolSlug: string; toolkitSlug: string }>;
} {
  const calls: RecordedExecute[] = [];
  const uploadFileCalls: Array<{ file: string; toolSlug: string; toolkitSlug: string }> = [];
  const defaultResult: GatewayToolResult =
    opts?.defaultResult ?? { data: {}, successful: true, error: null };

  return {
    calls,
    uploadFileCalls,
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
      return defaultResult;
    },
    async uploadFile(input: ComposioFileUploadInput): Promise<ComposioFileDescriptor> {
      uploadFileCalls.push(input);
      if (opts?.uploadFileShouldThrow) throw opts.uploadFileShouldThrow;
      return {
        name: 'staged.jpg',
        mimetype: 'image/jpeg',
        s3key: `s3/${input.toolSlug}/staged.jpg`,
      };
    },
  };
}

// ── Actions config for LinkedIn ───────────────────────────────────────────────

const LINKEDIN_ACTIONS = {
  publish_post: 'LINKEDIN_CREATE_LINKED_IN_POST',
} as const;

// ── fakeDb with a LinkedIn connected account ──────────────────────────────────

function linkedinDb(opts?: { externalAccountId?: string | null; noRow?: boolean }) {
  const urn = opts?.externalAccountId === undefined ? LINKEDIN_URN : opts.externalAccountId;
  return fakeDb({
    connectionRow: opts?.noRow
      ? null
      : {
          id: 1,
          tenant_id: 42,
          external_user_id: 'aries-tenant-42',
          platform: 'linkedin',
          provider: 'composio',
          connected_account_id: 'ca_linkedin_123',
          auth_config_id: 'auth_cfg_test',
          external_account_id: urn,
          external_account_name: 'Test User',
          status: 'connected',
          capabilities_json: null,
          last_capability_check_at: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Image post (flag ON, connection has URN)
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn image post: uploadFile once → EXACTLY ONE executeTool LINKEDIN_CREATE_LINKED_IN_POST with {author, commentary, images:[descriptor]}; no second upload executeTool', async () => {
  const createPostResult: GatewayToolResult = {
    data: { id: 'urn:li:share:abc456', ugcPostUrn: 'urn:li:ugcPost:abc456' },
    successful: true,
    error: null,
  };

  const gateway = makeLinkedInGateway({ defaultResult: createPostResult });

  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'linkedin',
    content: 'hi',
    mediaUrls: ['https://img/1.png'],
    approved: true,
  });

  // Step A: uploadFile must have been called exactly once
  assert.equal(gateway.uploadFileCalls.length, 1, 'uploadFile must be called exactly once');
  assert.equal(
    gateway.uploadFileCalls[0].file,
    'https://img/1.png',
    'uploadFile must receive the first mediaUrl as the file',
  );
  assert.equal(
    gateway.uploadFileCalls[0].toolSlug,
    'LINKEDIN_CREATE_LINKED_IN_POST',
    'uploadFile toolSlug must be the publish_post action slug (not a separate upload slug)',
  );
  assert.equal(
    gateway.uploadFileCalls[0].toolkitSlug,
    'linkedin',
    'uploadFile toolkitSlug must be "linkedin"',
  );

  // Key LinkedIn-vs-X difference: EXACTLY ONE executeTool (no separate upload executeTool)
  assert.equal(
    gateway.calls.length,
    1,
    'EXACTLY ONE executeTool call for LinkedIn image post (no separate upload executeTool — LinkedIn uses uploadFile+descriptor directly in images[])',
  );
  const createCall = gateway.calls[0];
  assert.equal(
    createCall.slug,
    'LINKEDIN_CREATE_LINKED_IN_POST',
    'the sole executeTool call must be the publish action',
  );

  const args = createCall.options.arguments as Record<string, unknown>;
  assert.equal(args.author, LINKEDIN_URN, 'author must be the URN from external_account_id');
  assert.equal(args.commentary, 'hi', 'commentary must carry the post content');

  // images must be [descriptor] with the staged file
  const images = args.images as ComposioFileDescriptor[];
  assert.ok(Array.isArray(images), 'images must be an array');
  assert.equal(images.length, 1, 'exactly one image descriptor');
  assert.equal(images[0].name, 'staged.jpg', 'descriptor name must match fakeGateway stub');
  assert.equal(
    images[0].s3key,
    's3/LINKEDIN_CREATE_LINKED_IN_POST/staged.jpg',
    'descriptor s3key must match fakeGateway stub',
  );

  // Result
  assert.equal(result.status, 'published');
  assert.equal(
    result.externalPostId,
    'urn:li:share:abc456',
    'externalPostId must come from the id field of the create response',
  );
  assert.equal(result.platform, 'linkedin');
  assert.equal(result.provider, 'composio');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Missing URN → linkedin_profile_missing fix
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 missing author URN → ComposioCapabilityMissingError; publishNeverReachedPlatform===true; no executeTool; no uploadFile', async () => {
  const gateway = makeLinkedInGateway();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb({ externalAccountId: null }), // no URN
  );

  let caught: unknown;
  try {
    await provider.publishPost({
      tenantId,
      platform: 'linkedin',
      content: 'hi',
      mediaUrls: ['https://img/1.png'],
      approved: true,
    });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }

  assert.ok(
    caught instanceof ComposioCapabilityMissingError,
    'missing URN must throw ComposioCapabilityMissingError',
  );
  assert.equal(
    publishNeverReachedPlatform(caught),
    true,
    'missing-URN error must be classified as definitely-never-posted (safe rollback)',
  );
  // Must have thrown BEFORE any gateway calls
  assert.equal(
    gateway.calls.length,
    0,
    'executeTool must NOT be called when the author URN is missing',
  );
  assert.equal(
    gateway.uploadFileCalls.length,
    0,
    'uploadFile must NOT be called when the author URN is missing',
  );
});

test('#646 missing URN with empty string → ComposioCapabilityMissingError (whitespace-only URN also rejected)', async () => {
  const gateway = makeLinkedInGateway();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb({ externalAccountId: '   ' }), // whitespace-only — trimmed to empty
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'linkedin',
        content: 'hi',
        mediaUrls: [],
        approved: true,
      }),
    ComposioCapabilityMissingError,
    'whitespace-only URN must also throw ComposioCapabilityMissingError',
  );

  assert.equal(gateway.calls.length, 0, 'no executeTool for whitespace URN');
  assert.equal(gateway.uploadFileCalls.length, 0, 'no uploadFile for whitespace URN');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Text-only post
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn text-only post: no uploadFile call; executeTool args have {author, commentary} with NO images key', async () => {
  const createPostResult: GatewayToolResult = {
    data: { id: 'urn:li:share:text001' },
    successful: true,
    error: null,
  };

  const gateway = makeLinkedInGateway({ defaultResult: createPostResult });

  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'linkedin',
    content: 'just text, no image',
    mediaUrls: [],
    approved: true,
  });

  // No upload steps
  assert.equal(gateway.uploadFileCalls.length, 0, 'uploadFile must NOT be called for text-only posts');
  assert.equal(gateway.calls.length, 1, 'exactly 1 executeTool call for text-only LinkedIn post');

  const createCall = gateway.calls[0];
  assert.equal(createCall.slug, 'LINKEDIN_CREATE_LINKED_IN_POST');
  const args = createCall.options.arguments as Record<string, unknown>;
  assert.equal(args.author, LINKEDIN_URN, 'author must be set for text-only posts');
  assert.equal(args.commentary, 'just text, no image', 'commentary must carry the full text');
  assert.equal(args.images, undefined, 'images must NOT be present for text-only posts');

  // LinkedIn-specific: must NOT use X/FB/IG parameter names
  assert.equal(args.text, undefined, 'text must not be set (X-specific)');
  assert.equal(args.caption, undefined, 'caption must not be set (IG-specific)');
  assert.equal(args.message, undefined, 'message must not be set (FB-specific)');
  assert.equal(args.page_id, undefined, 'page_id must not be set (FB-specific)');

  assert.equal(result.status, 'published');
  assert.equal(result.externalPostId, 'urn:li:share:text001');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Commentary truncation
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 commentary truncation: content >3000 chars → commentary.length ≤ 3000 with ellipsis', async () => {
  const longContent = 'A'.repeat(4000);
  const gateway = makeLinkedInGateway({
    defaultResult: { data: { id: 'urn:li:share:trunc' }, successful: true, error: null },
  });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  await provider.publishPost({
    tenantId,
    platform: 'linkedin',
    content: longContent,
    mediaUrls: [],
    approved: true,
  });

  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  const commentary = args.commentary as string;
  assert.ok(commentary.length <= 3000, `commentary must be ≤3000 chars; got ${commentary.length}`);
  assert.ok(commentary.endsWith('…'), 'truncated commentary must end with ellipsis character');
  assert.equal(commentary.length, 3000, 'truncated commentary must be exactly 3000 chars');
});

test('#646 commentary under 3000 chars is not modified', async () => {
  const shortContent = 'hello LinkedIn world';
  const gateway = makeLinkedInGateway({
    defaultResult: { data: { id: 'urn:li:share:short' }, successful: true, error: null },
  });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  await provider.publishPost({
    tenantId,
    platform: 'linkedin',
    content: shortContent,
    mediaUrls: [],
    approved: true,
  });

  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.commentary, shortContent, 'short commentary must pass through unchanged');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5a. Capability guards
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn publish_post slug unset → ComposioCapabilityMissingError (never guess a slug)', async () => {
  const provider = new ComposioPublisherProvider(
    makeLinkedInGateway(),
    fakeConfig({ actions: {} /* no publish_post */ }),
    linkedinDb(),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'linkedin',
        content: 'hi',
        mediaUrls: [],
        approved: true,
      }),
    ComposioCapabilityMissingError,
    'missing publish_post slug must throw ComposioCapabilityMissingError',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5b. Dry-run
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn dry-run returns preview without calling the gateway', async () => {
  const gateway = makeLinkedInGateway();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'linkedin',
    content: 'hi',
    mediaUrls: ['https://img/1.png'],
    dryRun: true,
  });

  assert.equal(result.status, 'preview', 'dry-run must return preview status');
  assert.equal(gateway.uploadFileCalls.length, 0, 'dry-run must not call uploadFile');
  assert.equal(gateway.calls.length, 0, 'dry-run must not call executeTool');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5c. Not-approved guard
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn not-approved throws PublishGuardError', async () => {
  const provider = new ComposioPublisherProvider(
    makeLinkedInGateway(),
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'linkedin',
        content: 'hi',
        mediaUrls: [],
        approved: false,
      }),
    PublishGuardError,
    'unapproved LinkedIn post must throw PublishGuardError',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5d. uploadFile throw → ComposioToolError (definitely-never-posted)
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn uploadFile throw → ComposioToolError → publishNeverReachedPlatform===true (no create call)', async () => {
  const gateway = makeLinkedInGateway({
    uploadFileShouldThrow: new Error('S3 staging failed: connection refused'),
  });

  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb(),
  );

  let caught: unknown;
  try {
    await provider.publishPost({
      tenantId,
      platform: 'linkedin',
      content: 'hi',
      mediaUrls: ['https://img/1.png'],
      approved: true,
    });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }

  assert.ok(caught instanceof ComposioToolError, 'uploadFile throw must be wrapped in ComposioToolError');
  assert.equal(
    publishNeverReachedPlatform(caught),
    true,
    'uploadFile failure must be classified as definitely-never-posted (safe to retry/rollback)',
  );
  // No create call was made
  assert.equal(
    gateway.calls.filter((c) => c.slug === 'LINKEDIN_CREATE_LINKED_IN_POST').length,
    0,
    'create-post call must not be made when uploadFile fails',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5e. Connection missing
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 LinkedIn with no active connection throws ComposioConnectionMissingError', async () => {
  const provider = new ComposioPublisherProvider(
    makeLinkedInGateway(),
    fakeConfig({ actions: LINKEDIN_ACTIONS }),
    linkedinDb({ noRow: true }),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'linkedin',
        content: 'hi',
        mediaUrls: [],
        approved: true,
      }),
    ComposioConnectionMissingError,
    'missing LinkedIn connection must throw ComposioConnectionMissingError',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6a. normalizeTargetPlatforms dormancy
// ═══════════════════════════════════════════════════════════════════════════════

test("#646 normalizeTargetPlatforms: flag OFF → ['linkedin'] returns null (linkedin not accepted)", async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: undefined }, () => {
    const result = normalizeTargetPlatforms(['linkedin']);
    assert.equal(
      result,
      null,
      "['linkedin'] must return null when ARIES_LINKEDIN_ENABLED is unset (schedule request would 400)",
    );
  });
});

test("#646 normalizeTargetPlatforms: flag OFF → ['facebook', 'instagram'] still accepted", async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: undefined }, () => {
    const result = normalizeTargetPlatforms(['facebook', 'instagram']);
    assert.deepEqual(
      result,
      ['facebook', 'instagram'],
      'facebook+instagram must work regardless of linkedin flag',
    );
  });
});

test("#646 normalizeTargetPlatforms: flag ON → ['linkedin'] accepted", async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, () => {
    const result = normalizeTargetPlatforms(['linkedin']);
    assert.deepEqual(result, ['linkedin'], "['linkedin'] must be accepted when ARIES_LINKEDIN_ENABLED=1");
  });
});

test("#646 normalizeTargetPlatforms: flag ON → ['facebook', 'instagram', 'linkedin'] accepted", async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, () => {
    const result = normalizeTargetPlatforms(['facebook', 'instagram', 'linkedin']);
    assert.deepEqual(
      result,
      ['facebook', 'instagram', 'linkedin'],
      'all three platforms valid when linkedin flag ON',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6b. Scheduled-dispatch guard predicates
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 dispatch guard: isMetaProvider(linkedin) is false — linkedin is never routed via the direct-Meta fast path', () => {
  assert.equal(
    isMetaProvider('linkedin'),
    false,
    'linkedin must not be a Meta provider — a bug here would route LinkedIn posts to a Facebook Page',
  );
});

test('#646 dispatch guard flag-OFF: combined predicate rejects linkedin as unsupported_provider', async () => {
  // Replicates the exact condition in scheduled-dispatch/route.ts:
  //   const isLinkedInPublish = platform === 'linkedin' && isLinkedInEnabled();
  //   if (!isMetaProvider(platform) && !isXPublish && !isRedditPublish && !isLinkedInPublish)
  //     → push unsupported_provider
  await withEnv({ ARIES_LINKEDIN_ENABLED: undefined }, () => {
    const platform = 'linkedin';
    const isLinkedInPublish = platform === 'linkedin' && isLinkedInEnabled();
    const shouldReject = !isMetaProvider(platform) && !isLinkedInPublish;
    assert.equal(
      shouldReject,
      true,
      'linkedin must be rejected (unsupported_provider) when ARIES_LINKEDIN_ENABLED is unset',
    );
  });
});

test('#646 dispatch guard flag-ON: combined predicate passes linkedin through to dispatchPublish', async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: '1' }, () => {
    const platform = 'linkedin';
    const isLinkedInPublish = platform === 'linkedin' && isLinkedInEnabled();
    const shouldReject = !isMetaProvider(platform) && !isLinkedInPublish;
    assert.equal(
      shouldReject,
      false,
      'linkedin must NOT be rejected when ARIES_LINKEDIN_ENABLED=1',
    );
  });
});

test('#646 dispatch guard: facebook/instagram pass regardless of linkedin flag (no regression)', async () => {
  await withEnv({ ARIES_LINKEDIN_ENABLED: undefined }, () => {
    for (const platform of ['facebook', 'instagram'] as const) {
      assert.equal(
        isMetaProvider(platform),
        true,
        `${platform} must remain a Meta provider unaffected by the LinkedIn flag`,
      );
      assert.equal(!isMetaProvider(platform), false, `${platform} must pass the Meta guard`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. metaPlatform routing: provider='linkedin' reaches seam with platform='linkedin'
// ═══════════════════════════════════════════════════════════════════════════════

test('#646 metaPlatform routing: provider=linkedin reaches the seam with platform=linkedin, NOT coerced to facebook', async () => {
  // Before the fix, metaPlatform('linkedin') would fall through to 'facebook' (the else branch).
  // A LinkedIn post would silently dispatch to a Facebook Page via the Composio seam.
  const calls: PublishPostInput[] = [];
  const provider: PublisherProvider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput) => {
      calls.push(input);
      return {
        provider: 'composio',
        platform: 'linkedin' as const,
        externalPostId: 'urn:li:share:routed_correctly',
        externalCampaignId: null,
        externalAdId: null,
        status: 'published' as const,
        url: 'https://www.linkedin.com/feed/update/urn:li:share:routed_correctly',
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
    { tenantId: '42', provider: 'linkedin', content: 'hello linkedin', mediaUrls: [], scheduledFor: null },
    {
      selector: () => 'composio',
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
  assert.notEqual(calls[0].platform, 'facebook', 'linkedin must NOT be coerced to facebook');
  assert.equal(out.platformPostId, 'urn:li:share:routed_correctly');
  assert.ok(
    out.connectionId.includes(':linkedin'),
    `connectionId must reference 'linkedin', got: ${out.connectionId}`,
  );
});
