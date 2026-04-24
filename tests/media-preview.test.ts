import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

// Import only the pure helpers from media-preview.tsx. The default export is a
// React component and isn't exercised here; we just verify that detection
// ignores query/hash suffixes and covers both image and video extensions so
// signed Lobster URLs (`...?sig=...`) still render inline.
import MediaPreview, { imageLike, videoLike } from '../frontend/components/media-preview';

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

test('MediaPreview renders an img for image content types', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(MediaPreview, {
        src: '/api/marketing/jobs/abc/assets/image-meta-A',
        alt: 'Meta image',
        contentType: 'image/png',
        className: 'h-40',
      }),
    );
  });

  const image = root.root.findByType('img');
  assert.equal(image.props.src, '/api/marketing/jobs/abc/assets/image-meta-A');
  assert.equal(image.props.alt, 'Meta image');
  assert.equal(root.root.findAllByType('video').length, 0);
});

test('MediaPreview renders a video for video content types', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(MediaPreview, {
        src: '/api/marketing/jobs/abc/assets/video-tiktok-A',
        poster: '/api/marketing/jobs/abc/assets/video-tiktok-A-poster',
        alt: 'TikTok video',
        contentType: 'video/mp4',
        className: 'h-40',
      }),
    );
  });

  const video = root.root.findByType('video');
  assert.equal(video.props.src, '/api/marketing/jobs/abc/assets/video-tiktok-A');
  assert.equal(video.props.poster, '/api/marketing/jobs/abc/assets/video-tiktok-A-poster');
  assert.equal(root.root.findAllByType('img').length, 0);
});

test('MediaPreview keeps the existing fallback for unsupported content', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(MediaPreview, {
        src: '/api/marketing/jobs/abc/assets/doc-meta-A',
        alt: 'Meta document',
        contentType: 'application/pdf',
        nonImageLabel: 'Open asset preview',
        className: 'h-40',
      }),
    );
  });

  assert.equal(root.root.findAllByType('img').length, 0);
  assert.equal(root.root.findAllByType('video').length, 0);
  assert.match(JSON.stringify(root.toJSON()), /Open asset preview/);
});
