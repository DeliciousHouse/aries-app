import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMediaForSurface } from '../backend/integrations/meta-media-validation';
import { MetaPublishError } from '../backend/integrations/meta-publishing';

function vid(extra: { widthPx?: number | null; heightPx?: number | null; durationSeconds?: number | null }) {
  return { url: 'https://cdn.example.com/v.mp4', ...extra };
}

test('9:16 30s video passes for reel', () => {
  assert.doesNotThrow(() =>
    validateMediaForSurface({
      media: [vid({ widthPx: 1080, heightPx: 1920, durationSeconds: 30 })],
      surface: 'reel',
      mediaType: 'video',
    }),
  );
});

test('image for reel fails with media_type_mismatch', () => {
  try {
    validateMediaForSurface({
      media: [{ url: 'https://cdn.example.com/i.png' }],
      surface: 'reel',
      mediaType: 'image',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MetaPublishError);
    assert.equal(err.code, 'media_type_mismatch');
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
  }
});

test('120s video fails for story with duration_exceeds_story_limit', () => {
  try {
    validateMediaForSurface({
      media: [vid({ widthPx: 1080, heightPx: 1920, durationSeconds: 120 })],
      surface: 'story',
      mediaType: 'video',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MetaPublishError);
    assert.equal(err.code, 'duration_exceeds_story_limit');
    assert.equal(err.status, 400);
  }
});

test('two videos fail for story with single_media_required', () => {
  try {
    validateMediaForSurface({
      media: [
        vid({ widthPx: 1080, heightPx: 1920, durationSeconds: 20 }),
        vid({ widthPx: 1080, heightPx: 1920, durationSeconds: 20 }),
      ],
      surface: 'story',
      mediaType: 'video',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MetaPublishError);
    assert.equal(err.code, 'single_media_required');
  }
});

test('missing metadata fails closed for reel', () => {
  try {
    validateMediaForSurface({
      media: [vid({ widthPx: null, heightPx: null, durationSeconds: null })],
      surface: 'reel',
      mediaType: 'video',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MetaPublishError);
    assert.equal(err.code, 'missing_video_metadata');
    assert.equal(err.retryable, false);
  }
});

test('reel rejects a scheduledFor', () => {
  try {
    validateMediaForSurface({
      media: [vid({ widthPx: 1080, heightPx: 1920, durationSeconds: 30 })],
      surface: 'reel',
      mediaType: 'video',
      scheduledFor: '2026-06-01T15:00:00.000Z',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MetaPublishError);
    assert.equal(err.code, 'reel_scheduled_publish_not_supported');
  }
});

test('feed image and feed video both pass within limits', () => {
  assert.doesNotThrow(() =>
    validateMediaForSurface({ media: [{ url: 'https://cdn.example.com/i.png' }], surface: 'feed', mediaType: 'image' }),
  );
  assert.doesNotThrow(() =>
    validateMediaForSurface({
      media: [vid({ widthPx: 1080, heightPx: 1080, durationSeconds: 20 })],
      surface: 'feed',
      mediaType: 'video',
    }),
  );
});
