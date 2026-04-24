import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import VideoPreview from '../frontend/components/video-preview';

test('VideoPreview renders a video element with the expected playback props', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(VideoPreview, {
        src: '/api/marketing/jobs/abc/assets/video-tiktok-A',
        poster: '/api/marketing/jobs/abc/assets/video-tiktok-A-poster',
        className: 'h-full w-full object-contain bg-black',
      }),
    );
  });

  const video = root.root.findByType('video');
  assert.equal(video.props.src, '/api/marketing/jobs/abc/assets/video-tiktok-A');
  assert.equal(video.props.poster, '/api/marketing/jobs/abc/assets/video-tiktok-A-poster');
  assert.equal(video.props.controls, true);
  assert.equal(video.props.playsInline, true);
  assert.equal(video.props.preload, 'metadata');
});
