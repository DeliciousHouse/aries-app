import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeHermesCreativeAssets } from '@/backend/marketing/hermes-callbacks';

// ---------------------------------------------------------------------------
// bridgeHermesCreativeAssets — unit tests
// ---------------------------------------------------------------------------

test('bridge is a no-op when creative_assets is absent', () => {
  const input = {
    stage: 'production',
    summary: 'Weekly plan ready.',
    weekly_content_plan: {
      window_days: 7,
      posts: [],
      image_creatives: [],
      video_scripts: [],
    },
  };
  const result = bridgeHermesCreativeAssets(input);
  // Must return the same object reference — no unnecessary copies.
  assert.equal(result.weekly_content_plan, input.weekly_content_plan);
});

test('bridge is a no-op when creative_assets is an empty array', () => {
  const input = {
    artifacts: { creative_assets: [] },
    weekly_content_plan: { image_creatives: [] },
  };
  const result = bridgeHermesCreativeAssets(input);
  assert.deepEqual(result.weekly_content_plan, input.weekly_content_plan);
});

test('bridge is a no-op when artifacts key is missing', () => {
  const input: Record<string, unknown> = { stage: 'production' };
  const result = bridgeHermesCreativeAssets(input);
  assert.equal('weekly_content_plan' in result, false);
});

test('bridge maps generated_image assets into image_creatives with internal URLs', () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    const input = {
      stage: 'production',
      artifacts: {
        creative_assets: [
          {
            assetId: 'sl_asset_01',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260513_194035_8af24877.png',
            placement: 'post_1',
          },
          {
            assetId: 'sl_asset_02',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260513_194127_d62de45d.png',
            placement: 'post_2',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as {
      image_creatives: Array<{ id: string; artifact_url: string; status: string }>;
    };

    assert.ok(plan, 'weekly_content_plan should be present');
    assert.equal(plan.image_creatives.length, 2);

    assert.equal(plan.image_creatives[0].id, 'sl_asset_01');
    assert.equal(
      plan.image_creatives[0].artifact_url,
      'https://aries.example.com/api/internal/hermes/media/openai_codex_gpt-image-2-medium_20260513_194035_8af24877.png',
    );
    assert.equal(plan.image_creatives[0].status, 'created');

    assert.equal(plan.image_creatives[1].id, 'sl_asset_02');
    assert.equal(
      plan.image_creatives[1].artifact_url,
      'https://aries.example.com/api/internal/hermes/media/openai_codex_gpt-image-2-medium_20260513_194127_d62de45d.png',
    );
  } finally {
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});

test('bridge skips non-generated_image asset types (e.g. design_brief)', () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    const input = {
      artifacts: {
        creative_assets: [
          {
            assetId: 'sl_asset_01',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/image_01.png',
            placement: 'post_1',
          },
          {
            assetId: 'sl_asset_03',
            type: 'design_brief',
            status: 'created',
            path: '/home/node/.hermes/cache/images/brief_03.json',
            placement: 'post_3',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: unknown[] };
    assert.equal(plan.image_creatives.length, 1);
  } finally {
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});

test('bridge does not overwrite existing image_creatives', () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    const existingCreative = {
      id: 'already-exists',
      artifact_url: 'https://aries.example.com/api/internal/hermes/media/already.png',
      status: 'generated',
    };
    const input = {
      weekly_content_plan: {
        image_creatives: [existingCreative],
      },
      artifacts: {
        creative_assets: [
          {
            assetId: 'sl_asset_new',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/new_image.png',
            placement: 'post_1',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: unknown[] };
    // Must preserve the existing creative, not replace with the incoming one.
    assert.equal(plan.image_creatives.length, 1);
    assert.deepEqual(plan.image_creatives[0], existingCreative);
  } finally {
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});

test('bridge handles missing path gracefully — artifact_url becomes empty string', () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    const input = {
      artifacts: {
        creative_assets: [
          {
            assetId: 'sl_asset_nopath',
            type: 'generated_image',
            status: 'pending',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as {
      image_creatives: Array<{ artifact_url: string }>;
    };
    assert.equal(plan.image_creatives.length, 1);
    assert.equal(plan.image_creatives[0].artifact_url, '');
  } finally {
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});

test('URL rewrite uses only basename — no host path segments leak', () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    const input = {
      artifacts: {
        creative_assets: [
          {
            assetId: 'sl_asset_01',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/img.png',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as {
      image_creatives: Array<{ artifact_url: string }>;
    };
    const url = plan.image_creatives[0].artifact_url;
    // Must not include any host-side path segment before the basename.
    assert.equal(url.includes('.hermes'), false);
    assert.equal(url.includes('/home'), false);
    assert.equal(url.includes('/cache'), false);
    assert.equal(url, 'https://aries.example.com/api/internal/hermes/media/img.png');
  } finally {
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});
