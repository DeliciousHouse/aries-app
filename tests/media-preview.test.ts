import assert from 'node:assert/strict';
import test from 'node:test';

// Import only the pure helpers from media-preview.tsx. The default export is a
// React component and isn't exercised here; we just verify that detection
// ignores query/hash suffixes and covers both image and video extensions so
// signed Lobster URLs (`...?sig=...`) still render inline.
import { imageLike, videoLike } from '../frontend/components/media-preview';

test('imageLike matches common image extensions regardless of query/hash suffix', () => {
  assert.equal(imageLike('https://cdn.example/meta-ads.png'), true);
  assert.equal(imageLike('https://cdn.example/meta-ads.PNG?sig=xyz'), true);
  assert.equal(imageLike('https://cdn.example/meta-ads.jpg?foo=bar&baz=qux'), true);
  assert.equal(imageLike('https://cdn.example/meta-ads.webp#fragment'), true);
  assert.equal(imageLike('https://cdn.example/meta-ads.svg?sig=xyz#frag'), true);
  assert.equal(imageLike(null), false);
  assert.equal(imageLike(undefined), false);
});

test('imageLike falls back to contentType prefix', () => {
  assert.equal(imageLike('/assets/unknown.bin', 'image/png'), true);
  assert.equal(imageLike('/assets/unknown.bin', 'video/mp4'), false);
  assert.equal(imageLike(null, null), false);
});

test('videoLike matches video extensions and ignores query/hash', () => {
  assert.equal(videoLike('https://cdn.example/meta-ads.mp4'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.MP4?sig=xyz'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.mov?a=1'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.webm#chapter'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.m4v?sig=xyz&exp=1'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.ogv'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.ogg'), true);
  assert.equal(videoLike('https://cdn.example/meta-ads.png'), false);
  assert.equal(videoLike('https://cdn.example/meta-ads.png?sig=xyz'), false);
  assert.equal(videoLike(null), false);
});

test('videoLike falls back to contentType prefix', () => {
  assert.equal(videoLike('/assets/unknown.bin', 'video/mp4'), true);
  assert.equal(videoLike('/assets/unknown.bin', 'video/quicktime'), true);
  assert.equal(videoLike('/assets/unknown.bin', 'image/png'), false);
});
