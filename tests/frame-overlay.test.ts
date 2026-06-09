import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  applyBrandFrame,
  applyBrandFrameDetailed,
  defaultLogoLoader,
  type BrandKitFrameInput,
  type LogoLoader,
} from '../backend/creative-memory/frame-overlay';
import type {
  SocialContentImageChannel,
  SocialContentMediaPostType,
} from '../backend/social-content/aspect-matrix';

async function makeSolidPng(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 },
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { ...rgb, alpha: 1 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function makeLogoPng(size = 64): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 0, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

const PINK_KIT: BrandKitFrameInput = {
  colors: { primary: '#ff00aa' },
  logo_urls: ['/virtual/logo.png'],
};

const NO_BRAND_KIT: BrandKitFrameInput = {};

function loaderReturning(buffer: Buffer | null): LogoLoader {
  return async () => buffer;
}

test('applyBrandFrame frames an IG single_image, preserving width and height', async () => {
  const input = await makeSolidPng(800, 1000);
  const logo = await makeLogoPng();

  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(logo),
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, 'framed_with_logo');
  assert.equal(result.borderHex, '#ff00aa');
  assert.equal(result.fallbackBorderUsed, false);
  assert.notEqual(result.buffer, input);
  assert.notEqual(result.buffer.length, 0);

  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 1000);
});

test('applyBrandFrame frames a Meta (FB) feed single_image', async () => {
  const input = await makeSolidPng(1080, 1080);
  const logo = await makeLogoPng();

  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'meta',
    postType: 'single_image',
    logoLoader: loaderReturning(logo),
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, 'framed_with_logo');
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1080);
});

const SKIP_CASES: Array<{
  name: string;
  channel: SocialContentImageChannel;
  postType: SocialContentMediaPostType;
}> = [
  { name: 'IG link_card', channel: 'instagram', postType: 'link_card' },
  { name: 'Meta link_card', channel: 'meta', postType: 'link_card' },
  { name: 'IG carousel', channel: 'instagram', postType: 'carousel' },
  { name: 'Meta carousel', channel: 'meta', postType: 'carousel' },
  { name: 'IG video', channel: 'instagram', postType: 'video' },
  { name: 'Meta video', channel: 'meta', postType: 'video' },
];

for (const skipCase of SKIP_CASES) {
  test(`applyBrandFrame returns input buffer unchanged for ${skipCase.name}`, async () => {
    const input = await makeSolidPng(640, 360);
    const logo = await makeLogoPng();
    let loaderCalled = false;

    const result = await applyBrandFrameDetailed({
      assetBuffer: input,
      brandKit: PINK_KIT,
      channel: skipCase.channel,
      postType: skipCase.postType,
      logoLoader: async () => {
        loaderCalled = true;
        return logo;
      },
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'not_eligible');
    assert.strictEqual(result.buffer, input, 'buffer reference must be unchanged');
    assert.equal(loaderCalled, false, 'logo loader must not run for skipped cases');
  });
}

test('applyBrandFrame top-level export returns only the buffer', async () => {
  const input = await makeSolidPng(400, 500);
  const buffer = await applyBrandFrame({
    assetBuffer: input,
    brandKit: NO_BRAND_KIT,
    channel: 'instagram',
    postType: 'video',
  });
  assert.strictEqual(buffer, input);
});

test('applyBrandFrame falls back to safe border color when brand-kit primary is missing or invalid', async () => {
  const input = await makeSolidPng(400, 500);

  for (const kit of [
    NO_BRAND_KIT,
    { colors: { primary: null } } satisfies BrandKitFrameInput,
    { colors: { primary: 'not-a-hex' } } satisfies BrandKitFrameInput,
    { colors: { primary: '#abc' } } satisfies BrandKitFrameInput,
  ]) {
    const result = await applyBrandFrameDetailed({
      assetBuffer: input,
      brandKit: kit,
      channel: 'instagram',
      postType: 'single_image',
      logoLoader: loaderReturning(null),
    });
    assert.equal(result.applied, true);
    assert.equal(result.fallbackBorderUsed, true);
    assert.equal(result.borderHex, '#0f172a');
    assert.equal(result.reason, 'framed_without_logo');
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 500);
  }
});

test('applyBrandFrame still composes a border-only frame when logo loader returns null', async () => {
  const input = await makeSolidPng(600, 750);

  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(null),
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, 'framed_without_logo');
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 750);
});

test('applyBrandFrame swallows malformed logo bytes without failing the frame', async () => {
  const input = await makeSolidPng(500, 500);
  const garbage = Buffer.from('this is not an image', 'utf8');

  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'meta',
    postType: 'single_image',
    logoLoader: loaderReturning(garbage),
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, 'framed_without_logo');
});

