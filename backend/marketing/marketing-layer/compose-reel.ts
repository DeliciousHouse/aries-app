/**
 * Reel MARKETING LAYER compositor.
 *
 * Burns a tenant's own marketing layer onto a generated reel via ffmpeg:
 *   - timed copy beats  hook -> value -> CTA  (deterministic drawtext, not the
 *     model trying to render legible words)
 *   - the tenant's logo (small watermark + end-card lockup)
 *   - the tenant's brand colors
 *   - a license-safe music bed (synthesized, bundled under public/audio/marketing)
 *
 * Pure per-tenant: every string + the logo + the colors are passed in by the
 * caller from THAT tenant's content_package + brand kit. Best-effort: on any
 * ffmpeg failure the caller falls back to the raw video (publish is never
 * blocked). Returns the composited file path, or null on failure.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCodeRoot } from '@/lib/runtime-paths';
import {
  synthesizeVoiceover,
  fitCopyToDuration,
} from '@/backend/integrations/elevenlabs/tts';
import { isReelVoiceoverEnabled } from '@/backend/integrations/elevenlabs/voiceover-env';
import { withTaskExecutionLog } from '@/backend/telemetry/task-execution-log';
import {
  type ReelAudioMode,
  reelAudioModeWantsVoiceover,
  resolveReelAudioComposition,
} from '@/backend/marketing/reel-audio-mode';

export interface ReelMarketingCopy {
  hook: string;
  value: string;
  cta: string;
  brandName: string;
  url: string;
}
export interface ReelMarketingColors {
  primaryHex?: string | null; // CTA / accent text
  accentHex?: string | null; // sub text
}
export interface ComposeReelArgs {
  videoPath: string;
  outPath: string;
  copy: ReelMarketingCopy;
  colors?: ReelMarketingColors;
  logoPath?: string | null;
  jobId: string; // seeds deterministic music-bed choice
  fontPath?: string;
  /** Caller-supplied clip duration (seconds). When present and positive, skips
   * the ffprobe call — uses Hermes's reported duration so short clips (e.g.
   * grok reels at ~5-6 s) place the end-card correctly without a probe. */
  durationSeconds?: number;
  /** Resolved reel audio mode (music | voiceover | both). Decides whether a
   * voiceover is synthesized and whether the music bed is mixed in. Defaults to
   * 'both' when omitted so direct callers keep today's VO-over-music behavior;
   * the ingest call site passes the per-job/per-tenant resolved mode. */
  audioMode?: ReelAudioMode;
}

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];
const BEDS = ['bed-calm.mp3', 'bed-uplift.mp3', 'bed-bold.mp3'];
const DEFAULT_REEL_SECONDS = 15;

function resolveFont(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  return FONT_CANDIDATES.find((f) => existsSync(f)) ?? null;
}

/** Deterministic bed pick from the jobId so a tenant's week varies but is stable. */
function resolveMusicBed(jobId: string): string | null {
  let h = 0;
  for (let i = 0; i < jobId.length; i += 1) h = (h * 31 + jobId.charCodeAt(i)) >>> 0;
  const bed = BEDS[h % BEDS.length];
  const p = path.join(resolveCodeRoot(), 'public', 'audio', 'marketing', bed);
  return existsSync(p) ? p : null;
}

/** #rrggbb | rrggbb -> 0xRRGGBB for ffmpeg fontcolor; fallback on bad input. */
function hexToFfmpeg(hex: string | null | undefined, fallback: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  return m ? `0x${m[1].toUpperCase()}` : fallback;
}

/** Escape a string for an ffmpeg drawtext single-quoted text value. */
function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/:/g, '\\:')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** Greedy word-wrap into at most maxLines lines of ~maxChars, ellipsizing overflow. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = (text ?? '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > maxChars) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.length) {
    // ellipsize if we truncated
    const used = lines.join(' ').split(/\s+/).length;
    if (used < words.length) lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
  }
  return lines.length ? lines : [''];
}

/** Probe the actual duration of a video file via ffprobe.
 * Falls back to DEFAULT_REEL_SECONDS on any failure (no ffprobe, NaN, ≤0)
 * so behavior is unchanged when probing is unavailable. */
async function probeDurationSeconds(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    p.on('error', () => resolve(DEFAULT_REEL_SECONDS));
    p.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      const d = parseFloat(raw);
      resolve(isFinite(d) && d > 0 ? d : DEFAULT_REEL_SECONDS);
    });
  });
}

function drawtext(
  font: string,
  text: string,
  color: string,
  size: number,
  yExpr: string,
  t0: number,
  t1: number,
): string {
  if (!text || !text.trim()) return '';
  return (
    `drawtext=fontfile=${font}:text='${esc(text)}':fontcolor=${color}:fontsize=${size}` +
    `:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=${yExpr}` +
    `:enable='between(t,${t0},${t1})'`
  );
}

