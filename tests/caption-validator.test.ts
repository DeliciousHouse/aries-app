import { test } from 'node:test';
import assert from 'node:assert';
import { validateCaption } from '../backend/social-content/caption-validator';

test('caption-validator', async (t) => {
  await t.test('Instagram: empty caption fails', () => {
    const result = validateCaption({
      channel: 'instagram_feed',
      text: '',
    });
    assert.strictEqual(result.ok, false);
    assert(result.errors.includes('caption_empty'));
  });

  await t.test('Instagram: 2200 chars passes', () => {
    const text = 'a'.repeat(2200);
    const result = validateCaption({
      channel: 'instagram_feed',
      text,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test('Instagram: 2201 chars fails', () => {
    const text = 'a'.repeat(2201);
    const result = validateCaption({
      channel: 'instagram_feed',
      text,
    });
    assert.strictEqual(result.ok, false);
    assert(result.errors.includes('caption_too_long'));
  });

  await t.test('Instagram: 30 hashtags passes', () => {
    const hashtags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    const result = validateCaption({
      channel: 'instagram_feed',
      text: 'Hello world',
      hashtags,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test('Instagram: 31 hashtags fails', () => {
    const hashtags = Array.from({ length: 31 }, (_, i) => `tag${i}`);
    const result = validateCaption({
      channel: 'instagram_feed',
      text: 'Hello world',
      hashtags,
    });
    assert.strictEqual(result.ok, false);
    assert(result.errors.includes('too_many_hashtags'));
  });

  await t.test('Instagram: both length and hashtag violations', () => {
    const text = 'a'.repeat(2201);
    const hashtags = Array.from({ length: 31 }, (_, i) => `tag${i}`);
    const result = validateCaption({
      channel: 'instagram_feed',
      text,
      hashtags,
    });
    assert.strictEqual(result.ok, false);
    assert(result.errors.includes('caption_too_long'));
    assert(result.errors.includes('too_many_hashtags'));
  });

  await t.test('Facebook: 63206 chars passes', () => {
    const text = 'a'.repeat(63206);
    const result = validateCaption({
      channel: 'facebook_feed',
      text,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test('Facebook: 63207 chars fails', () => {
    const text = 'a'.repeat(63207);
    const result = validateCaption({
      channel: 'facebook_feed',
      text,
    });
    assert.strictEqual(result.ok, false);
    assert(result.errors.includes('caption_too_long'));
  });

  await t.test('Facebook: no hashtag limit', () => {
    const hashtags = Array.from({ length: 100 }, (_, i) => `tag${i}`);
    const result = validateCaption({
      channel: 'facebook_feed',
      text: 'Hello world',
      hashtags,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test('Facebook: empty caption fails', () => {
    const result = validateCaption({
      channel: 'facebook_feed',
      text: '',
    });
    assert.strictEqual(result.ok, false);
    assert(result.errors.includes('caption_empty'));
  });
});
