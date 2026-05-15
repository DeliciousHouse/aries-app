import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeHermesCreativeAssets } from '@/backend/marketing/hermes-callbacks';

type CanonicalCreative = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  artifact_url: string;
  aspect_ratio: string;
  intendedUse?: string;
  placement?: string;
};

function withAppBaseUrl(fn: () => void): void {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    fn();
  } finally {
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
}

function expectedCreative(overrides: Partial<CanonicalCreative> = {}): CanonicalCreative {
  return {
    id: 'img_0',
    title: 'homepage hero',
    prompt: 'Studio-lit leather weekender bag on warm sandstone.',
    status: 'completed',
    artifact_url: 'https://aries.example.com/api/internal/hermes/media/render_0.png',
    aspect_ratio: '1:1',
    intendedUse: 'homepage hero',
    ...overrides,
  };
}

test('bridge is a no-op when no recognized image schema is present', () => {
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
  assert.equal(result.weekly_content_plan, input.weekly_content_plan);
});

test('bridge canonicalizes artifacts.creative_assets generated_image records', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        creative_assets: [
          {
            assetId: '0',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/render_0.png',
            placement: 'homepage hero',
            prompt: 'Studio-lit leather weekender bag on warm sandstone.',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.deepEqual(plan.image_creatives, [
      expectedCreative({ placement: 'homepage hero' }),
    ]);
  });
});

test('bridge canonicalizes artifacts.images records', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        images: [
          {
            index: 0,
            status: 'generated',
            filePath: '/home/node/.hermes/cache/images/render_0.png',
            prompt: 'Studio-lit leather weekender bag on warm sandstone.',
            intendedUse: 'homepage hero',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.deepEqual(plan.image_creatives, [expectedCreative()]);
  });
});

test('bridge canonicalizes top-level image_creatives when a renderable path is present', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '1:1',
      },
      weekly_content_plan: {
        image_creatives: [
          {
            prompt: 'Studio-lit leather weekender bag on warm sandstone.',
            artifact_url: 'https://cdn.example.com/cache/render_0.png?token=abc',
            intendedUse: 'homepage hero',
            status: 'generated',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.deepEqual(plan.image_creatives, [expectedCreative()]);
  });
});

test('bridge ignores prompt-only top-level image_creatives without a renderable path', () => {
  const input = {
    weekly_content_plan: {
      image_creatives: [
        {
          prompt: 'Prompt only, no image rendered yet.',
          intendedUse: 'homepage hero',
          status: 'created',
        },
      ],
    },
  };

  const result = bridgeHermesCreativeAssets(input);
  assert.equal(result, input);
});
