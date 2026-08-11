/**
 * AA-217 — primary-platform selection in synthesis.
 *
 * Two things must hold, and one of them matters far more than the other:
 *
 *  1. A tenant with a Meta connection is BYTE-IDENTICAL with the flag on or
 *     off. This is the #1 regression risk of the whole ticket (tenant 15 is
 *     publishing today), so it is pinned at the insert-parameter level: the
 *     full captured INSERT argument arrays must deep-equal between a flag-OFF
 *     run and a flag-ON run over the same content_package.
 *  2. A tenant with NO Meta but a connected x/linkedin/reddit channel produces
 *     the week's posts on those platforms — and produces EXACTLY the rows the
 *     crosspost fan-out would have produced for the same content_package, since
 *     both go through the same code.
 *
 * All tests are pure: a fake pool answers the creative_assets, connection-count
 * and connected_accounts queries, and captures every INSERT's parameters.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePrimaryPublishPlatforms } from '../backend/marketing/primary-publish-platforms';
import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MANAGED_ENVS = [
  'ARIES_ANY_PLATFORM_PUBLISH_ENABLED',
  'ARIES_WEEKLY_CROSSPOST_ENABLED',
  'ARIES_X_ENABLED',
  'ARIES_LINKEDIN_ENABLED',
  'ARIES_REDDIT_ENABLED',
  'ARIES_VIDEO_PUBLISH_ENABLED',
  'COMPOSIO_ENABLED',
  'COMPOSIO_REDDIT_TARGET_SUBREDDIT',
  'COMPOSIO_X_PUBLISH_POST_ACTION',
  'COMPOSIO_X_UPLOAD_MEDIA_ACTION',
  'COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION',
  'COMPOSIO_REDDIT_PUBLISH_POST_ACTION',
] as const;

async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prevEnv = MANAGED_ENVS.map((k) => [k, process.env[k]] as const);
  const dir = await mkdtemp(path.join(tmpdir(), 'synth-primary-'));
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

/**
 * Flags matching the live app container: crossposting on, all three platform
 * rollout flags on, all three COMPOSIO_<P>_PUBLISH_POST_ACTION slugs plus X's
 * image-upload slug set, and reddit deliberately unconfigured (no target). A
 * platform missing
 * its publish slug is not publishable at all, so the slugs are part of what
 * "live" means here.
 */
const LIVE_FLAGS = {
  ARIES_WEEKLY_CROSSPOST_ENABLED: '1',
  ARIES_X_ENABLED: 'true',
  ARIES_LINKEDIN_ENABLED: 'true',
  ARIES_REDDIT_ENABLED: 'true',
  COMPOSIO_ENABLED: 'true',
  COMPOSIO_X_PUBLISH_POST_ACTION: 'TWITTER_CREATION_OF_A_POST',
  COMPOSIO_X_UPLOAD_MEDIA_ACTION: 'TWITTER_UPLOAD_MEDIA',
  COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
  COMPOSIO_REDDIT_PUBLISH_POST_ACTION: 'REDDIT_CREATE_REDDIT_POST',
} as const;

const ASSET_ROWS = [
  { id: 'uuid-1', source_asset_id: 'img_1', media_type: 'image', width_px: 1080, height_px: 1080 },
  { id: 'uuid-2', source_asset_id: 'img_2', media_type: 'image', width_px: 1080, height_px: 1080 },
];

/**
 * Fake pool. `connected` is the tenant's `connected_accounts` rows (all
 * status='connected'); `metaOauth` is the count of legacy direct-Meta
 * `oauth_connections` rows. Answers the AA-217 connection-count query, the
 * crosspost connected-account query and the creative_assets lookup, and records
 * every INSERT's parameters plus which queries were issued.
 */
