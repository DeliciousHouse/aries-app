/**
 * Still-image → short-video synthesis (for YouTube publish, #636).
 *
 * YouTube's publish action is a VIDEO upload, but the Aries content pipeline
 * emits a single still image per post. To satisfy the publish gate we synthesize
 * a short MP4 from the approved still: a gentle Ken-Burns slow-zoom over a
 * 1920×1080 frame with a silent audio track (YouTube favors a present audio
 * stream and universal `yuv420p` pixels).
 *
 * The ffmpeg argv builder is pure (no I/O) so it is unit-testable without a
 * binary on the CI runner — the runtime image installs ffmpeg (see Dockerfile),
 * the test asserts the argv shape. `synthesizeStillToVideo` does the I/O: it
 * resolves the image (URL or local path) to a temp file, runs ffmpeg via
 * `execFile` (argv array — NO shell, so no injection surface), and returns the
 * output path plus a `cleanup()` the caller invokes once the bytes are staged.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withTaskExecutionLog } from '@/backend/telemetry/task-execution-log';

const execFileAsync = promisify(execFile);

/** ffmpeg binary; overridable for non-standard install paths. */
const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

/** Default clip length. Short enough to keep encode + upload cheap. */
export const DEFAULT_VIDEO_DURATION_SEC = 7;

/**
 * Cap the source-image fetch. Without it a media host that accepts the
 * connection but stalls the body would block the publish-dispatch request far
 * longer than the ffmpeg budget below (the worker gives up at 30s, but its abort
 * does not cancel this server-side call). On timeout the fetch throws → the
 * function's catch cleans up + rethrows → the publisher classifies it as
 * definitely-never-posted (safe rollback + re-claim).
 */
const FETCH_TIMEOUT_MS = 30_000;

const OUTPUT_FPS = 30;
const ZOOM_STEP = 0.0008; // per-frame zoom increment
const ZOOM_MAX = 1.15; // cap so the pan stays subtle, not jarring

export interface StillToVideoResult {
  /** Absolute path to the synthesized MP4 (inside a private temp dir). */
  path: string;
  /** Removes the temp dir + its contents. Call after the bytes are staged. */
  cleanup: () => Promise<void>;
}

export interface BuildFfmpegArgsOptions {
  inputPath: string;
  outputPath: string;
  durationSec?: number;
}

/**
 * Build the ffmpeg argv for a still → Ken-Burns MP4. Pure — no I/O — so the
 * shape (looped image input, silent stereo audio, scale/crop/zoompan, libx264,
 * yuv420p, capped duration) is asserted in `npm run verify` without ffmpeg.
 */
export function buildFfmpegArgs(options: BuildFfmpegArgsOptions): string[] {
  const duration =
    options.durationSec && options.durationSec > 0
      ? options.durationSec
      : DEFAULT_VIDEO_DURATION_SEC;
  const frames = Math.max(1, Math.round(duration * OUTPUT_FPS));
  // Scale the still to fully cover 1920×1080, crop the overflow, then apply a
  // slow centered zoom (zoompan x/y keep the focus centered as it zooms in).
  const filter =
    'scale=1920:1080:force_original_aspect_ratio=increase,' +
    'crop=1920:1080,' +
    `zoompan=z='min(zoom+${ZOOM_STEP},${ZOOM_MAX})':` +
    "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':" +
    `d=${frames}:s=1920x1080:fps=${OUTPUT_FPS}`;
  return [
    '-y',
    '-loop',
    '1',
    '-i',
    options.inputPath,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t',
    String(duration),
    '-filter_complex',
    `[0:v]${filter}[v]`,
    '-map',
    '[v]',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-r',
    String(OUTPUT_FPS),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    options.outputPath,
  ];
}

/**
 * Synthesize a short MP4 from a still image. `image` may be an https URL (it is
 * fetched to a temp file first — robust against ffmpeg's network quirks) or a
 * local path. On ANY failure the temp dir is cleaned up and the error is
 * rethrown so the caller can classify it as definitely-never-posted.
 */
/**
 * AA-159: still→video synthesis is LOCAL_EDGE work — ffmpeg on this host, zero
 * tokens, cost is CPU/wall time. Pass-through when the telemetry flag is off.
 */
export async function synthesizeStillToVideo(input: {
  image: string;
  durationSec?: number;
}): Promise<StillToVideoResult> {
  return withTaskExecutionLog(
    { engine: 'LOCAL_EDGE', taskKey: 'integrations.still_to_video' },
    () => synthesizeStillToVideoCompute(input),
  );
}

async function synthesizeStillToVideoCompute(input: {
  image: string;
  durationSec?: number;
}): Promise<StillToVideoResult> {
  const dir = await mkdtemp(join(tmpdir(), 'aries-yt-still-'));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  try {
    let imagePath: string;
    if (/^https?:\/\//i.test(input.image)) {
      const res = await fetch(input.image, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(`failed to fetch source image (HTTP ${res.status})`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) {
        throw new Error('source image fetch returned no bytes');
      }
      imagePath = join(dir, 'frame');
      await writeFile(imagePath, bytes);
    } else {
      imagePath = input.image;
    }

    const outputPath = join(dir, 'video.mp4');
    const args = buildFfmpegArgs({
      inputPath: imagePath,
      outputPath,
      durationSec: input.durationSec,
    });
    await execFileAsync(FFMPEG_BIN, args, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    const out = await stat(outputPath);
    if (!out.isFile() || out.size === 0) {
      throw new Error('ffmpeg produced no output');
    }
    return { path: outputPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