/** Stack wrapped lines from a baseline y-expression, spacing by line height. */
function stack(
  font: string,
  lines: string[],
  color: string,
  size: number,
  baseY: string,
  t0: number,
  t1: number,
): string[] {
  const lh = Math.round(size * 1.18);
  return lines.map((ln, i) => drawtext(font, ln, color, size, `${baseY}+${i * lh}`, t0, t1));
}

export interface ReelBeats {
  hookStart: number;
  hookEnd: number;
  valueStart: number;
  valueEnd: number;
  cardStart: number;
  ctaStart: number;
  urlStart: number;
  end: number;
}

/**
 * Pure, deterministic timeline derivation: given a clip duration in seconds,
 * returns the proportional beat boundaries used by the marketing layer
 * compositor. hookStart is a small lead-in offset that scales with the clip
 * (D*0.02) and is capped at 0.3s so it stays brief on longer clips; the
 * other beats scale linearly with D.
 *
 * Exported for unit-testing the proportional-scaling fix (previously the
 * beats were hardcoded to the 15-second DEFAULT_REEL_SECONDS regardless of
 * the actual clip duration — this function documents and locks the correct
 * behaviour).
 */
export function computeReelBeats(durationSeconds: number): ReelBeats {
  const D = durationSeconds;
  const hookStart  = +(Math.min(0.3, D * 0.02)).toFixed(2);
  const hookEnd    = +(D * 0.33).toFixed(2);
  const valueStart = +(D * 0.35).toFixed(2);
  const valueEnd   = +(D * 0.66).toFixed(2);
  const cardStart  = +(D * 0.68).toFixed(2);
  const ctaStart   = +(cardStart + D * 0.04).toFixed(2);
  const urlStart   = +(cardStart + D * 0.05).toFixed(2);
  const end        = +D.toFixed(2);
  return { hookStart, hookEnd, valueStart, valueEnd, cardStart, ctaStart, urlStart, end };
}

/**
 * AA-159: reel composition is LOCAL_EDGE work — ffmpeg burn-in on this host, no
 * model and no gateway, so zero tokens by construction and CPU/wall time is the
 * only cost. Pass-through when the telemetry flag is off.
 */
export async function composeReelMarketingLayer(args: ComposeReelArgs): Promise<string | null> {
  return withTaskExecutionLog(
    { engine: 'LOCAL_EDGE', taskKey: 'marketing.compose_reel_layer' },
    () => composeReelMarketingLayerCompute(args),
  );
}