function makeFakePool(options: {
  connected?: string[];
  externalAccountIds?: Partial<Record<string, string | null>>;
  metaOauth?: number;
  failMetaCount?: boolean;
  insertConflicts?: boolean;
} = {}) {
  const connected = options.connected ?? [];
  const inserts: unknown[][] = [];
  const seenSql: string[] = [];
  return {
    inserts,
    seenSql,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        seenSql.push(sql);
        if (/INSERT INTO posts/i.test(sql)) {
          inserts.push(params);
          return options.insertConflicts
            ? { rows: [], rowCount: 0 }
            : { rows: [{ id: inserts.length }], rowCount: 1 };
        }
        if (/FROM creative_assets/i.test(sql)) {
          return { rows: ASSET_ROWS, rowCount: ASSET_ROWS.length };
        }
        // The AA-217 connection-count query reads BOTH stores in one statement.
        if (/oauth_connections/i.test(sql)) {
          if (options.failMetaCount) throw new Error('connection lookup exploded');
          const metaConnected = connected.filter((p) => p === 'facebook' || p === 'instagram').length;
          return {
            rows: [{ connected_count: metaConnected + (options.metaOauth ?? 0) }],
            rowCount: 1,
          };
        }
        // The crosspost eligibility query: $2 is the flag-enabled allowlist.
        if (/FROM connected_accounts/i.test(sql)) {
          const allowlist = (params[1] as string[]) ?? [];
          const rows = connected
            .filter((p) => allowlist.includes(p))
            .map((platform) => ({
              platform,
              connected_account_id: `ca_${platform}`,
              external_account_id: options.externalAccountIds?.[platform] ?? null,
            }));
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

/**
 * Two feed-image posts on instagram+facebook, plus a story budget of 1 — the
 * shape of a real weekly run, exercising the main loop, the fan-out and the
 * story promotion in one document.
 */
function makeDoc(jobId: string): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: jobId,
    tenant_id: '70', job_type: 'weekly_social_content', state: 'completed', status: 'completed',
    current_stage: 'publish',
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'Big news today.', body: 'The full body copy here.', cta: 'Shop now.', hashtags: ['#one', '#two', '#three'], platforms: ['instagram', 'facebook'] },
          { post_number: 2, hook: 'Second hook.', body: 'More body copy.', cta: 'Book now.', hashtags: ['#four'], platforms: ['instagram'] },
        ],
      }),
      publish: stage('publish', {
        stage: 'publish',
        schedule: [
          { post_number: 1, platforms: ['instagram', 'facebook'], placement: 'feed', media_type: 'image' },
          { post_number: 2, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
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

/** A doc whose post 2 is a reel (video) and post 1 a feed image. */
function makeMixedDoc(jobId: string): SocialContentJobRuntimeDocument {
  const doc = makeDoc(jobId) as unknown as Record<string, any>;
  doc.stages.publish.primary_output.schedule = [
    { post_number: 1, platforms: ['instagram', 'facebook'], placement: 'feed', media_type: 'image' },
    { post_number: 2, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
  ];
  return doc as unknown as SocialContentJobRuntimeDocument;
}

const rowsFor = (inserts: unknown[][], platform: string) => inserts.filter((p) => p[3] === platform);

// ---------------------------------------------------------------------------
// (a) THE PIN: a Meta tenant is byte-identical with the flag ON.
// ---------------------------------------------------------------------------

test('Meta tenant: flag ON produces insert params deep-equal to flag OFF (byte-identical pin)', async () => {
  let offInserts: unknown[][] = [];
  await withEnv({ ...LIVE_FLAGS }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['facebook', 'instagram', 'linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
    });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_pin', tenantId: 15, doc: makeDoc('job_pin'), publishRunId: 'run-1', pool,
    });
    offInserts = inserts;
  });

  let onInserts: unknown[][] = [];
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['facebook', 'instagram', 'linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
    });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_pin', tenantId: 15, doc: makeDoc('job_pin'), publishRunId: 'run-1', pool,
    });
    onInserts = inserts;
  });

  assert.ok(offInserts.length > 0, 'the fixture must actually synthesize rows');
  assert.deepEqual(
    onInserts,
    offInserts,
    'every synthesized row — order, platform, caption, key, assets, story promotion, crosspost fan-out — must be unchanged for a Meta tenant',
  );
});

test('Meta tenant via the LEGACY oauth_connections store only: flag ON still resolves meta mode', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    // No connected_accounts Meta row at all — only a direct-Meta OAuth row.
    const { pool } = makeFakePool({ connected: ['linkedin'], metaOauth: 1 });
    const resolution = await resolvePrimaryPublishPlatforms(15, pool);
    assert.deepEqual(resolution, { mode: 'meta' });
  });
});

// ---------------------------------------------------------------------------
// (b) LinkedIn-only — the AA-168 tenant.
// ---------------------------------------------------------------------------

test('LinkedIn-only tenant: the week synthesizes linkedin feed rows and no fb/ig or story rows', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
    });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_li', tenantId: 70, doc: makeDoc('job_li'), publishRunId: 'run-1', pool,
    });

    assert.equal(rowsFor(inserts, 'facebook').length, 0, 'no facebook rows');
    assert.equal(rowsFor(inserts, 'instagram').length, 0, 'no instagram rows');
    const li = rowsFor(inserts, 'linkedin');
    // One row per content_package entry — both entries have a feed image.
    assert.equal(li.length, 2);
    assert.deepEqual(
      li.map((p) => p[5]),
      ['job_li:1:linkedin:feed', 'job_li:2:linkedin:feed'],
      'idempotency keys carry the platform and the feed surface',
    );
    for (const row of li) {
      assert.equal(row[7], 'image', 'media_type image');
      assert.equal(row[8], 'feed', 'surface feed');
    }
    assert.deepEqual(li[0][6], ['img_1'], 'row 1 links the first rendered creative');
    assert.deepEqual(li[1][6], ['img_2'], 'row 2 links the second rendered creative');
    assert.ok((li[0][4] as string).includes('Big news today.'), 'caption is the adapted post copy');
    assert.equal(inserts.length, 2, 'no story rows and no duplicate fan-out rows');
    assert.ok(result.inserted >= 2);
    assert.equal(result.reason, undefined);
  });
});

