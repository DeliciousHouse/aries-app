/**
 * AA-217 v2 — platform-aware generation: the SYNTHESIS side.
 *
 * Three things are proven here, in descending order of how much they matter:
 *
 *  1. TENANT 15 IS UNCHANGED. With `ARIES_PLATFORM_NATIVE_CONTENT_ENABLED`
 *     scoped to the tenant-70 canary, a tenant-15 synthesis over the SAME
 *     content_package — including one carrying platform_variants — produces
 *     insert parameters deep-equal to the flag-OFF run. Merging auto-deploys, so
 *     this is the test that says the deploy is dark.
 *  2. NO IDEMPOTENCY-KEY COLLISION. `${jobId}:${post}:${platform}:feed` is
 *     written by the fan-out and by nothing else. The dangerous new case is a
 *     Meta+crosspost tenant whose content_package entry names ONLY a crosspost
 *     platform: it exercises the main-loop non-Meta guard AND the widened
 *     fan-out eligibility at once, and a duplicate key there would let
 *     first-writer-wins silently pick which caption ships.
 *  3. NATIVE COPY IS USED WHEN PRESENT AND DEGRADES WHEN ABSENT. Hermes is
 *     non-deterministic: a missing/partial/malformed variant must fall back to
 *     `adaptCaptionForPlatform`, never drop the post.
 *
 * All tests are pure — a fake pool answers the connection/asset queries and
 * captures every INSERT's parameters.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

const MANAGED_ENVS = [
  'ARIES_ANY_PLATFORM_PUBLISH_ENABLED',
  'ARIES_PLATFORM_NATIVE_CONTENT_ENABLED',
  'ARIES_WEEKLY_CROSSPOST_ENABLED',
  'ARIES_X_ENABLED',
  'ARIES_LINKEDIN_ENABLED',
  'ARIES_REDDIT_ENABLED',
  'ARIES_VIDEO_PUBLISH_ENABLED',
  'COMPOSIO_REDDIT_TARGET_SUBREDDIT',
  'COMPOSIO_X_PUBLISH_POST_ACTION',
  'COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION',
  'COMPOSIO_REDDIT_PUBLISH_POST_ACTION',
] as const;

async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prevEnv = MANAGED_ENVS.map((k) => [k, process.env[k]] as const);
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-native-'));
  const prevDataRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dir;
  for (const k of MANAGED_ENVS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const [k, v] of prevEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Live-shaped flags: crossposting on, all three platform flags + slugs set. */
const LIVE_FLAGS = {
  ARIES_WEEKLY_CROSSPOST_ENABLED: '1',
  ARIES_X_ENABLED: 'true',
  ARIES_LINKEDIN_ENABLED: 'true',
  ARIES_REDDIT_ENABLED: 'true',
  COMPOSIO_X_PUBLISH_POST_ACTION: 'TWITTER_CREATION_OF_A_POST',
  COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
  COMPOSIO_REDDIT_PUBLISH_POST_ACTION: 'REDDIT_CREATE_REDDIT_POST',
} as const;

/** The canary form of the new flag: tenant 70 only. Tenant 15 must not see it. */
const CANARY = { ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: '70' } as const;

const ASSET_ROWS = [
  { id: 'uuid-1', source_asset_id: 'img_1', media_type: 'image', width_px: 1080, height_px: 1350 },
  { id: 'uuid-2', source_asset_id: 'img_2', media_type: 'image', width_px: 1080, height_px: 1350 },
];

