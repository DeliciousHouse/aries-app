import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_VISION_QA_ATTEMPTS,
  VISION_QA_THRESHOLDS,
  createHermesVisionQAClient,
  runVisionQA,
  type VisionQABrandKitInput,
  type VisionQAClient,
  type VisionQADbClient,
} from '@/backend/creative-memory/vision-qa';
import { SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS } from '@/backend/social-content/defaults';

const BRAND_KIT_FIXTURE: VisionQABrandKitInput = {
  name: 'Sample Brand',
  logo_urls: ['https://cdn.example.com/logo.png'],
  colors: {
    primary: '#FF6B35',
    secondary: '#2EC4B6',
    accent: '#011627',
    palette: ['#FF6B35', '#2EC4B6', '#011627'],
  },
  font_families: ['Inter', 'Playfair Display'],
  voice: 'warm, direct, plainspoken',
  offer: 'weekly coaching membership',
  must_avoid_aesthetics: [...SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS],
};

function stubClient(scores: {
  brand_color_match: number;
  text_legibility: number;
  brand_violation: number;
  forbidden_patterns_detected?: string[];
  model_version?: string | null;
}): VisionQAClient {
  return async () => ({
    brand_color_match: scores.brand_color_match,
    text_legibility: scores.text_legibility,
    brand_violation: scores.brand_violation,
    forbidden_patterns_detected: scores.forbidden_patterns_detected ?? [],
    model_version: scores.model_version ?? 'vision-qa-test-1',
    raw: { stub: true },
  });
}

function createDbHarness(): {
  client: VisionQADbClient;
  inserts: { sql: string; params: unknown[] }[];
} {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const client: VisionQADbClient = {
    async query(sql, params = []) {
      inserts.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, inserts };
}

test('runVisionQA: thresholds expose locked values', () => {
  assert.equal(VISION_QA_THRESHOLDS.brand_color_match, 0.6);
  assert.equal(VISION_QA_THRESHOLDS.text_legibility, 0.8);
  assert.equal(VISION_QA_THRESHOLDS.brand_violation, 0.3);
  assert.equal(VISION_QA_THRESHOLDS.forbidden_pattern_hits, 0);
  assert.equal(MAX_VISION_QA_ATTEMPTS, 3);
});

test('runVisionQA: known-good image passes when all four thresholds hold', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/branded.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 0.92,
      text_legibility: 0.95,
      brand_violation: 0.05,
    }),
  });

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.retry_eligible, false);
  assert.equal(result.attempt_number, 1);
  assert.equal(result.scores.brand_color_match, 0.92);
  assert.equal(result.scores.forbidden_pattern_hits, 0);
});

test('runVisionQA: brand_color_match exactly 0.6 still passes (>= boundary)', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/branded-edge.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 0.6,
      text_legibility: 0.8,
      brand_violation: 0.29,
    }),
  });

  assert.equal(result.verdict, 'pass');
});

test('runVisionQA: brand_color_match just below 0.6 fails', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/off-brand.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 0.59,
      text_legibility: 0.95,
      brand_violation: 0.05,
    }),
  });

  assert.equal(result.verdict, 'fail');
  assert(result.reasons.includes('brand_color_mismatch'));
});

test('runVisionQA: text_legibility 0.79 fails illegible_text reason', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/blurry-text.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'meta',
    visionClient: stubClient({
      brand_color_match: 0.95,
      text_legibility: 0.79,
      brand_violation: 0.1,
    }),
  });

  assert.equal(result.verdict, 'fail');
  assert(result.reasons.includes('illegible_text'));
});

test('runVisionQA: brand_violation at 0.3 fails (strict <)', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/voice-mismatch.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 0.95,
      text_legibility: 0.95,
      brand_violation: 0.3,
    }),
  });

  assert.equal(result.verdict, 'fail');
  assert(result.reasons.includes('brand_violation'));
});

test('runVisionQA: any forbidden pattern hit fails (== 0 required)', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/split-screen.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 0.92,
      text_legibility: 0.95,
      brand_violation: 0.05,
      forbidden_patterns_detected: ['split-screen'],
    }),
  });

  assert.equal(result.verdict, 'fail');
  assert(result.reasons.includes('forbidden_pattern'));
  assert.equal(result.scores.forbidden_pattern_hits, 1);
});

test('runVisionQA: known-bad generic AI image fails on multiple thresholds', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/generic-ai-office.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 0.21,
      text_legibility: 0.4,
      brand_violation: 0.65,
      forbidden_patterns_detected: ['generic stock office'],
    }),
  });

  assert.equal(result.verdict, 'fail');
  assert(result.reasons.includes('brand_color_mismatch'));
  assert(result.reasons.includes('illegible_text'));
  assert(result.reasons.includes('brand_violation'));
  assert(result.reasons.includes('forbidden_pattern'));
});

test('runVisionQA: retry_eligible true on attempts 1 and 2 of fail', async () => {
  for (const attempt of [1, 2]) {
    const result = await runVisionQA({
      assetUrl: 'https://cdn.example.com/bad.png',
      brandKit: BRAND_KIT_FIXTURE,
      channel: 'instagram',
      attemptNumber: attempt,
      visionClient: stubClient({
        brand_color_match: 0.1,
        text_legibility: 0.1,
        brand_violation: 0.9,
      }),
    });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.retry_eligible, true);
    assert.equal(result.attempt_number, attempt);
  }
});

test('runVisionQA: retry_eligible false at attempt 3 (cap)', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/bad.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    attemptNumber: 3,
    visionClient: stubClient({
      brand_color_match: 0.1,
      text_legibility: 0.1,
      brand_violation: 0.9,
    }),
  });

  assert.equal(result.verdict, 'fail');
  assert.equal(result.retry_eligible, false);
});