test('LinkedIn-only tenant without an author URN: mode none, zero rows synthesized', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['linkedin'],
      externalAccountIds: { linkedin: null },
    });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_li_no_urn', tenantId: 70, doc: makeDoc('job_li_no_urn'), publishRunId: null, pool,
    });
    assert.equal(result.reason, 'no_connected_platform');
    assert.equal(inserts.length, 0);
  });
});

test('LinkedIn-only rows are IDENTICAL to the crosspost linkedin rows for the same content_package (parity)', async () => {
  // A Meta+LinkedIn tenant's fan-out is the reference implementation. A
  // LinkedIn-only tenant must get exactly those rows, minus the Meta originals
  // — same captions, same keys, same asset linkage, same count.
  let crosspostLinkedIn: unknown[][] = [];
  await withEnv({ ...LIVE_FLAGS }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['facebook', 'instagram', 'linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
    });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_par', tenantId: 15, doc: makeDoc('job_par'), publishRunId: 'run-1', pool,
    });
    crosspostLinkedIn = rowsFor(inserts, 'linkedin');
  });

  let alternateLinkedIn: unknown[][] = [];
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
    });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_par', tenantId: 15, doc: makeDoc('job_par'), publishRunId: 'run-1', pool,
    });
    alternateLinkedIn = rowsFor(inserts, 'linkedin');
  });

  assert.ok(crosspostLinkedIn.length > 0, 'the reference fan-out must produce rows');
  assert.deepEqual(alternateLinkedIn, crosspostLinkedIn);
});

test('LinkedIn-only: a replayed synthesis is a no-op (ON CONFLICT), never a duplicate row', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({
      connected: ['linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
      insertConflicts: true,
    });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_li_replay', tenantId: 70, doc: makeDoc('job_li_replay'), publishRunId: 'run-1', pool,
    });
    // Same keys as the first run; the unique index absorbs them.
    assert.deepEqual(
      inserts.map((p) => p[5]),
      ['job_li_replay:1:linkedin:feed', 'job_li_replay:2:linkedin:feed'],
    );
    assert.equal(result.inserted, 0, 'nothing newly inserted on replay');
  });
});

// ---------------------------------------------------------------------------
// (c)/(d) X-only and Reddit-only.
// ---------------------------------------------------------------------------

test('X-only tenant: rows carry the weighted-capped X caption', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['x'] });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_x', tenantId: 71, doc: makeDoc('job_x'), publishRunId: null, pool,
    });
    const rows = rowsFor(inserts, 'x');
    assert.equal(rows.length, 2);
    assert.equal(inserts.length, 2, 'only x rows');
    // buildXCaption: hook + up to two hashtags.
    assert.equal(rows[0][4], 'Big news today. #one #two');
  });
});

test('alternate primary rows use Hermes-native platform copy instead of adapting the Meta caption', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const doc = makeDoc('job_native') as unknown as Record<string, any>;
    doc.stages.production.primary_output.content_package[0].platforms = ['linkedin'];
    doc.stages.production.primary_output.content_package[0].platform_content = {
      linkedin: {
        hook: 'A LinkedIn-native opening',
        body: 'A considered professional post written for the LinkedIn feed.',
        cta: 'Share your experience in the comments.',
        hashtags: ['#Leadership'],
        placement: 'feed',
        media_type: 'image',
      },
    };
    const { pool, inserts } = makeFakePool({
      connected: ['linkedin'],
      externalAccountIds: { linkedin: 'urn:li:person:test' },
    });

    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_native', tenantId: 70, doc: doc as unknown as SocialContentJobRuntimeDocument,
      publishRunId: null, pool,
    });

    assert.equal(
      rowsFor(inserts, 'linkedin')[0][4],
      'A LinkedIn-native opening\n\nA considered professional post written for the LinkedIn feed.\n\nShare your experience in the comments.\n\n#Leadership',
    );
  });
});