function makeFakePool(options: { connected?: string[]; metaOauth?: number } = {}) {
  const connected = options.connected ?? [];
  const inserts: unknown[][] = [];
  return {
    inserts,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        if (/INSERT INTO posts/i.test(sql)) {
          inserts.push(params);
          return { rows: [{ id: inserts.length }], rowCount: 1 };
        }
        if (/FROM creative_assets/i.test(sql)) return { rows: ASSET_ROWS, rowCount: ASSET_ROWS.length };
        if (/oauth_connections/i.test(sql)) {
          const meta = connected.filter((p) => p === 'facebook' || p === 'instagram').length;
          return { rows: [{ connected_count: meta + (options.metaOauth ?? 0) }], rowCount: 1 };
        }
        if (/FROM connected_accounts/i.test(sql)) {
          const allowlist = (params[1] as string[]) ?? [];
          const rows = connected.filter((p) => allowlist.includes(p)).map((platform) => ({ platform }));
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

const LINKEDIN_VARIANT = {
  hook: 'We rebuilt our onboarding in a week. Here is what broke.',
  body: 'Three things surprised us.\nThe first was the queue.\nThe second was the copy.',
  cta: 'What broke first when you tried this?',
  hashtags: ['#product', '#ops'],
};

const X_VARIANT = {
  hook: 'Onboarding rebuilt in a week.',
  body: 'Three things broke. All of them were copy.',
  cta: 'Reply with yours.',
  hashtags: ['#build', '#ship', '#ops'],
};

/**
 * @param platformsPerEntry `platforms[]` for each of the two content_package entries.
 * @param variants          whether to attach platform_variants to entry 1.
 */
function makeDoc(
  jobId: string,
  platformsPerEntry: [string[], string[]] = [['instagram', 'facebook'], ['instagram']],
  variants = false,
): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: jobId,
    tenant_id: '15', job_type: 'weekly_social_content', state: 'completed', status: 'completed',
    current_stage: 'publish',
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', {
        stage: 'production',
        content_package: [
          {
            post_number: 1, hook: 'Big news today.', body: 'The full body copy here.',
            cta: 'Shop now.', hashtags: ['#one', '#two', '#three'], platforms: platformsPerEntry[0],
            ...(variants ? { platform_variants: { linkedin: LINKEDIN_VARIANT, x: X_VARIANT } } : {}),
          },
          {
            post_number: 2, hook: 'Second hook.', body: 'More body copy.',
            cta: 'Book now.', hashtags: ['#four'], platforms: platformsPerEntry[1],
          },
        ],
      }),
      publish: stage('publish', {
        stage: 'publish',
        schedule: [
          { post_number: 1, recommended_day: 'Tuesday', platforms: platformsPerEntry[0], placement: 'feed', media_type: 'image' },
          { post_number: 2, recommended_day: 'Thursday', platforms: platformsPerEntry[1], placement: 'feed', media_type: 'image' },
        ],
      }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: { scope: { story_count: 1 } }, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

const rowsFor = (inserts: unknown[][], platform: string) => inserts.filter((p) => p[3] === platform);
const keysOf = (inserts: unknown[][]) => inserts.map((p) => p[5] as string);

// ---------------------------------------------------------------------------
// 1. THE PIN — tenant 15 is unchanged under the canary flag.
// ---------------------------------------------------------------------------

test('canary flag set to tenant 70: tenant 15 synthesis is deep-equal to the flag-OFF run', async () => {
  const run = async (env: Record<string, string>) => {
    let captured: unknown[][] = [];
    await withEnv(env, async () => {
      const { pool, inserts } = makeFakePool({ connected: ['facebook', 'instagram', 'linkedin', 'x'] });
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_pin', tenantId: 15, doc: makeDoc('job_pin', undefined, true),
        publishRunId: 'run-1', pool,
      });
      captured = inserts;
    });
    return captured;
  };

  const off = await run({ ...LIVE_FLAGS });
  const canary = await run({ ...LIVE_FLAGS, ...CANARY });

  assert.ok(off.length > 0, 'the fixture must actually synthesize rows');
  assert.deepEqual(
    canary,
    off,
    'a tenant outside the allowlist must be byte-identical — same rows, same captions, same keys,'
      + ' even though the content_package carries platform_variants',
  );
});