test('runVisionQA: retry_eligible always false on pass', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/good.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    attemptNumber: 1,
    visionClient: stubClient({
      brand_color_match: 0.95,
      text_legibility: 0.95,
      brand_violation: 0.05,
    }),
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.retry_eligible, false);
});

test('runVisionQA: persists row to vision_qa_runs when db client + tenantId provided', async () => {
  const harness = createDbHarness();

  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/persisted.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'meta',
    attemptNumber: 2,
    tenantId: 42,
    postId: 1001n,
    creativeId: 2002n,
    db: harness.client,
    visionClient: stubClient({
      brand_color_match: 0.91,
      text_legibility: 0.94,
      brand_violation: 0.05,
      forbidden_patterns_detected: [],
      model_version: 'vision-qa-stub-1',
    }),
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(harness.inserts.length, 1);
  const insert = harness.inserts[0];
  assert.match(insert.sql, /INSERT INTO vision_qa_runs/);
  assert.equal(insert.params[0], 42);
  assert.equal(insert.params[1], 1001n);
  assert.equal(insert.params[2], 2002n);
  assert.equal(insert.params[3], 2);
  assert.equal(insert.params[4], 0.91);
  assert.equal(insert.params[5], 0.94);
  assert.equal(insert.params[6], 0);
  assert.equal(insert.params[7], 0.05);
  assert.equal(insert.params[8], 'pass');
  assert.equal(insert.params[9], 'vision-qa-stub-1');
  const rawJson = String(insert.params[10] ?? '');
  assert.match(rawJson, /"forbidden_patterns_detected":\s*\[\]/);
});

test('runVisionQA: skips persistence when db is provided but tenantId is missing', async () => {
  const harness = createDbHarness();
  await runVisionQA({
    assetUrl: 'https://cdn.example.com/no-tenant.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    db: harness.client,
    visionClient: stubClient({
      brand_color_match: 0.95,
      text_legibility: 0.9,
      brand_violation: 0.05,
    }),
  });

  assert.equal(harness.inserts.length, 0);
});

test('runVisionQA: forwards forbidden patterns list to client', async () => {
  let observedPatterns: readonly string[] = [];
  const client: VisionQAClient = async (input) => {
    observedPatterns = input.forbiddenPatterns;
    return {
      brand_color_match: 0.95,
      text_legibility: 0.95,
      brand_violation: 0.05,
      forbidden_patterns_detected: [],
      model_version: 'vision-qa-test-1',
    };
  };

  await runVisionQA({
    assetUrl: 'https://cdn.example.com/clean.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: client,
  });

  assert.deepEqual(
    observedPatterns,
    SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS,
  );
});

test('runVisionQA: clamps out-of-range scores returned by client', async () => {
  const result = await runVisionQA({
    assetUrl: 'https://cdn.example.com/weird.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    visionClient: stubClient({
      brand_color_match: 1.5,
      text_legibility: -0.2,
      brand_violation: 4,
    }),
  });

  assert.equal(result.scores.brand_color_match, 1);
  assert.equal(result.scores.text_legibility, 0);
  assert.equal(result.scores.brand_violation, 1);
});

test('runVisionQA: rejects when no vision client is provided', async () => {
  await assert.rejects(
    runVisionQA({
      assetUrl: 'https://cdn.example.com/nope.png',
      brandKit: BRAND_KIT_FIXTURE,
      channel: 'instagram',
    }),
    /vision_qa_client_unavailable/,
  );
});

test('createHermesVisionQAClient: posts to /v1/vision/qa with bearer + payload', async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        brand_color_match: 0.88,
        text_legibility: 0.92,
        brand_violation: 0.07,
        forbidden_patterns_detected: [],
        model_version: 'vision-qa-prod-1',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const client = createHermesVisionQAClient({
    gatewayUrl: 'https://hermes.example.com/',
    apiKey: 'hermes-test-key',
    fetchImpl: fakeFetch,
  });

  const result = await client({
    assetUrl: 'https://cdn.example.com/img.png',
    brandKit: BRAND_KIT_FIXTURE,
    channel: 'instagram',
    forbiddenPatterns: SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS,
  });

  assert.equal(result.brand_color_match, 0.88);
  assert.equal(result.text_legibility, 0.92);
  assert.equal(result.brand_violation, 0.07);
  assert.equal(result.model_version, 'vision-qa-prod-1');
  assert.deepEqual(result.forbidden_patterns_detected, []);

  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.url, 'https://hermes.example.com/v1/vision/qa');
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer hermes-test-key');
  assert.equal(headers['content-type'], 'application/json');
  const body = JSON.parse(String(call.init.body ?? '{}'));
  assert.equal(body.asset_url, 'https://cdn.example.com/img.png');
  assert.equal(body.channel, 'instagram');
  assert.deepEqual(
    body.forbidden_patterns,
    [...SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS],
  );
});

test('createHermesVisionQAClient: throws on non-OK response', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('upstream busted', { status: 502, statusText: 'Bad Gateway' });

  const client = createHermesVisionQAClient({
    gatewayUrl: 'https://hermes.example.com',
    apiKey: 'k',
    fetchImpl: fakeFetch,
  });

  await assert.rejects(
    client({
      assetUrl: 'https://cdn.example.com/img.png',
      brandKit: BRAND_KIT_FIXTURE,
      channel: 'meta',
      forbiddenPatterns: SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS,
    }),
    /hermes_vision_qa_request_failed/,
  );
});