test('applyBrandFrame visibly changes pixels in the border region for eligible posts', async () => {
  const input = await makeSolidPng(120, 120, { r: 255, g: 255, b: 255 });

  const result = await applyBrandFrame({
    assetBuffer: input,
    brandKit: { colors: { primary: '#ff0000' } },
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(null),
  });

  const { data, info } = await sharp(result)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 120);
  assert.equal(info.height, 120);
  const channels = info.channels;
  const topLeft = data.subarray(0, channels);
  const center =
    data.subarray(
      (60 * info.width + 60) * channels,
      (60 * info.width + 60) * channels + channels,
    );
  assert.notDeepEqual(
    Array.from(topLeft),
    Array.from(center),
    'border pixel should differ from interior pixel',
  );
});

test('defaultLogoLoader decodes base64 data URI bytes', async () => {
  const original = await makeLogoPng(8);
  const dataUri = `data:image/png;base64,${original.toString('base64')}`;
  const loaded = await defaultLogoLoader(dataUri);
  assert.ok(loaded);
  assert.equal(Buffer.compare(loaded!, original), 0);
});

test('defaultLogoLoader returns null for HTTP(S) URLs (offline-only)', async () => {
  assert.equal(await defaultLogoLoader('https://example.com/logo.png'), null);
  assert.equal(await defaultLogoLoader('http://example.com/logo.png'), null);
});

test('defaultLogoLoader returns null for relative or unknown URL forms', async () => {
  assert.equal(await defaultLogoLoader(''), null);
  assert.equal(await defaultLogoLoader('   '), null);
  assert.equal(await defaultLogoLoader('relative/path.png'), null);
});

// --- Phase 1: border-off, logoSource, conditional feathered scrim, no-re-encode ---

async function pixelAt(buf: Buffer, left: number, top: number): Promise<Buffer> {
  return sharp(buf).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
}

test('border:false composites the logo without an inner border (corner unchanged)', async () => {
  const input = await makeSolidPng(800, 800, { r: 10, g: 10, b: 10 }); // dark bg, no scrim
  const logo = await makeLogoPng();
  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(logo),
    border: false,
  });
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'framed_with_logo');
  // Top-left corner stays the original background — no border stroke drawn.
  const corner = await pixelAt(result.buffer, 0, 0);
  assert.equal(corner[0], 10);
  assert.equal(corner[1], 10);
  assert.equal(corner[2], 10);
});

test('border:false with no usable logo returns the ORIGINAL bytes unchanged (no re-encode)', async () => {
  const input = await makeSolidPng(800, 800);
  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(null),
    border: false,
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'framed_without_logo');
  assert.equal(result.buffer, input, 'logo-only with no logo must return the same buffer reference');
});

test('logoSource takes precedence over brandKit.logo_urls', async () => {
  const input = await makeSolidPng(800, 800, { r: 10, g: 10, b: 10 });
  const logo = await makeLogoPng();
  let requested: string | null = null;
  const loader: LogoLoader = async (url) => {
    requested = url;
    return logo;
  };
  await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT, // logo_urls: ['/virtual/logo.png']
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loader,
    logoSource: '/data/generated/validated/15/logo.png',
    border: false,
  });
  assert.equal(requested, '/data/generated/validated/15/logo.png');
});

test('conditional scrim darkens the patch behind the logo on a bright background', async () => {
  const input = await makeSolidPng(800, 800, { r: 255, g: 255, b: 255 }); // luma 255 > threshold
  const logo = await makeLogoPng();
  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(logo),
    border: false,
  });
  // Sample the scrim ring just left of the logo box (logo at left≈680; ring 668..680).
  const px = await pixelAt(result.buffer, 674, 728);
  assert.ok(px[1] < 240, `expected scrim to darken green channel below 240, got ${px[1]}`);
});

test('no scrim is added when the patch under the logo is below the luma threshold', async () => {
  const input = await makeSolidPng(800, 800, { r: 100, g: 100, b: 100 }); // luma 100 < threshold
  const logo = await makeLogoPng();
  const result = await applyBrandFrameDetailed({
    assetBuffer: input,
    brandKit: PINK_KIT,
    channel: 'instagram',
    postType: 'single_image',
    logoLoader: loaderReturning(logo),
    border: false,
  });
  const px = await pixelAt(result.buffer, 674, 728);
  // A 45% black scrim would push 100 toward ~55; without it the ring stays ~100.
  assert.ok(px[1] > 80, `expected no scrim (ring channel ~100), got ${px[1]}`);
});
