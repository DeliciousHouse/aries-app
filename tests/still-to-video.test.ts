/**
 * Regression coverage for the YouTube still→video synthesis argv (#636).
 *
 * `buildFfmpegArgs` is pure (no I/O), so the argv shape is asserted here without
 * an ffmpeg binary — the CI runner has none; the runtime image installs it. The
 * actual encode is smoke-tested out-of-band against a real ffmpeg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFfmpegArgs, DEFAULT_VIDEO_DURATION_SEC, synthesizeStillToVideo } from '@/backend/integrations/still-to-video';

test('buildFfmpegArgs: loops the still, adds silent stereo audio, scales/crops/zoompans, h264+yuv420p, capped duration', () => {
  const args = buildFfmpegArgs({ inputPath: '/in/frame.png', outputPath: '/out/video.mp4', durationSec: 7 });

  // Looped single image input
  const loopIdx = args.indexOf('-loop');
  assert.ok(loopIdx >= 0, 'must loop the still');
  assert.equal(args[loopIdx + 1], '1');
  assert.equal(args[args.indexOf('-i')], '-i');
  assert.ok(args.includes('/in/frame.png'), 'input image path present');

  // Silent audio source (YouTube favors a present audio stream)
  assert.ok(args.some((a) => a.startsWith('anullsrc=')), 'silent audio source present');

  // Capped duration
  const tIdx = args.indexOf('-t');
  assert.ok(tIdx >= 0, 'duration cap present');
  assert.equal(args[tIdx + 1], '7');

  // Filter: scale to cover, crop to 1920x1080, zoompan (Ken Burns)
  const fcIdx = args.indexOf('-filter_complex');
  assert.ok(fcIdx >= 0, 'filter_complex present');
  const filter = args[fcIdx + 1];
  assert.match(filter, /scale=1920:1080:force_original_aspect_ratio=increase/);
  assert.match(filter, /crop=1920:1080/);
  assert.match(filter, /zoompan=/);

  // The filter output is labeled and BOTH streams are mapped to the output:
  // the processed video [v] and the silent audio (input 1). Asserting the maps
  // (not just that anullsrc/aac appear somewhere) proves the audio is actually
  // wired into the muxed output, not a dangling unused input.
  assert.match(filter, /\[0:v\].*\[v\]/, 'video filter chain must be labeled [0:v]...[v]');
  const mapIdxs = args.reduce<number[]>((acc, a, i) => (a === '-map' ? [...acc, i] : acc), []);
  assert.equal(mapIdxs.length, 2, 'exactly two -map args (video + audio)');
  assert.deepEqual(
    mapIdxs.map((i) => args[i + 1]).sort(),
    ['1:a', '[v]'],
    'must map the filtered video [v] and the silent audio stream 1:a to the output',
  );

  // Codecs + universal pixel format
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.ok(args.includes('-shortest'), 'shortest flag present so the clip ends with the video');

  // Output path is the last arg
  assert.equal(args[args.length - 1], '/out/video.mp4');
});

// ── synthesizeStillToVideo error-classification (fetch leg; no ffmpeg needed) ──
// These exercise the real I/O wrapper's failure paths, which run BEFORE ffmpeg,
// so they need no binary. A throw here is what the publisher converts into a
// ComposioToolError (definitely-never-posted → safe rollback + re-claim).

test('synthesizeStillToVideo: a non-ok image fetch throws (never reaches ffmpeg)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(
      () => synthesizeStillToVideo({ image: 'https://media.example/missing.png' }),
      /HTTP 404/,
      'a non-ok fetch must throw before the encode',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('synthesizeStillToVideo: an empty-body image fetch throws (never reaches ffmpeg)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(0), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      () => synthesizeStillToVideo({ image: 'https://media.example/empty.png' }),
      /no bytes/,
      'an empty image body must throw before the encode',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('buildFfmpegArgs: a non-positive/omitted duration falls back to the default', () => {
  const a = buildFfmpegArgs({ inputPath: '/in.png', outputPath: '/out.mp4' });
  assert.equal(a[a.indexOf('-t') + 1], String(DEFAULT_VIDEO_DURATION_SEC));

  const b = buildFfmpegArgs({ inputPath: '/in.png', outputPath: '/out.mp4', durationSec: 0 });
  assert.equal(b[b.indexOf('-t') + 1], String(DEFAULT_VIDEO_DURATION_SEC));

  const c = buildFfmpegArgs({ inputPath: '/in.png', outputPath: '/out.mp4', durationSec: -5 });
  assert.equal(c[c.indexOf('-t') + 1], String(DEFAULT_VIDEO_DURATION_SEC));
});

test('buildFfmpegArgs: argv uses no shell metacharacters around the paths (execFile-safe)', () => {
  // Paths are passed as discrete argv entries (not interpolated into a shell
  // string), so even an adversarial path is inert. Assert the input/output are
  // standalone entries, never concatenated with flags.
  const weird = '/tmp/a b; rm -rf x/frame.png';
  const args = buildFfmpegArgs({ inputPath: weird, outputPath: '/out.mp4' });
  assert.ok(args.includes(weird), 'input path is a single discrete argv entry');
  assert.equal(args.filter((a) => a === weird).length, 1, 'input path appears exactly once, unsplit');
});
