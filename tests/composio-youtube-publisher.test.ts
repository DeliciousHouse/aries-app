/**
 * Regression coverage for #636: YouTube publish dispatched through Composio
 * YOUTUBE_UPLOAD_VIDEO, gated behind ARIES_YOUTUBE_ENABLED.
 *
 * YouTube's native post is a VIDEO upload, but the Aries pipeline emits a single
 * still. The publisher synthesizes a short MP4 from the still (injected
 * synthesizer — the real one is ffmpeg-backed; here it is faked so CI needs no
 * binary), stages it via gateway.uploadFile, then uploads.
 *
 * Failure modes locked:
 *  1. Image post: synthesize once → uploadFile once (toolSlug=YOUTUBE_UPLOAD_VIDEO,
 *     toolkitSlug='youtube') → EXACTLY ONE executeTool(YOUTUBE_UPLOAD_VIDEO) with
 *     {videoFilePath: descriptor, title, description, tags, categoryId,
 *     privacyStatus}; result published; externalPostId from nested data.video.id;
 *     synthesized temp cleaned up. NEVER the Instagram slug/args.
 *  2. Multipart slug → the file arg is `videoFile` (not videoFilePath).
 *  3. No media → ComposioCapabilityMissingError; never-posted; no synth/upload/exec.
 *  4. Synthesis throw → ComposioToolError (never-posted); no uploadFile, no exec.
 *  5. uploadFile throw → ComposioToolError (never-posted); temp cleaned up; no exec.
 *  6. Slug unset → ComposioCapabilityMissingError BEFORE synthesis runs.
 *     Dry-run → no synth/gateway calls. Not-approved → PublishGuardError.
 *  7. Title truncation to 100; description truncation to 5000; privacyStatus
 *     default 'public' + env override; categoryId default '22' + env override.
 *  8. Dormancy: normalizeTargetPlatforms(['youtube']) → null when flag unset,
 *     ['youtube'] when =1. isMetaProvider('youtube')===false. Dispatch guard
 *     predicate 'youtube' && isYouTubeEnabled() false→true.
 *  9. metaPlatform routing: provider='youtube' reaches the seam with
 *     platform='youtube', NOT coerced to 'facebook'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveProjectRoot } from './helpers/project-root';
import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioToolError,
} from '@/backend/integrations/composio/errors';
import { publishNeverReachedPlatform } from '@/backend/integrations/publish-outcome';
import { isMetaProvider } from '@/backend/integrations/meta-publishing';
import { isYouTubeEnabled } from '@/backend/integrations/providers/integration-config';
import { normalizeTargetPlatforms } from '@/backend/social-content/scheduled-posts';
import { dispatchPublish } from '@/backend/integrations/publish-dispatch';
import type {
  ComposioGateway,
  ComposioFileDescriptor,
  ComposioFileUploadInput,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import type { StillToVideoResult } from '@/backend/integrations/still-to-video';
import type { PublisherProvider } from '@/backend/integrations/providers/interfaces';
import type { PublishPostInput } from '@/backend/integrations/providers/types';
import type { RecordedExecute } from './composio/helpers';
import { fakeConfig, fakeDb } from './composio/helpers';

const tenantId = '42';

// ── withEnv helper ──────────────────────────────────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, original] of prev) {
      if (original === undefined) delete process.env[k];
      else process.env[k] = original;
    }
  });
}

// ── Gateway tracking uploadFile + executeTool separately ────────────────────

function makeYouTubeGateway(opts?: {
  defaultResult?: GatewayToolResult;
  uploadFileShouldThrow?: Error;
}): ComposioGateway & {
  calls: RecordedExecute[];
  uploadFileCalls: ComposioFileUploadInput[];
} {
  const calls: RecordedExecute[] = [];
  const uploadFileCalls: ComposioFileUploadInput[] = [];
  const defaultResult: GatewayToolResult =
    opts?.defaultResult ?? { data: { video: { id: 'yt_vid_123' } }, successful: true, error: null };
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
      calls.push({ slug, options });
      return defaultResult;
    },
    async uploadFile(input: ComposioFileUploadInput): Promise<ComposioFileDescriptor> {
      uploadFileCalls.push(input);
      if (opts?.uploadFileShouldThrow) throw opts.uploadFileShouldThrow;
      return { name: 'video.mp4', mimetype: 'video/mp4', s3key: `s3/${input.toolSlug}/video.mp4` };
    },
  };
}

// ── Injected fake video synthesizer (no ffmpeg on CI) ───────────────────────

function makeFakeSynth(opts?: { shouldThrow?: Error }) {
  const state = { calls: [] as Array<{ image: string }>, cleanupCount: 0 };
  const fn = async (input: { image: string; durationSec?: number }): Promise<StillToVideoResult> => {
    state.calls.push({ image: input.image });
    if (opts?.shouldThrow) throw opts.shouldThrow;
    return {
      path: '/tmp/aries-yt-fake/video.mp4',
      cleanup: async () => {
        state.cleanupCount += 1;
      },
    };
  };
  return { fn, state };
}

const YT_ACTIONS = { publish_post: 'YOUTUBE_UPLOAD_VIDEO' } as const;

function youtubeDb(opts?: { noRow?: boolean }) {
  return fakeDb({
    connectionRow: opts?.noRow
      ? null
      : {
          id: 1,
          tenant_id: 42,
          external_user_id: 'aries-tenant-42',
          platform: 'youtube',
          provider: 'composio',
          connected_account_id: 'ca_youtube_123',
          auth_config_id: 'auth_cfg_test',
          external_account_id: 'UC_channel_1',
          external_account_name: 'Test Channel',
          status: 'connected',
          capabilities_json: null,
          last_capability_check_at: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Image post happy path
// ════════════════════════════════════════════════════════════════════════════

test('#636 YouTube image post: synthesize once → uploadFile once → EXACTLY ONE executeTool(YOUTUBE_UPLOAD_VIDEO) with {videoFilePath, title, description, tags, categoryId, privacyStatus}; videoId from data.video.id; temp cleaned up', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: YT_ACTIONS }),
    youtubeDb(),
    synth.fn,
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'youtube',
    content: 'My great post\nsecond line',
    mediaUrls: ['https://img/1.png'],
    approved: true,
  });

  // Synthesis: called once with the first media URL
  assert.equal(synth.state.calls.length, 1, 'synthesizer called exactly once');
  assert.equal(synth.state.calls[0].image, 'https://img/1.png', 'synth receives the first mediaUrl');
  assert.equal(synth.state.cleanupCount, 1, 'synthesized temp must be cleaned up');

  // Staging: called once with the synthesized path + youtube toolkit + publish slug
  assert.equal(gateway.uploadFileCalls.length, 1, 'uploadFile called exactly once');
  assert.equal(gateway.uploadFileCalls[0].file, '/tmp/aries-yt-fake/video.mp4', 'stages the synthesized MP4 path');
  assert.equal(gateway.uploadFileCalls[0].toolSlug, 'YOUTUBE_UPLOAD_VIDEO', 'uploadFile toolSlug is the publish action');
  assert.equal(gateway.uploadFileCalls[0].toolkitSlug, 'youtube', 'uploadFile toolkitSlug is "youtube"');

  // Upload: EXACTLY ONE executeTool, the publish action — NEVER an Instagram slug
  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'YOUTUBE_UPLOAD_VIDEO', 'the sole executeTool is the YouTube publish action');
  assert.notEqual(call.slug, 'INSTAGRAM_CREATE_POST', 'must NOT fall through to the Instagram slug');

  const args = call.options.arguments as Record<string, unknown>;
  const descriptor = args.videoFilePath as ComposioFileDescriptor;
  assert.ok(descriptor && typeof descriptor === 'object', 'videoFilePath must carry the staged descriptor');
  assert.equal(descriptor.s3key, 's3/YOUTUBE_UPLOAD_VIDEO/video.mp4', 'descriptor s3key from staging stub');
  assert.equal(descriptor.mimetype, 'video/mp4', 'descriptor mimetype from staging stub');
  assert.equal(args.title, 'My great post', 'title is the first non-empty line');
  assert.equal(args.description, 'My great post\nsecond line', 'description is the full content');
  assert.deepEqual(args.tags, [], 'tags defaults to an empty array');
  assert.equal(args.categoryId, '22', 'categoryId defaults to People & Blogs (22)');
  assert.equal(args.privacyStatus, 'public', 'privacyStatus defaults to public');
  // Instagram-only args must be absent
  assert.equal('caption' in args, false, 'must not carry an Instagram caption');
  assert.equal('media_urls' in args, false, 'must not carry Instagram media_urls');

  assert.equal(result.status, 'published');
  assert.equal(result.platform, 'youtube');
  assert.equal(result.provider, 'composio');
  assert.equal(result.externalPostId, 'yt_vid_123', 'externalPostId extracted from nested data.video.id');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Multipart slug → videoFile arg key
// ════════════════════════════════════════════════════════════════════════════

test('#636 multipart slug → the file arg is `videoFile` (not videoFilePath)', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_post: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO' } }),
    youtubeDb(),
    synth.fn,
  );

  await provider.publishPost({
    tenantId,
    platform: 'youtube',
    content: 'hi',
    mediaUrls: ['https://img/1.png'],
    approved: true,
  });

  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.ok('videoFile' in args, 'multipart action must use the videoFile arg key');
  assert.equal('videoFilePath' in args, false, 'multipart action must NOT use videoFilePath');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. No media → capability error, never-posted, nothing called
// ════════════════════════════════════════════════════════════════════════════

test('#636 no media → ComposioCapabilityMissingError; never-posted; no synth/upload/executeTool', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: YT_ACTIONS }),
    youtubeDb(),
    synth.fn,
  );

  let caught: unknown;
  try {
    await provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: [], approved: true });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ComposioCapabilityMissingError, 'no media must throw ComposioCapabilityMissingError');
  assert.equal(publishNeverReachedPlatform(caught), true, 'must be definitely-never-posted');
  assert.equal(synth.state.calls.length, 0, 'no synthesis without media');
  assert.equal(gateway.uploadFileCalls.length, 0, 'no uploadFile without media');
  assert.equal(gateway.calls.length, 0, 'no executeTool without media');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Synthesis throw → ComposioToolError, never-posted
// ════════════════════════════════════════════════════════════════════════════

test('#636 synthesis throw → ComposioToolError (never-posted); no uploadFile, no executeTool', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth({ shouldThrow: new Error('ffmpeg failed') });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: YT_ACTIONS }),
    youtubeDb(),
    synth.fn,
  );

  let caught: unknown;
  try {
    await provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: ['https://img/1.png'], approved: true });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ComposioToolError, 'synthesis failure must throw ComposioToolError');
  assert.equal(publishNeverReachedPlatform(caught), true, 'synthesis failure is definitely-never-posted');
  assert.equal(gateway.uploadFileCalls.length, 0, 'no staging after synth failure');
  assert.equal(gateway.calls.length, 0, 'no executeTool after synth failure');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. uploadFile throw → ComposioToolError, temp cleaned up, never-posted
// ════════════════════════════════════════════════════════════════════════════

test('#636 uploadFile throw → ComposioToolError (never-posted); synthesized temp cleaned up; no executeTool', async () => {
  const gateway = makeYouTubeGateway({ uploadFileShouldThrow: new Error('S3 staging failed') });
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: YT_ACTIONS }),
    youtubeDb(),
    synth.fn,
  );

  let caught: unknown;
  try {
    await provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: ['https://img/1.png'], approved: true });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ComposioToolError, 'staging failure must throw ComposioToolError');
  assert.equal(publishNeverReachedPlatform(caught), true, 'staging failure is definitely-never-posted');
  assert.equal(synth.state.cleanupCount, 1, 'temp must be cleaned up even when staging fails');
  assert.equal(gateway.calls.length, 0, 'no executeTool after staging failure');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Capability / dry-run / approval guards
// ════════════════════════════════════════════════════════════════════════════

test('#636 publish_post slug unset → ComposioCapabilityMissingError BEFORE synthesis runs', async () => {
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(
    makeYouTubeGateway(),
    fakeConfig({ actions: {} }),
    youtubeDb(),
    synth.fn,
  );
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: ['https://img/1.png'], approved: true }),
    ComposioCapabilityMissingError,
  );
  assert.equal(synth.state.calls.length, 0, 'synthesis must not run when the slug is unset');
});

test('#636 dry-run returns preview without synth or gateway calls', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: YT_ACTIONS }), youtubeDb(), synth.fn);
  const result = await provider.publishPost({
    tenantId,
    platform: 'youtube',
    content: 'hi',
    mediaUrls: ['https://img/1.png'],
    dryRun: true,
  });
  assert.equal(result.status, 'preview');
  assert.equal(synth.state.calls.length, 0, 'dry-run must not synthesize');
  assert.equal(gateway.uploadFileCalls.length, 0, 'dry-run must not stage');
  assert.equal(gateway.calls.length, 0, 'dry-run must not execute');
});

test('#636 not-approved throws PublishGuardError (no synth)', async () => {
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(makeYouTubeGateway(), fakeConfig({ actions: YT_ACTIONS }), youtubeDb(), synth.fn);
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: ['https://img/1.png'], approved: false }),
    PublishGuardError,
  );
  assert.equal(synth.state.calls.length, 0, 'no synthesis for an unapproved post');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Title / description / category / privacy resolution
// ════════════════════════════════════════════════════════════════════════════

test('#636 title truncates to 100 chars with ellipsis; description truncates to 5000', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: YT_ACTIONS }), youtubeDb(), synth.fn);
  const longLine = 'x'.repeat(250);
  const longBody = `${longLine}\n${'y'.repeat(6000)}`;
  await provider.publishPost({ tenantId, platform: 'youtube', content: longBody, mediaUrls: ['https://img/1.png'], approved: true });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  const title = args.title as string;
  const description = args.description as string;
  assert.equal(title.length, 100, 'title must be exactly 100 chars when truncated');
  assert.ok(title.endsWith('…'), 'truncated title ends with ellipsis');
  assert.equal(description.length, 5000, 'description must be exactly 5000 chars when truncated');
  assert.ok(description.endsWith('…'), 'truncated description ends with ellipsis');
});

test('#636 empty content → fallback title "New post"', async () => {
  const gateway = makeYouTubeGateway();
  const synth = makeFakeSynth();
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: YT_ACTIONS }), youtubeDb(), synth.fn);
  await provider.publishPost({ tenantId, platform: 'youtube', content: '   \n  ', mediaUrls: ['https://img/1.png'], approved: true });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.title, 'New post', 'empty content yields the fallback title');
});

test('#636 COMPOSIO_YOUTUBE_PRIVACY_STATUS + CATEGORY_ID env overrides are honored', async () => {
  await withEnv({ COMPOSIO_YOUTUBE_PRIVACY_STATUS: 'unlisted', COMPOSIO_YOUTUBE_CATEGORY_ID: '27' }, async () => {
    const gateway = makeYouTubeGateway();
    const synth = makeFakeSynth();
    const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: YT_ACTIONS }), youtubeDb(), synth.fn);
    await provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: ['https://img/1.png'], approved: true });
    const args = gateway.calls[0].options.arguments as Record<string, unknown>;
    assert.equal(args.privacyStatus, 'unlisted', 'privacyStatus honors the env override');
    assert.equal(args.categoryId, '27', 'categoryId honors the env override');
  });
});

test('#636 an unrecognized privacy status falls back to public', async () => {
  await withEnv({ COMPOSIO_YOUTUBE_PRIVACY_STATUS: 'bogus' }, async () => {
    const gateway = makeYouTubeGateway();
    const synth = makeFakeSynth();
    const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: YT_ACTIONS }), youtubeDb(), synth.fn);
    await provider.publishPost({ tenantId, platform: 'youtube', content: 'hi', mediaUrls: ['https://img/1.png'], approved: true });
    const args = gateway.calls[0].options.arguments as Record<string, unknown>;
    assert.equal(args.privacyStatus, 'public', 'unrecognized privacy status falls back to public');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Dormancy: scheduling allowlist + dispatch guard predicates
// ════════════════════════════════════════════════════════════════════════════

test("#636 normalizeTargetPlatforms: flag OFF → ['youtube'] returns null", async () => {
  await withEnv({ ARIES_YOUTUBE_ENABLED: undefined }, () => {
    assert.equal(normalizeTargetPlatforms(['youtube']), null, 'youtube rejected when the flag is off');
  });
});

test("#636 normalizeTargetPlatforms: flag OFF → ['facebook','instagram'] still accepted", async () => {
  await withEnv({ ARIES_YOUTUBE_ENABLED: undefined }, () => {
    assert.deepEqual(normalizeTargetPlatforms(['facebook', 'instagram']), ['facebook', 'instagram']);
  });
});

test("#636 normalizeTargetPlatforms: flag ON → ['youtube'] accepted", async () => {
  await withEnv({ ARIES_YOUTUBE_ENABLED: '1' }, () => {
    assert.deepEqual(normalizeTargetPlatforms(['youtube']), ['youtube']);
  });
});

test('#636 isMetaProvider(youtube) is false — youtube never routes via the direct-Meta fast path', () => {
  assert.equal(isMetaProvider('youtube'), false);
});

test('#636 dispatch guard: youtube rejected when flag off, admitted when on', async () => {
  await withEnv({ ARIES_YOUTUBE_ENABLED: undefined }, () => {
    const isYouTubePublish = 'youtube' === 'youtube' && isYouTubeEnabled();
    assert.equal(!isMetaProvider('youtube') && !isYouTubePublish, true, 'youtube rejected when flag off');
  });
  await withEnv({ ARIES_YOUTUBE_ENABLED: '1' }, () => {
    const isYouTubePublish = 'youtube' === 'youtube' && isYouTubeEnabled();
    assert.equal(!isMetaProvider('youtube') && !isYouTubePublish, false, 'youtube admitted when flag on');
  });
});

test('#636 the scheduled-dispatch route actually wires the flag-gated youtube admit clause', () => {
  // Guards the REAL gate (the predicate test above only checks the logic in
  // isolation): if someone drops the youtube clause from the route, this fails.
  const routeSrc = readFileSync(
    path.join(resolveProjectRoot(import.meta.url), 'app', 'api', 'internal', 'publishing', 'scheduled-dispatch', 'route.ts'),
    'utf8',
  );
  assert.match(routeSrc, /isYouTubePublish\s*=\s*platform[^\n]*===\s*'youtube'\s*&&\s*isYouTubeEnabled\(\)/, 'route must derive isYouTubePublish behind isYouTubeEnabled()');
  assert.match(routeSrc, /!isYouTubePublish/, 'route admit gate must include the youtube clause');
});

// ════════════════════════════════════════════════════════════════════════════
// 9. metaPlatform routing
// ════════════════════════════════════════════════════════════════════════════

test('#636 metaPlatform routing: provider=youtube reaches the seam with platform=youtube, NOT coerced to facebook', async () => {
  const calls: PublishPostInput[] = [];
  const provider: PublisherProvider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput) => {
      calls.push(input);
      return {
        provider: 'composio',
        platform: 'youtube' as const,
        externalPostId: 'yt_vid_routed',
        externalCampaignId: null,
        externalAdId: null,
        status: 'published' as const,
        url: 'https://youtu.be/yt_vid_routed',
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
    { tenantId: '42', provider: 'youtube', content: 'hello youtube', mediaUrls: [], scheduledFor: null },
    {
      selector: () => 'composio',
      directPublish: async () => {
        throw new Error('youtube must never reach the direct-Meta path');
      },
      publisherProvider: () => provider,
    },
  );

  assert.equal(calls.length, 1, 'exactly one publishPost call');
  assert.equal(calls[0].platform, 'youtube', 'youtube reaches the seam with platform=youtube');
  assert.notEqual(calls[0].platform, 'facebook', 'youtube must NOT be coerced to facebook');
  assert.equal(out.platformPostId, 'yt_vid_routed');
  assert.ok(out.connectionId.includes(':youtube'), `connectionId must reference 'youtube', got: ${out.connectionId}`);
});
