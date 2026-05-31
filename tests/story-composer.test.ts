import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  STORY_WIDTH,
  STORY_HEIGHT,
  wrapText,
  resolveStoryCtaText,
  composeStoryImage,
  persistComposedStoryAsset,
  composeStoryAssetForBaseCreative,
} from '../backend/marketing/story-composer';

// A small decodable base image (solid color PNG) for composition tests.
async function makeBaseImage(w = 1024, h = 1280): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 30, b: 60 } } })
    .png()
    .toBuffer();
}

test('wrapText wraps on word boundaries and hard-splits overlong words', () => {
  assert.deepEqual(wrapText('one two three', 8), ['one two', 'three']);
  // a single word longer than maxChars is hard-split, never overflowing
  const lines = wrapText('supercalifragilistic', 6);
  assert.ok(lines.every((l) => l.length <= 6));
  assert.equal(lines.join(''), 'supercalifragilistic');
});

test('resolveStoryCtaText derives host, strips www, never returns bare sugarandleather.com', () => {
  assert.equal(resolveStoryCtaText('https://aries.sugarandleather.com'), 'aries.sugarandleather.com');
  assert.equal(resolveStoryCtaText('https://www.aries.sugarandleather.com/x'), 'aries.sugarandleather.com');
  // Bare leather-goods host is rejected -> canonical fallback.
  assert.equal(resolveStoryCtaText('https://sugarandleather.com'), 'aries.sugarandleather.com');
  assert.equal(resolveStoryCtaText(''), 'aries.sugarandleather.com');
  assert.equal(resolveStoryCtaText('not a url'), 'aries.sugarandleather.com');
});

test('composeStoryImage produces a valid 1080x1920 PNG from a 4:5 base', async () => {
  const base = await makeBaseImage();
  const out = await composeStoryImage({
    baseImageBytes: base,
    headline: 'Marketing that runs itself — research to live posts, on autopilot.',
    ctaText: 'aries.sugarandleather.com',
    brandPrimaryHex: '#6d28d9',
  });
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
  assert.ok(out.length > 5000, 'non-trivial output');
});

test('composeStoryImage tolerates a very long headline (truncates, still 9:16)', async () => {
  const base = await makeBaseImage();
  const out = await composeStoryImage({
    baseImageBytes: base,
    headline: 'x'.repeat(400),
    ctaText: 'aries.sugarandleather.com',
  });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

test('composeStoryImage throws on an undecodable base (caller falls back)', async () => {
  await assert.rejects(
    () => composeStoryImage({ baseImageBytes: Buffer.from('not an image'), headline: 'h', ctaText: 'c' }),
  );
});

test('persistComposedStoryAsset writes under DATA_ROOT/ingested-assets and inserts a row', async () => {
  const writes: Array<{ path: string; bytes: number }> = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const id = await persistComposedStoryAsset({
    db: {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        return { rows: [{ id: 'composed-uuid-1' }], rowCount: 1 };
      },
    },
    tenantId: 15,
    bytes: Buffer.from('PNGDATA'),
    dataRoot: '/data',
    writeBytes: async (p, b) => { writes.push({ path: p, bytes: b.length }); },
  });
  assert.equal(id, 'composed-uuid-1');
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^\/data\/ingested-assets\/15\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
  assert.match(queries[0].sql, /INSERT INTO creative_assets/i);
  assert.match(queries[0].sql, /runtime_artifact/);
  assert.match(queries[0].sql, /ingested_asset/);
});

test('composeStoryAssetForBaseCreative: runtime_asset base -> composes + persists, returns id', async () => {
  const base = await makeBaseImage();
  process.env.HERMES_IMAGE_CACHE_MOUNT = '/hermes-media';
  let insertedTenant = 0;
  const id = await composeStoryAssetForBaseCreative({
    db: {
      async query(sql: string, params: unknown[] = []) {
        if (/FROM creative_assets/i.test(sql) && /SELECT/i.test(sql)) {
          return { rows: [{ storage_kind: 'runtime_asset', storage_key: '/host/cache/img_1.png', served_asset_ref: '/api/internal/hermes/media/img_1.png' }], rowCount: 1 };
        }
        // INSERT
        insertedTenant = Number(params[0]);
        return { rows: [{ id: 'composed-uuid-2' }], rowCount: 1 };
      },
    },
    tenantId: 15,
    jobId: 'mkt_x',
    baseAssetId: 'img_1',
    headline: 'Hook goes here',
    ctaText: 'aries.sugarandleather.com',
    brandPrimaryHex: '#6d28d9',
    readBytes: async (p) => { assert.equal(p, '/hermes-media/img_1.png'); return base; },
    writeBytes: async () => {},
  });
  assert.equal(id, 'composed-uuid-2');
  assert.equal(insertedTenant, 15);
});

test('composeStoryAssetForBaseCreative returns null for external_url base (fallback to raw)', async () => {
  const id = await composeStoryAssetForBaseCreative({
    db: {
      async query() { return { rows: [{ storage_kind: 'external_url', storage_key: 'https://x/y.png', served_asset_ref: null }], rowCount: 1 }; },
    },
    tenantId: 15, jobId: 'j', baseAssetId: 'a', headline: 'h',
    readBytes: async () => Buffer.from(''), writeBytes: async () => {},
  });
  assert.equal(id, null);
});

test('composeStoryAssetForBaseCreative returns null when base row not found', async () => {
  const id = await composeStoryAssetForBaseCreative({
    db: { async query() { return { rows: [], rowCount: 0 }; } },
    tenantId: 15, jobId: 'j', baseAssetId: 'missing', headline: 'h',
    readBytes: async () => Buffer.from(''), writeBytes: async () => {},
  });
  assert.equal(id, null);
});