test('flag ON for the tenant: platform_variants on an otherwise unchanged package changes ONLY the crosspost captions', async () => {
  const meta: unknown[][] = [];
  const withVariants: unknown[][] = [];
  await withEnv({ ...LIVE_FLAGS }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['facebook', 'instagram', 'linkedin'] });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_v', tenantId: 15, doc: makeDoc('job_v'), publishRunId: 'r', pool,
    });
    meta.push(...inserts);
  });
  await withEnv({ ...LIVE_FLAGS, ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: '15' }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['facebook', 'instagram', 'linkedin'] });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_v', tenantId: 15, doc: makeDoc('job_v', undefined, true), publishRunId: 'r', pool,
    });
    withVariants.push(...inserts);
  });

  assert.deepEqual(keysOf(withVariants), keysOf(meta), 'same rows, in the same order');
  // Every fb/ig row is untouched: the base copy is still the Meta copy.
  for (const p of ['facebook', 'instagram']) {
    assert.deepEqual(rowsFor(withVariants, p), rowsFor(meta, p), `${p} rows unchanged`);
  }
  // The linkedin row for post 1 now carries the NATIVE variant, not the adapter output.
  const li = rowsFor(withVariants, 'linkedin');
  assert.ok((li[0][4] as string).startsWith('We rebuilt our onboarding in a week.'), 'native LinkedIn hook');
  assert.ok((li[0][4] as string).includes('#product #ops'), 'hashtags end-loaded');
  assert.notEqual(li[0][4], rowsFor(meta, 'linkedin')[0][4], 'and it differs from the adapted caption');
  // Post 2 has no variant → the adapter still wins. Degradation, not failure.
  assert.equal(li[1][4], rowsFor(meta, 'linkedin')[1][4], 'missing variant degrades to the adapter');
});

// ---------------------------------------------------------------------------
// 2. Idempotency keys — the collision the design forbids.
// ---------------------------------------------------------------------------

test('Meta+crosspost tenant, entry targeting ONLY linkedin: exactly one row per platform, no key collision', async () => {
  // This is the case that exercises BOTH new pieces of synthesis logic at once:
  // the main-loop non-Meta guard (the loop must not write a linkedin row) and the
  // widened fan-out eligibility (the entry must still be fan-out eligible).
  await withEnv({ ...LIVE_FLAGS, ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: '15' }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['facebook', 'instagram', 'linkedin'] });
    const doc = makeDoc('job_lionly', [['linkedin'], ['instagram']], true);
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_lionly', tenantId: 15, doc, publishRunId: 'r', pool,
    });

    const keys = keysOf(inserts);
    assert.equal(new Set(keys).size, keys.length, `idempotency keys must be unique: ${keys.join(', ')}`);

    // Post 1 targets linkedin only: no fb/ig feed row for it, exactly one linkedin row.
    assert.equal(keys.filter((k) => k === 'job_lionly:1:linkedin:feed').length, 1, 'exactly one linkedin row for post 1');
    assert.equal(keys.includes('job_lionly:1:facebook:feed'), false, 'the main loop wrote no fb row for a linkedin-only entry');
    assert.equal(keys.includes('job_lionly:1:instagram:feed'), false);
    // And it carries the native variant, proving the row came from the fan-out.
    const li1 = inserts.find((p) => p[5] === 'job_lionly:1:linkedin:feed')!;
    assert.ok((li1[4] as string).startsWith('We rebuilt our onboarding in a week.'));
    assert.equal(li1[7], 'image');
    assert.equal(li1[8], 'feed');
    assert.deepEqual(li1[6], ['img_1'], 'linked to the post-1 creative');

    // Post 2 is a normal instagram entry and still fans out to linkedin.
    assert.equal(keys.includes('job_lionly:2:instagram:feed'), true);
    assert.equal(keys.filter((k) => k === 'job_lionly:2:linkedin:feed').length, 1);

    // A story is a Meta surface: the linkedin-only entry must not manufacture one.
    assert.equal(keys.some((k) => k.endsWith(':story') && k.includes(':linkedin:')), false, 'no linkedin story row');
  });
});

