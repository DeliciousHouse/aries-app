import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDominantImageChannel,
  resolveSocialContentAspectRatio,
} from '@/backend/social-content/aspect-matrix';
import { buildSocialContentWeeklyRequest } from '@/backend/social-content/workflow-request';
import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';

test('matrix: instagram + single_image -> 4:5 (portrait feed crop)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'instagram', postType: 'single_image' }),
    '4:5',
  );
});

test('matrix: instagram + carousel -> 1:1 (square)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'instagram', postType: 'carousel' }),
    '1:1',
  );
});

test('matrix: meta + single_image -> 1:1 (Facebook feed square)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'meta', postType: 'single_image' }),
    '1:1',
  );
});

test('matrix: meta + link_card -> 1.91:1 (Open Graph)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'meta', postType: 'link_card' }),
    '1.91:1',
  );
});

test('matrix: instagram + link_card -> 1.91:1 (Open Graph)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'instagram', postType: 'link_card' }),
    '1.91:1',
  );
});

test('matrix: meta + carousel -> 1:1 (Facebook carousel square)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'meta', postType: 'carousel' }),
    '1:1',
  );
});

test('matrix: instagram + video -> 9:16 (Reels vertical)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'instagram', postType: 'video' }),
    '9:16',
  );
});

test('matrix: meta + video -> 9:16 (Reels vertical)', () => {
  assert.equal(
    resolveSocialContentAspectRatio({ channel: 'meta', postType: 'video' }),
    '9:16',
  );
});

test('dominant channel resolves to instagram when both meta and instagram are bundled', () => {
  assert.equal(resolveDominantImageChannel(['meta', 'instagram']), 'instagram');
  assert.equal(resolveDominantImageChannel(['instagram', 'meta']), 'instagram');
});

test('dominant channel resolves to instagram for instagram-only target', () => {
  assert.equal(resolveDominantImageChannel(['instagram']), 'instagram');
});

test('dominant channel resolves to meta for meta-only target', () => {
  assert.equal(resolveDominantImageChannel(['meta']), 'meta');
});

test('dominant channel falls back to instagram for empty/unknown channels', () => {
  assert.equal(resolveDominantImageChannel([]), 'instagram');
  assert.equal(resolveDominantImageChannel(['linkedin', 'tiktok']), 'instagram');
});

test('weekly workflow request emits 1:1 for meta-only image target channel', () => {
  const doc = {
    tenant_id: 'tenant_meta_only',
    job_id: 'mkt_meta_only',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: '',
      competitor_brand: '',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        primaryGoal: 'Drive Facebook reach',
        channels: ['meta'],
      },
    },
    brand_kit: { brand_name: 'Brand Name' },
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_meta_only',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  const imageRequest = request.input.media_requests?.find(
    (entry) => entry.type === 'image.generate',
  );
  assert.ok(imageRequest, 'expected an image.generate media request for meta-only channel');
  assert.equal(imageRequest.type, 'image.generate');
  if (imageRequest.type === 'image.generate') {
    assert.equal(imageRequest.aspect_ratio, '1:1');
    assert.deepEqual(imageRequest.target_channels, ['meta']);
  }
});

test('weekly workflow request emits 4:5 for instagram-only image target channel', () => {
  const doc = {
    tenant_id: 'tenant_ig_only',
    job_id: 'mkt_ig_only',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: '',
      competitor_brand: '',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        primaryGoal: 'Drive Instagram reach',
        channels: ['instagram'],
      },
    },
    brand_kit: { brand_name: 'Brand Name' },
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_ig_only',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  const imageRequest = request.input.media_requests?.find(
    (entry) => entry.type === 'image.generate',
  );
  assert.ok(imageRequest, 'expected an image.generate media request for instagram-only channel');
  if (imageRequest && imageRequest.type === 'image.generate') {
    assert.equal(imageRequest.aspect_ratio, '4:5');
    assert.deepEqual(imageRequest.target_channels, ['instagram']);
  }
});

test('weekly workflow request emits 4:5 for bundled meta+instagram (Instagram priority)', () => {
  const doc = {
    tenant_id: 'tenant_bundled',
    job_id: 'mkt_bundled',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: '',
      competitor_brand: '',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        primaryGoal: 'Drive cross-channel reach',
      },
    },
    brand_kit: { brand_name: 'Brand Name' },
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_bundled',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  const imageRequest = request.input.media_requests?.find(
    (entry) => entry.type === 'image.generate',
  );
  assert.ok(imageRequest, 'expected an image.generate media request for bundled meta+instagram');
  if (imageRequest && imageRequest.type === 'image.generate') {
    assert.equal(imageRequest.aspect_ratio, '4:5');
    assert.deepEqual(imageRequest.target_channels, ['meta', 'instagram']);
  }
});

test('weekly workflow request preserves video aspect_ratio at 9:16 regardless of channel mix', () => {
  const doc = {
    tenant_id: 'tenant_video',
    job_id: 'mkt_video',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: '',
      competitor_brand: '',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        primaryGoal: 'Launch reels',
        videoRenderCount: 1,
        channels: ['meta'],
      },
    },
    brand_kit: { brand_name: 'Brand Name' },
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_video',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  const videoRequest = request.input.media_requests?.find(
    (entry) => entry.type === 'video.generate',
  );
  assert.ok(videoRequest, 'expected a video.generate media request when videoRenderCount > 0');
  if (videoRequest && videoRequest.type === 'video.generate') {
    assert.equal(videoRequest.aspect_ratio, '9:16');
  }
});
