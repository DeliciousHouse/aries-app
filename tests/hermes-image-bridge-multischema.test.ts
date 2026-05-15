/**
 * hermes-image-bridge-multischema.test.ts
 *
 * Verifies that bridgeHermesCreativeAssets correctly handles all three
 * recognized Hermes output shapes:
 *
 *   (a) artifacts.creative_assets[] with type="generated_image" and a path
 *   (b) artifacts.images[] with filePath
 *   (c) legacy weekly_content_plan.image_creatives[] (no regression)
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/hermes-image-bridge-multischema.test.ts
 */

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
  const prev = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prev;
  }
}

// ---------------------------------------------------------------------------
// (a) artifacts.creative_assets[] shape
// ---------------------------------------------------------------------------

test('bridge(a): accepts artifacts.creative_assets[].path shape — image_creatives populated, status=completed, path threaded', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '4:5',
        creative_assets: [
          {
            assetId: 'sl_asset_01',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/openai_gpt_image_20260513_abc123.png',
            placement: 'post_1',
            prompt: 'Editorial portrait of a woman leader against warm neutral backdrop.',
          },
          {
            assetId: 'sl_asset_02',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/openai_gpt_image_20260513_def456.png',
            placement: 'post_2',
            prompt: 'Aspirational lifestyle shot with soft warm tones and minimal layout.',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.ok(Array.isArray(plan.image_creatives), 'image_creatives should be an array');
    assert.equal(plan.image_creatives.length, 2, 'should map two creative assets');

    const first = plan.image_creatives[0];
    assert.equal(first.id, 'img_sl_asset_01', 'id should use assetId prefixed with img_');
    assert.equal(first.status, 'completed', 'status should be normalized to completed');
    assert.equal(first.aspect_ratio, '4:5', 'aspect_ratio should be threaded from artifactRecord');
    assert.ok(
      first.artifact_url.startsWith('https://aries.example.com/api/internal/hermes/media/'),
      'artifact_url should use the internal hermes media route',
    );
    assert.ok(
      first.artifact_url.includes('openai_gpt_image_20260513_abc123.png'),
      'artifact_url should contain the image filename',
    );
    assert.equal(first.placement, 'post_1', 'placement should be threaded');

    const second = plan.image_creatives[1];
    assert.equal(second.id, 'img_sl_asset_02');
    assert.equal(second.status, 'completed');
    assert.ok(second.artifact_url.includes('openai_gpt_image_20260513_def456.png'));
  });
});

test('bridge(a): creative_assets with non-image type entries are filtered out', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        creative_assets: [
          {
            assetId: 'video_01',
            type: 'video_clip',
            status: 'created',
            path: '/home/node/.hermes/cache/images/clip.mp4',
            prompt: 'Video clip.',
          },
          {
            assetId: 'img_01',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/render_01.png',
            prompt: 'Image prompt.',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.equal(plan.image_creatives.length, 1, 'only generated_image assets should be included');
    assert.equal(plan.image_creatives[0].id, 'img_img_01');
  });
});

// ---------------------------------------------------------------------------
// (b) artifacts.images[] shape
// ---------------------------------------------------------------------------

test('bridge(b): accepts artifacts.images[].filePath shape — index→assetId, filePath→path, status:generated→completed', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '9:16',
        images: [
          {
            index: 0,
            status: 'generated',
            filePath: '/home/node/.hermes/cache/images/veo_render_20260513_aaa111.png',
            prompt: 'Dynamic motion portrait.',
            intendedUse: 'reel_cover',
          },
          {
            index: 1,
            status: 'generated',
            filePath: '/home/node/.hermes/cache/images/veo_render_20260513_bbb222.png',
            prompt: 'Lifestyle reel thumbnail.',
            intendedUse: 'reel_thumb',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.ok(Array.isArray(plan.image_creatives), 'image_creatives should be present');
    assert.equal(plan.image_creatives.length, 2, 'should map both images entries');

    const first = plan.image_creatives[0];
    // index value is used as the numeric identifier
    assert.equal(first.id, 'img_0', 'id should use the image index');
    assert.equal(first.status, 'completed', 'status normalized to completed regardless of generated input');
    assert.equal(first.aspect_ratio, '9:16', 'aspect_ratio threaded from artifactRecord');
    assert.ok(
      first.artifact_url.includes('veo_render_20260513_aaa111.png'),
      'artifact_url should contain the filePath basename',
    );
    assert.equal(first.intendedUse, 'reel_cover', 'intendedUse should be threaded');

    const second = plan.image_creatives[1];
    assert.equal(second.id, 'img_1');
    assert.ok(second.artifact_url.includes('veo_render_20260513_bbb222.png'));
  });
});

test('bridge(b): artifacts.images entries without a filePath or path are filtered out', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        images: [
          {
            index: 0,
            status: 'pending',
            prompt: 'Prompt only, no file yet.',
          },
          {
            index: 1,
            status: 'generated',
            filePath: '/home/node/.hermes/cache/images/render_real.png',
            prompt: 'Actual rendered image.',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.equal(plan.image_creatives.length, 1, 'prompt-only images entries should be filtered');
    assert.equal(plan.image_creatives[0].id, 'img_1');
  });
});