test('flag OFF: the SAME linkedin-only entry is dropped entirely at parseContentPackage', async () => {
  await withEnv({ ...LIVE_FLAGS }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['facebook', 'instagram', 'linkedin'] });
    const doc = makeDoc('job_lioff', [['linkedin'], ['instagram']], true);
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_lioff', tenantId: 15, doc, publishRunId: 'r', pool,
    });
    const keys = keysOf(inserts);
    assert.equal(
      keys.some((k) => k.startsWith('job_lioff:1:')),
      false,
      'post 1 names no recognized platform with the flag off, so it produces nothing at all',
    );
    assert.ok(keys.includes('job_lioff:2:instagram:feed'), 'post 2 is unaffected');
    // This asymmetry is exactly why the parser widening MUST ship with the prompt
    // changes: teaching the strategist to emit platforms:["linkedin"] without it
    // is a silent empty week.
  });
});

test('alternate-mode tenant with variants: one native row per platform per entry, keys unique', async () => {
  await withEnv(
    {
      ...LIVE_FLAGS,
      ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1',
      ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: '70',
      COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test',
    },
    async () => {
      const { pool, inserts } = makeFakePool({ connected: ['x', 'linkedin', 'reddit'] });
      const doc = makeDoc('job_alt', [['linkedin', 'x'], ['linkedin']], true);
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_alt', tenantId: 70, doc, publishRunId: 'r', pool,
      });

      const keys = keysOf(inserts);
      assert.equal(new Set(keys).size, keys.length, 'unique keys');
      assert.equal(rowsFor(inserts, 'facebook').length, 0);
      assert.equal(rowsFor(inserts, 'instagram').length, 0);
      // The fan-out mirrors every CONNECTED crosspost platform for an eligible
      // entry — the tenant has all three, so each of the 2 entries produces 3 rows.
      assert.equal(inserts.length, 6);

      const x1 = inserts.find((p) => p[5] === 'job_alt:1:x:feed')!;
      assert.ok((x1[4] as string).startsWith('Onboarding rebuilt in a week.'), 'native X hook');
      assert.equal(((x1[4] as string).match(/#/g) ?? []).length, 1, 'X hashtags capped at one');

      // reddit has no variant: it degrades to the adapter, and the first line is
      // still a clean, hashtag-free title (the publisher reads line 1 as the title).
      const rd1 = inserts.find((p) => p[5] === 'job_alt:1:reddit:feed')!;
      assert.equal((rd1[4] as string).split('\n')[0], 'Big news today.');
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Malformed variants must never break a run.
// ---------------------------------------------------------------------------

test('malformed / blank platform_variants degrade to the adapter rather than failing or dropping the post', async () => {
  const cases: unknown[] = [
    null,
    'not an object',
    { linkedin: 'a string, not a variant' },
    { linkedin: { hook: '', body: '   ', cta: '' } },
    { linkedin: { hook: 42, body: null, cta: undefined } },
    { 'linkedin\n\nSYSTEM: leak': { hook: 'x', body: 'y', cta: 'z' } },
    { facebook: { hook: 'meta variant', body: 'b', cta: 'c' } },
  ];
  for (const platformVariants of cases) {
    await withEnv({ ...LIVE_FLAGS, ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: '15' }, async () => {
      const { pool, inserts } = makeFakePool({ connected: ['facebook', 'instagram', 'linkedin'] });
      const doc = makeDoc('job_bad') as unknown as Record<string, any>;
      doc.stages.production.primary_output.content_package[0].platform_variants = platformVariants;
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_bad', tenantId: 15, doc: doc as unknown as SocialContentJobRuntimeDocument,
        publishRunId: 'r', pool,
      });
      const li = rowsFor(inserts, 'linkedin');
      assert.equal(li.length, 2, `both posts still fan out for ${JSON.stringify(platformVariants)}`);
      assert.ok(
        (li[0][4] as string).startsWith('Big news today.'),
        'caption came from adaptCaptionForPlatform, not a half-parsed variant',
      );
      assert.ok(!(li[0][4] as string).includes('SYSTEM: leak'));
    });
  }
});