async function composeReelMarketingLayerCompute(args: ComposeReelArgs): Promise<string | null> {
  const font = resolveFont(args.fontPath);
  if (!font) return null;
  if (!existsSync(args.videoPath)) return null;

  const WHITE = 'white';
  const ACCENT = hexToFfmpeg(args.colors?.accentHex, '0xA855F7');
  const CTA = hexToFfmpeg(args.colors?.primaryHex, '0xD8475F');

  const hookLines = wrap(args.copy.hook, 26, 2);
  const valueLines = wrap(args.copy.value, 22, 2);
  const ctaLine = wrap(args.copy.cta, 26, 1)[0];
  const brand = wrap(args.copy.brandName, 22, 1)[0];
  const url = wrap(args.copy.url, 34, 1)[0];

  const D = typeof args.durationSeconds === 'number' && args.durationSeconds > 0
    ? args.durationSeconds
    : await probeDurationSeconds(args.videoPath);

  // Proportional beat timeline — see computeReelBeats() for the formula and
  // the rationale behind each fraction.
  const { hookStart, hookEnd, valueStart, valueEnd, cardStart, ctaStart, urlStart, end } =
    computeReelBeats(D);

  // Beats are built purely from THIS tenant's copy — no hardcoded brand flavor.
  const dt: string[] = [
    ...stack(font, hookLines, WHITE, 56, 'h*0.60', hookStart, hookEnd),
    ...stack(font, valueLines, WHITE, 64, 'h*0.55', valueStart, valueEnd),
    drawtext(font, brand, WHITE, 80, 'h*0.37', cardStart, end),
    drawtext(font, ctaLine, WHITE, 54, 'h*0.62', ctaStart, end),
    drawtext(font, url, CTA, 46, 'h*0.62+86', urlStart, end),
  ];
  // ACCENT is reserved for future sub-copy; reference to keep it used.
  void ACCENT;

  const filters = dt.filter(Boolean).join(',');
  if (!filters) return null; // nothing to burn — let caller keep the raw video
  const logo = args.logoPath && existsSync(args.logoPath) ? args.logoPath : null;

  // Resolve the audio mode (defaults to 'both' so direct callers/tests keep the
  // historical VO-over-music behavior). Voiceover capability is still gated at
  // the deployment level by the flag + key; a mode that wants VO without that
  // capability degrades to the music bed (never a silent reel).
  const mode: ReelAudioMode = args.audioMode ?? 'both';
  const voiceoverEnabled = isReelVoiceoverEnabled();
  const hasVoiceoverKey = !!process.env.ELEVENLABS_API_KEY;

  // Attempt voiceover synthesis only when the mode wants it AND the deployment
  // gate + key are present (best-effort; any failure falls back per the
  // composition rule below). Skipping synthesis entirely for mode='music' keeps
  // the music-only output byte-identical to today.
  let voPath: string | null = null;
  if (reelAudioModeWantsVoiceover(mode) && voiceoverEnabled && hasVoiceoverKey) {
    const voScript = fitCopyToDuration(args.copy, D);
    const tmpVo = path.join(
      os.tmpdir(),
      `aries-reel-vo-${args.jobId}-${Date.now()}.mp3`,
    );
    try {
      voPath = await synthesizeVoiceover({ text: voScript, outPath: tmpVo });
    } catch {
      voPath = null;
    }
  }

  // Pure decision: given the mode + runtime facts, what does the final audio
  // graph contain? See resolveReelAudioComposition for the guarantees.
  const musicBed = resolveMusicBed(args.jobId);
  const audio = resolveReelAudioComposition({
    mode,
    voiceoverEnabled,
    hasVoiceoverKey,
    voiceoverSucceeded: !!voPath,
    musicBedAvailable: !!musicBed,
  });
  const music = audio.useMusic ? musicBed : null;
  // `voPath` stays the synthesized temp path (cleaned up in finally even when
  // unused); `useVo` decides whether it is actually muxed into the output.
  const useVo = audio.useVoiceover && !!voPath;

  // Build inputs + filter_complex
  const inputs: string[] = ['-i', args.videoPath];
  let audioInIdx = -1;
  let voInIdx = -1;
  let logoInIdx = -1;
  let nextIdx = 1;
  if (music) {
    inputs.push('-i', music);
    audioInIdx = nextIdx;
    nextIdx += 1;
  }
  if (useVo && voPath) {
    inputs.push('-i', voPath);
    voInIdx = nextIdx;
    nextIdx += 1;
  }
  if (logo) {
    inputs.push('-i', logo);
    logoInIdx = nextIdx;
    nextIdx += 1;
  }

  let fc = '';
  let vlabel = '[0:v]';
  if (logo) {
    fc +=
      `[${logoInIdx}:v]split[lA][lB];[lA]scale=96:-1[logosm];[lB]scale=250:-1[logobig];`;
  }
  fc += `${vlabel}${filters}[vt];`;
  if (logo) {
    fc += `[vt][logosm]overlay=x=(W-w)/2:y=70:enable='between(t,0,${cardStart})'[v1];`;
    fc += `[v1][logobig]overlay=x=(W-w)/2:y=H*0.15:enable='between(t,${cardStart},${end})'[v];`;
  } else {
    fc += `[vt]copy[v];`;
  }

  const map: string[] = ['-map', '[v]'];
  if (useVo && voInIdx >= 0) {
    if (music && audioInIdx >= 0) {
      // VO ────────────────────────────────────────┐
      // music ──(volume=0.18)──[mus_duck]────────┘ → amix → alimiter → [a]
      // apad=whole_dur=<D> pads the mixed audio to EXACTLY the clip duration
      // (finite). A bare apad pads forever, and -shortest cannot bound a
      // filtered (vs input) stream, so ffmpeg never terminates — the VO-path
      // hang. whole_dur makes the audio finite and = the video length (#751).
      fc += `[${audioInIdx}:a]volume=0.18[mus_duck];`;
      fc += `[mus_duck][${voInIdx}:a]amix=inputs=2:duration=longest[mixed];`;
      fc += `[mixed]alimiter=limit=0.99,apad=whole_dur=${end}[a]`;
    } else {
      // VO only (no music bed on disk) — same finite-pad to the clip duration.
      fc += `[${voInIdx}:a]aresample=44100,apad=whole_dur=${end}[a]`;
    }
    map.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  } else if (music && audioInIdx >= 0) {
    // Fallback: music-bed-only — byte-identical to today when VO is off/absent
    fc += `[${audioInIdx}:a]volume=0.9[a]`;
    map.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  }
  // strip a trailing ';' if no audio chain appended
  fc = fc.replace(/;$/, '');

  const ffArgs = [
    '-y',
    ...inputs,
    '-filter_complex',
    fc,
    ...map,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-shortest',
    args.outPath,
  ];

  let ok: boolean;
  try {
    ok = await new Promise<boolean>((resolve) => {
      const p = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  } finally {
    // Always clean up the temporary VO mp3 (may not exist if synthesis failed)
    if (voPath) unlink(voPath).catch(() => {});
  }
  return ok && existsSync(args.outPath) ? args.outPath : null;
}
