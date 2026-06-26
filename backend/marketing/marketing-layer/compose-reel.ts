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
import path from 'node:path';
import { resolveCodeRoot } from '@/lib/runtime-paths';

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
}

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];
const BEDS = ['bed-calm.mp3', 'bed-uplift.mp3', 'bed-bold.mp3'];

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

export async function composeReelMarketingLayer(args: ComposeReelArgs): Promise<string | null> {
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

  // Beats are built purely from THIS tenant's copy — no hardcoded brand flavor.
  const dt: string[] = [
    ...stack(font, hookLines, WHITE, 56, 'h*0.60', 0.3, 5),
    ...stack(font, valueLines, WHITE, 64, 'h*0.55', 5.2, 10),
    drawtext(font, brand, WHITE, 80, 'h*0.37', 10.2, 15),
    drawtext(font, ctaLine, WHITE, 54, 'h*0.62', 10.6, 15),
    drawtext(font, url, CTA, 46, 'h*0.62+86', 11.0, 15),
  ];
  // ACCENT is reserved for future sub-copy; reference to keep it used.
  void ACCENT;

  const filters = dt.filter(Boolean).join(',');
  if (!filters) return null; // nothing to burn — let caller keep the raw video
  const logo = args.logoPath && existsSync(args.logoPath) ? args.logoPath : null;
  const music = resolveMusicBed(args.jobId);

  // Build inputs + filter_complex
  const inputs: string[] = ['-i', args.videoPath];
  let audioInIdx = -1;
  let logoInIdx = -1;
  let nextIdx = 1;
  if (music) {
    inputs.push('-i', music);
    audioInIdx = nextIdx;
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
    fc += `[vt][logosm]overlay=x=(W-w)/2:y=70:enable='between(t,0,10.2)'[v1];`;
    fc += `[v1][logobig]overlay=x=(W-w)/2:y=H*0.15:enable='between(t,10.2,15)'[v];`;
  } else {
    fc += `[vt]copy[v];`;
  }

  const map: string[] = ['-map', '[v]'];
  if (music) {
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

  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  return ok && existsSync(args.outPath) ? args.outPath : null;
}
