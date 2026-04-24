import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { RenderedVideosSection } from '../frontend/aries-v1/campaign-workspace';

test('RenderedVideosSection renders one video card per rendered video artifact', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(RenderedVideosSection, {
        artifacts: [
          {
            id: 'video_tiktok_offer_clarity',
            type: 'video',
            stage: 'production',
            title: 'TikTok offer clarity',
            category: 'creative',
            status: 'ready',
            summary: 'Rendered creative',
            details: [],
            contentType: 'video/mp4',
            url: 'https://cdn.example.com/tiktok-offer-clarity.mp4',
            posterUrl: 'https://cdn.example.com/tiktok-offer-clarity.jpg',
            platformSlug: 'tiktok',
            familyId: 'offer-clarity',
            durationSeconds: 21,
            aspectRatio: '9:16',
          },
          {
            id: 'video_meta_proof_stack',
            type: 'video',
            stage: 'production',
            title: 'Meta proof stack',
            category: 'creative',
            status: 'ready',
            summary: 'Rendered creative',
            details: [],
            contentType: 'video/mp4',
            url: 'https://cdn.example.com/meta-proof-stack.mp4',
            posterUrl: 'https://cdn.example.com/meta-proof-stack.jpg',
            platformSlug: 'meta-ads',
            familyId: 'proof-stack',
            durationSeconds: 30,
            aspectRatio: '1:1',
          },
        ],
      }),
    );
  });

  assert.match(JSON.stringify(root.toJSON()), /Rendered videos/);

  const videos = root.root.findAllByType('video');
  assert.equal(videos.length, 2);
  assert.deepEqual(
    videos.map((video) => ({ src: video.props.src, poster: video.props.poster })),
    [
      {
        src: 'https://cdn.example.com/tiktok-offer-clarity.mp4',
        poster: 'https://cdn.example.com/tiktok-offer-clarity.jpg',
      },
      {
        src: 'https://cdn.example.com/meta-proof-stack.mp4',
        poster: 'https://cdn.example.com/meta-proof-stack.jpg',
      },
    ],
  );
});

test('RenderedVideosSection renders nothing when no video artifacts are present', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(RenderedVideosSection, {
        artifacts: [],
      }),
    );
  });

  assert.equal(root.toJSON(), null);
});
