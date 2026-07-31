import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { defaultPublishConfig, publishConfigFromChannels } from '../backend/marketing/runtime-state';

/**
 * AA-76 regression: "Generate Weekly Content is not showing the correct
 * requested information." A weekly job created without an explicit publish
 * config fell back to a hardcoded extra platform plus a non-empty
 * `video_render_platforms`, so the dashboard showed a platform the tenant
 * never chose and a phantom "Video render" / planned-video count — even
 * though the pipeline renders no video by default.
 *
 * The default must reflect what actually happens: image posts for
 * Facebook + Instagram, no video. `live_publish_platforms` stays meta-ads only
 * (it is read by the real FB/IG publish handlers). The explicit-input
 * passthrough must be untouched — only the FALLBACK changed.
 */

test('AA-76: default publish config is FB + IG only with no phantom video', () => {
  const cfg = defaultPublishConfig();
  assert.deepEqual(cfg.platforms, ['meta-ads', 'instagram'], 'default platforms should be FB + IG only');
  assert.deepEqual(cfg.video_render_platforms, [], 'default must render no video (video is opt-in)');
  assert.deepEqual(cfg.live_publish_platforms, ['meta-ads'], 'live publish default stays conservative');
});

test('AA-76: explicit publish-config input is still honored (only the fallback changed)', () => {
  const cfg = defaultPublishConfig({
    platforms: ['linkedin'],
    live_publish_platforms: ['linkedin'],
    video_render_platforms: ['linkedin'],
  });
  assert.deepEqual(cfg.platforms, ['linkedin']);
  assert.deepEqual(cfg.live_publish_platforms, ['linkedin']);
  assert.deepEqual(cfg.video_render_platforms, ['linkedin'], 'explicit video request must pass through unchanged');
});

test('AA-76: channel-derived config for meta/instagram renders no video', () => {
  const cfg = publishConfigFromChannels(['meta', 'instagram']);
  assert.deepEqual(cfg.platforms, ['meta-ads', 'instagram']);
  assert.deepEqual(cfg.live_publish_platforms, ['meta-ads', 'instagram']);
  assert.deepEqual(cfg.video_render_platforms, [], 'meta/instagram are image targets — no video render');
});

test('AA-76: a genuine video channel (youtube) still drives video_render_platforms', () => {
  // Proves the fix only touched the fallback — real channel-driven video is intact.
  const cfg = publishConfigFromChannels(['meta', 'youtube']);
  assert.deepEqual(cfg.video_render_platforms, ['youtube']);
});

test('AA-76: empty/absent channels fall back to the no-video default', () => {
  assert.deepEqual(publishConfigFromChannels([]).video_render_platforms, []);
  assert.deepEqual(publishConfigFromChannels(null).video_render_platforms, []);
  assert.deepEqual(publishConfigFromChannels(undefined).platforms, ['meta-ads', 'instagram']);
});

test('AA-76: the workspace panel only shows "Video render" when video was actually requested', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../frontend/aries-v1/post-workspace.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(
    src,
    /videoRenderPlatforms\.length > 0/,
    'the Video render line must be gated on a non-empty videoRenderPlatforms',
  );
  assert.ok(
    !src.includes("Video render: {status.publishConfig.videoRenderPlatforms.join(', ') || 'not requested'}"),
    'the always-on "Video render … not requested" line must be gone',
  );
});