// ---------------------------------------------------------------------------
// (c) legacy weekly_content_plan.image_creatives[] — no regression
// ---------------------------------------------------------------------------

test('bridge(c): accepts legacy image_creatives[] with artifact_url — no regression', () => {
  withAppBaseUrl(() => {
    const legacyArtifactUrl = 'https://cdn.example.com/cache/legacy_render.png?token=xyz';
    const input = {
      artifacts: {
        aspectRatio: '4:5',
      },
      weekly_content_plan: {
        posts: [],
        image_creatives: [
          {
            id: 'creative_01',
            title: 'Brand hero',
            aspect_ratio: '4:5',
            prompt: 'Editorial portrait of a woman leader.',
            status: 'created',
            artifact_url: legacyArtifactUrl,
            intendedUse: 'Brand hero',
          },
        ],
        video_scripts: [],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.equal(plan.image_creatives.length, 1, 'legacy image_creatives should be preserved');
    assert.equal(plan.image_creatives[0].id, 'img_creative_01', 'id should strip and re-prefix img_');
    assert.equal(plan.image_creatives[0].status, 'completed', 'status normalized to completed');
    // artifact_url is preserved since it has a recognizable image extension basename
    assert.ok(
      plan.image_creatives[0].artifact_url.includes('legacy_render.png'),
      'artifact_url should include the image basename',
    );
  });
});

test('bridge(c): legacy image_creatives[] without paths remain a no-op (prompt-only)', () => {
  const input = {
    weekly_content_plan: {
      image_creatives: [
        {
          id: 'creative_01',
          title: 'Brand hero',
          prompt: 'Prompt only — no path or artifact_url.',
          status: 'pending',
        },
      ],
    },
  };

  // Bridge should return the original record unchanged when no renderable path found
  const result = bridgeHermesCreativeAssets(input);
  // The function returns the outputRecord unchanged when no canonical result found
  const plan = result.weekly_content_plan as Record<string, unknown>;
  const creatives = plan?.image_creatives as unknown[];
  // Prompt-only entries produce null from canonicalImageCreativeFromExisting → filtered → empty
  // So image_creatives should not be overwritten with an empty array; the original is returned
  assert.equal(creatives?.length, 1, 'original prompt-only creatives preserved as-is when no path available');
});

test('bridge(c): creative_assets shape takes precedence over empty legacy image_creatives', () => {
  withAppBaseUrl(() => {
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        creative_assets: [
          {
            assetId: 'new_asset',
            type: 'generated_image',
            status: 'created',
            path: '/home/node/.hermes/cache/images/new_render.png',
            prompt: 'New schema image.',
          },
        ],
      },
      weekly_content_plan: {
        image_creatives: [],
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: CanonicalCreative[] };

    assert.equal(plan.image_creatives.length, 1, 'creative_assets should populate when legacy is empty');
    assert.equal(plan.image_creatives[0].id, 'img_new_asset');
  });
});

// ---------------------------------------------------------------------------
// ReDoS regression — imageBasenameFromValue must not hang on pathological input
// (CodeQL js/polynomial-redos, fixed by replacing runtime regex with explicit
//  string operations + 1024-char input cap)
// ---------------------------------------------------------------------------

test('security: imageBasenameFromValue returns in < 200ms on pathological 50k-quote input ending .png#', () => {
  // Simulate the pathological pattern described by CodeQL: a string of many
  // repeated quote characters followed by ".png#" — the old regex
  // /([^/?#]+\.(?:png|jpe?g|webp|gif))(?:[?#].*)?$/i would backtrack
  // exponentially on this input. The new implementation must complete in
  // well under 200ms regardless.
  withAppBaseUrl(() => {
    const malicious = '"'.repeat(50_000) + '.png#';
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        creative_assets: [
          {
            assetId: 'sec_test',
            type: 'generated_image',
            status: 'created',
            path: malicious,
            prompt: 'ReDoS regression test.',
          },
        ],
      },
    };

    const start = performance.now();
    bridgeHermesCreativeAssets(input);
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < 200,
      `imageBasenameFromValue must return in < 200ms on pathological input; took ${elapsed.toFixed(1)}ms`,
    );
  });
});

test('security: imageBasenameFromValue returns in < 200ms on pathological 50k-.gif# input', () => {
  // Second CodeQL pattern: starts with ".png#" and has many repetitions of ".gif#".
  withAppBaseUrl(() => {
    const malicious = '".png#' + '".gif#'.repeat(50_000);
    const input = {
      artifacts: {
        aspectRatio: '1:1',
        creative_assets: [
          {
            assetId: 'sec_test_2',
            type: 'generated_image',
            status: 'created',
            path: malicious,
            prompt: 'ReDoS regression test 2.',
          },
        ],
      },
    };

    const start = performance.now();
    bridgeHermesCreativeAssets(input);
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < 200,
      `imageBasenameFromValue must return in < 200ms on pathological input; took ${elapsed.toFixed(1)}ms`,
    );
  });
});
