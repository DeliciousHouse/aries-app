/**
 * hermes-image-projection-stage-gated.test.ts
 *
 * Verifies the stage-gated PNG path fallback in bridgeHermesCreativeAssets:
 *
 *   (a) Production callback with unknown shape → fallback fires, creatives populated
 *   (b) Production callback with known shape (creative_assets) → named harvester wins
 *   (c) Production callback with NO images → hermes_image_generation_unrecognized (fail-loud)
 *   (d) Research callback with PNG-path-shaped strings → fallback does NOT fire (regression guard)
 *   (e) Strategy callback with image_creatives leftover → fallback does NOT fire
 *   (f) Production callback in all four known shapes harvests correctly
 *   (g) All four shapes: creative_assets, images, image_creatives (with artifact_url), unknown PNG path
 *
 * This is the direct regression guard for the v0.1.3.10 (PR #341) revert: the un-gated
 * fallback walker caused research callbacks to surface phantom image_creatives, breaking
 * the Stage 1 → 2 approval transition UI. The fix gates the fallback to 'production' only.
 *
 * Live evidence: mkt_de108fd2-5b31-4329-9136-0230b822ae17 (v0.1.3.11) rendered two PNGs
 * to /home/node/.hermes/cache/images/ but dashboard showed "Generated assets 0".
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/hermes-image-projection-stage-gated.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeHermesCreativeAssets } from '@/backend/marketing/hermes-callbacks';

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

// Real-looking Hermes cache path patterns from live mkt_de108fd2 run.
const HERMES_PNG_1 = '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260515_182552_e43a44a3.png';
const HERMES_PNG_2 = '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260515_182756_b1c545d9.png';

// ---------------------------------------------------------------------------
// (a) Production callback with unknown shape → fallback fires
// ---------------------------------------------------------------------------

test('stage-gated(a): production callback unknown shape → PNG fallback fires, image_creatives populated', () => {
  withAppBaseUrl(() => {
    // Unknown shape: images are buried in an unexpected field
    const input: Record<string, unknown> = {
      stage: 'production',
      status: 'requires_approval',
      unknown_field: {
        generated: [
          {
            prompt: 'A bold leadership visual',
            intendedUse: 'hero_post',
            output_path: HERMES_PNG_1,
          },
          {
            prompt: 'A warm coaching moment',
            intendedUse: 'secondary_post',
            output_path: HERMES_PNG_2,
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input, 'production');

    const plan = result.weekly_content_plan as Record<string, unknown>;
    assert.ok(plan, 'weekly_content_plan should be created');
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(creatives), 'image_creatives should be an array');
    assert.ok(creatives.length >= 1, `Expected at least 1 creative, got ${creatives.length}`);
    // Both PNGs should be harvested
    assert.strictEqual(creatives.length, 2, 'Both Hermes cache PNGs should be harvested');
    for (const c of creatives) {
      assert.ok(
        typeof c.artifact_url === 'string' && (c.artifact_url as string).includes('/api/internal/hermes/media/'),
        `artifact_url should point to internal media route, got: ${c.artifact_url}`,
      );
      assert.strictEqual(c.status, 'completed');
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Production callback with known shape (creative_assets) → named harvester wins
// ---------------------------------------------------------------------------

test('stage-gated(b): production callback known creative_assets shape → named harvester wins, fallback not needed', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      artifacts: {
        aspectRatio: '4:5',
        creative_assets: [
          {
            assetId: 'asset_01',
            type: 'generated_image',
            status: 'created',
            path: HERMES_PNG_1,
            placement: 'post_1',
            prompt: 'Leadership visual',
          },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input, 'production');
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    assert.strictEqual(creatives.length, 1);
    // Named harvester should produce id prefixed with 'img_asset_01' (not 'img_fallback_')
    assert.ok(
      (creatives[0].id as string).startsWith('img_asset_01'),
      `Expected id to use asset assetId, got: ${creatives[0].id}`,
    );
    assert.ok(
      (creatives[0].artifact_url as string).includes('e43a44a3.png'),
      'artifact_url should reference the actual PNG basename',
    );
  });
});

// ---------------------------------------------------------------------------
// (c) Production callback with NO images → fail-loud path (hermes_image_generation_unrecognized)
//     We can't test the full callback handler here (it needs runtime state), but we can
//     verify bridgeHermesCreativeAssets returns the record unchanged (no phantom creatives).
// ---------------------------------------------------------------------------

test('stage-gated(c): production callback with no images in any shape → bridge returns record unchanged, no phantom creatives injected', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      stage: 'production',
      weekly_content_plan: {
        posts: ['post 1', 'post 2'],
        // image_creatives intentionally absent
      },
      artifacts: {
        creative_assets: [], // empty
        images: [],           // empty
      },
    };

    const result = bridgeHermesCreativeAssets(input, 'production');
    // No images → should return unchanged (no image_creatives injected)
    const plan = result.weekly_content_plan as Record<string, unknown>;
    assert.ok(!Array.isArray(plan.image_creatives) || (plan.image_creatives as unknown[]).length === 0,
      'image_creatives should not be populated when no images are present');
  });
});

// ---------------------------------------------------------------------------
// (d) Research callback with PNG-path-shaped strings → fallback does NOT fire
//     This is the direct regression guard for PR #341's breakage.
// ---------------------------------------------------------------------------

test('stage-gated(d): research callback containing competitor PNG URLs → fallback does NOT fire, record returned unchanged', () => {
  withAppBaseUrl(() => {
    // A research callback might contain competitor ad screenshots that have
    // Hermes cache-like paths. The fallback must not harvest these.
    const competitorScreenshot = '/home/node/.hermes/cache/images/openai_codex_competitor_screenshot_20260515_111111_aabbccdd.png';
    const input: Record<string, unknown> = {
      stage: 'research',
      summary: 'Competitor research completed.',
      competitor_data: {
        brand_name: 'Competitor Co',
        ad_library: {
          screenshot: competitorScreenshot, // This looks like a Hermes cache path!
          url: 'https://competitor.com',
        },
      },
      // No weekly_content_plan, no artifacts — pure research output
    };

    const result = bridgeHermesCreativeAssets(input, 'research');

    // Result must be identical to input — no weekly_content_plan injected
    assert.deepStrictEqual(result, input,
      'Research callback must be returned unchanged — fallback must not fire for research stage');

    // Explicitly: no image_creatives should appear
    const plan = result.weekly_content_plan;
    assert.ok(plan === undefined,
      `weekly_content_plan should not be created for research callbacks, got: ${JSON.stringify(plan)}`);
  });
});

// ---------------------------------------------------------------------------
// (e) Strategy callback with leftover image_creatives (no artifact_url) → fallback does NOT fire
// ---------------------------------------------------------------------------

test('stage-gated(e): strategy callback with prompt-only image_creatives → fallback does NOT fire, record returned unchanged', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      stage: 'strategy',
      weekly_content_plan: {
        posts: ['post 1'],
        image_creatives: [
          // Prompt-only entries, no path/artifact_url — might be from a prior partial run
          { id: 'img_1', prompt: 'A bold visual', status: 'pending' },
        ],
      },
    };

    const result = bridgeHermesCreativeAssets(input, 'strategy');

    // Should be unchanged — no fallback PNG walker on strategy stage
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    // The canonicalExistingCreatives path will filter out entries with no basename,
    // so the result may have empty image_creatives — but critically no fallback paths injected.
    for (const c of creatives ?? []) {
      assert.ok(
        !((c.artifact_url as string | undefined)?.includes('fallback_')),
        'No fallback creatives should appear in strategy callback output',
      );
      assert.ok(
        !((c.id as string | undefined)?.startsWith('img_fallback_')),
        'No fallback-prefixed IDs should appear in strategy callback output',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (f) All four production shapes harvest correctly
// ---------------------------------------------------------------------------

test('stage-gated(f1): production shape 1 (creative_assets) → harvested via named path', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      artifacts: {
        creative_assets: [
          { assetId: 'ca1', type: 'generated_image', path: HERMES_PNG_1, prompt: 'p1' },
        ],
      },
    };
    const result = bridgeHermesCreativeAssets(input, 'production');
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    assert.strictEqual(creatives.length, 1);
    assert.ok((creatives[0].artifact_url as string).includes('e43a44a3.png'));
  });
});

test('stage-gated(f2): production shape 2 (artifacts.images) → harvested via named path', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      artifacts: {
        images: [
          { index: 0, filePath: HERMES_PNG_2, prompt: 'p2', intendedUse: 'hero' },
        ],
      },
    };
    const result = bridgeHermesCreativeAssets(input, 'production');
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    assert.strictEqual(creatives.length, 1);
    assert.ok((creatives[0].artifact_url as string).includes('b1c545d9.png'));
    assert.strictEqual(creatives[0].intendedUse, 'hero');
  });
});

test('stage-gated(f3): production shape 3 (image_creatives with artifact_url) → passthrough/canonicalized', () => {
  withAppBaseUrl(() => {
    const existingUrl = 'https://aries.example.com/api/internal/hermes/media/openai_codex_gpt-image-2-medium_20260515_182552_e43a44a3.png';
    const input: Record<string, unknown> = {
      weekly_content_plan: {
        image_creatives: [
          { id: 'img_0', prompt: 'p3', status: 'completed', artifact_url: existingUrl },
        ],
      },
    };
    // This goes through the canonical existing creatives path (renderedImageBasenameFromRecord
    // extracts basename from artifact_url)
    const result = bridgeHermesCreativeAssets(input, 'production');
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    assert.strictEqual(creatives.length, 1);
    assert.ok((creatives[0].artifact_url as string).includes('e43a44a3.png'));
  });
});

test('stage-gated(f4): production shape 4 (unknown shape with PNG path) → fallback harvester fires', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      generated_images: {
        result_path: HERMES_PNG_1,
        prompt: 'Schema 4 test',
        intendedUse: 'post_hero',
      },
    };
    const result = bridgeHermesCreativeAssets(input, 'production');
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(creatives) && creatives.length === 1,
      `Expected 1 fallback creative, got: ${JSON.stringify(creatives)}`);
    assert.ok((creatives[0].artifact_url as string).includes('e43a44a3.png'));
    assert.ok((creatives[0].id as string).startsWith('img_fallback_'));
    assert.strictEqual(creatives[0].intendedUse, 'post_hero');
    assert.strictEqual(creatives[0].prompt, 'Schema 4 test');
  });
});

// ---------------------------------------------------------------------------
// (g) Fallback correctly de-duplicates multiple references to the same PNG path
// ---------------------------------------------------------------------------

test('stage-gated(g): duplicate Hermes PNG paths in unknown schema collapse to one creative entry', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      generation_log: [
        { attempt: 1, path: HERMES_PNG_1, status: 'failed' },
        { attempt: 2, path: HERMES_PNG_1, status: 'success', prompt: 'Final version' },
      ],
      output_path: HERMES_PNG_1, // Same path referenced again at top level
    };
    const result = bridgeHermesCreativeAssets(input, 'production');
    const plan = result.weekly_content_plan as Record<string, unknown>;
    const creatives = plan.image_creatives as Array<Record<string, unknown>>;
    // Same PNG path referenced 3 times → should deduplicate to 1 entry
    assert.strictEqual(creatives.length, 1,
      `Duplicate PNG paths should collapse to 1 creative, got ${creatives.length}`);
    assert.ok((creatives[0].artifact_url as string).includes('e43a44a3.png'));
  });
});

// ---------------------------------------------------------------------------
// (h) Publish callback with image paths → fallback does NOT fire (publish is not production)
// ---------------------------------------------------------------------------

test('stage-gated(h): publish callback with cache image paths → fallback does NOT fire', () => {
  withAppBaseUrl(() => {
    const input: Record<string, unknown> = {
      stage: 'publish',
      // Publish callback might reference already-rendered image paths in post records
      posts: [
        { platform: 'instagram', image: HERMES_PNG_1, caption: 'Post caption' },
      ],
    };

    const result = bridgeHermesCreativeAssets(input, 'publish');

    // publish stage → fallback must not fire
    assert.deepStrictEqual(result, input,
      'Publish callback must be returned unchanged — fallback must not fire for publish stage');
  });
});