test('Meta primary rows use Hermes-native platform copy when the platform_content contract is present', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const doc = makeDoc('job_meta_native') as unknown as Record<string, any>;
    doc.stages.production.primary_output.content_package[0].platform_content = {
      facebook: {
        hook: 'A Facebook-native opening',
        body: 'Conversational Meta feed copy.',
        cta: 'Tell us what you think.',
        hashtags: ['#Community'],
        placement: 'feed',
        media_type: 'image',
      },
    };
    const { pool, inserts } = makeFakePool({ connected: ['facebook'] });

    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_meta_native', tenantId: 15,
      doc: doc as unknown as SocialContentJobRuntimeDocument, publishRunId: null, pool,
    });

    assert.equal(
      rowsFor(inserts, 'facebook')[0][4],
      'A Facebook-native opening\n\nConversational Meta feed copy.\n\nTell us what you think.\n\n#Community',
    );
  });
});

test('X-only tenant with no upload_media slug: mode none, zero image rows synthesized', async () => {
  const { COMPOSIO_X_UPLOAD_MEDIA_ACTION: _, ...withoutUpload } = LIVE_FLAGS;
  await withEnv({ ...withoutUpload, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['x'] });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_x_no_upload', tenantId: 71, doc: makeDoc('job_x_no_upload'), publishRunId: null, pool,
    });
    assert.equal(result.reason, 'no_connected_platform');
    assert.equal(inserts.length, 0);
  });
});

test('Reddit-only tenant with a configured subreddit: rows serialize title then body', async () => {
  await withEnv(
    { ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1', COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test' },
    async () => {
      const { pool, inserts } = makeFakePool({ connected: ['reddit'] });
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_rd', tenantId: 72, doc: makeDoc('job_rd'), publishRunId: null, pool,
      });
      const rows = rowsFor(inserts, 'reddit');
      assert.equal(rows.length, 2);
      assert.equal((rows[0][4] as string).split('\n')[0], 'Big news today.', 'first line is the title');
    },
  );
});

test('Reddit-only tenant with NO subreddit configured: mode none, zero rows synthesized', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({ connected: ['reddit'] });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_rd_nosub', tenantId: 72, doc: makeDoc('job_rd_nosub'), publishRunId: null, pool,
    });
    assert.equal(result.reason, 'no_connected_platform');
    assert.equal(inserts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// (e)/(f)/(g) Backstops.
// ---------------------------------------------------------------------------

test('zero connections: synthesis refuses with no_connected_platform and inserts nothing (gate backstop)', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool, inserts } = makeFakePool({ connected: [] });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_none', tenantId: 69, doc: makeDoc('job_none'), publishRunId: null, pool,
    });
    assert.equal(result.reason, 'no_connected_platform');
    assert.equal(result.inserted, 0);
    assert.equal(inserts.length, 0);
  });
});

test('alternate mode: a reel/video entry produces no alternate row (feed-image entries only)', async () => {
  await withEnv(
    { ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1', ARIES_VIDEO_PUBLISH_ENABLED: '1' },
    async () => {
      const { pool, inserts } = makeFakePool({
        connected: ['linkedin'],
        externalAccountIds: { linkedin: 'urn:li:person:test' },
      });
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_reel', tenantId: 70, doc: makeMixedDoc('job_reel'), publishRunId: null, pool,
      });
      // Post 1 is a feed image; post 2 is a reel and must not fan out.
      assert.deepEqual(inserts.map((p) => p[5]), ['job_reel:1:linkedin:feed']);
      assert.ok(inserts.every((p) => p[8] === 'feed'), 'no video/reel rows');
    },
  );
});

test('resolver DB error fails open to meta mode — DELIBERATE, and loud (pinned behavior)', async () => {
  await withEnv({ ...LIVE_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    const { pool } = makeFakePool({ connected: ['linkedin'], failMetaCount: true });
    const resolution = await resolvePrimaryPublishPlatforms(70, pool);
    // This is the accepted trade: never re-target a Meta tenant's week because
    // of a transient DB blip. The cost — a non-Meta tenant loses the week and
    // synthesizes undeliverable Meta rows — is logged at error level and is on
    // the tenant-70 canary watch list. Synthesis is replay-safe, so re-running
    // the callback after recovery produces the correct rows.
    assert.deepEqual(resolution, { mode: 'meta' });
  });
});

test('flag OFF: the resolver is never consulted (no connection-count query at all)', async () => {
  await withEnv({ ...LIVE_FLAGS }, async () => {
    const { pool, seenSql } = makeFakePool({ connected: ['linkedin'] });
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_off', tenantId: 70, doc: makeDoc('job_off'), publishRunId: null, pool,
    });
    assert.equal(
      seenSql.some((sql) => /oauth_connections/i.test(sql)),
      false,
      'flag OFF must not add so much as one extra query',
    );
  });
});
