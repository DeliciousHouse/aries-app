import { readFile } from 'node:fs/promises';

import sharp from 'sharp';

import type {
  SocialContentImageChannel,
  SocialContentMediaPostType,
} from '@/backend/social-content/aspect-matrix';
import { withTaskExecutionLog } from '@/backend/telemetry/task-execution-log';

/**
 * Brand-frame overlay for IG/FB feed static images. Runs AFTER vision QA pass
 * (T12) and BEFORE delivery to per-platform preview/publish (T22). Out of scope:
 * carousels, link cards, videos, watermark text, drop shadows, template editor.
 *
 * Design contract:
 *   - Eligibility = channel ∈ {instagram, meta} AND postType = 'single_image'.
 *   - Eligible: composite a 2px primary-color inner border + bottom-right logo
 *     overlay, preserving input dimensions exactly.
 *   - Not eligible: return assetBuffer unchanged (byte-identical reference).
 *   - No network fetch from default loader unless explicitly enabled; tests
 *     always inject `logoLoader` to remain deterministic and offline.
 */

/**
 * Subset of `TenantBrandKit` (backend/marketing/brand-kit.ts) that this module
 * depends on. We deliberately accept a narrowed shape so callers can pass any
 * brand-kit-shaped payload without dragging the full marketing brand-kit type
 * graph into creative-memory.
 */
export interface BrandKitFrameInput {
  logo_urls?: readonly string[] | null;
  colors?:
    | {
        primary?: string | null;
      }
    | null;
}

export type LogoLoader = (logoUrl: string) => Promise<Buffer | null>;

export interface ApplyBrandFrameInput {
  assetBuffer: Buffer;
  brandKit: BrandKitFrameInput;
  channel: SocialContentImageChannel;
  postType: SocialContentMediaPostType;
  /**
   * Test seam: synchronously resolve a logo URL/data URI/file path to bytes.
   * Tests MUST inject this so no live network or filesystem access happens. The
   * default loader (`defaultLogoLoader`) supports `data:` URIs and absolute
   * filesystem paths only — HTTP(S) URLs return `null` and the frame is drawn
   * without a logo.
   */
  logoLoader?: LogoLoader;
  /**
   * When `false`, skip the inner border stroke and composite the logo only
   * (the on-brand-dark feed treatment). Default (undefined/true) keeps the
   * legacy border + logo behavior.
   */
  border?: boolean;
  /**
   * Direct logo source: an absolute filesystem path or a `data:` URI. When
   * provided it takes precedence over brandKit.logo_urls. Resolved by the
   * active logoLoader (defaultLogoLoader handles both). Wire the brand kit's
   * materialized `logo_file_path` here.
   */
  logoSource?: string | null;
}

// Border stroke: 2px is wide enough to read on a 1080×1080 IG canvas without
// crowding the bleed; matches the value the operator preview UI (T22) will
// echo back. Logo footprint targets ~12% of canvas width — visible without
// dominating composition. Margin keeps the logo off the bleed edge.
const FRAME_BORDER_PX = 2;
const LOGO_RELATIVE_WIDTH = 0.12;
const LOGO_MARGIN_PX = 24;
const FALLBACK_BORDER_HEX = '#0f172a'; // slate-900: neutral, high-contrast on most static feeds.

// Conditional feathered scrim: the brand mark is light/purple on transparent,
// so it vanishes over a bright patch of a generated photo. When the mean
// luminance under the logo box exceeds the threshold, a soft low-opacity dark
// scrim is composited behind ONLY the logo so it always reads. On a dark patch
// no chrome is added (subtraction-default).
const SCRIM_LUMA_THRESHOLD = 150; // 0-255 mean luma; above this the box is "bright".
const SCRIM_PAD_PX = 12; // expand the scrim a touch past the logo box.
const SCRIM_BLUR_SIGMA = 12; // feather the scrim edges.
const SCRIM_OPACITY = 0.45; // dark scrim alpha.

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

function isFrameEligible(
  channel: SocialContentImageChannel,
  postType: SocialContentMediaPostType,
): boolean {
  if (postType !== 'single_image') return false;
  return channel === 'instagram' || channel === 'meta';
}

function resolveBorderColor(brandKit: BrandKitFrameInput): {
  hex: string;
  fallbackUsed: boolean;
} {
  const raw = brandKit.colors?.primary?.trim();
  if (raw && HEX_PATTERN.test(raw)) {
    return { hex: raw.toLowerCase(), fallbackUsed: false };
  }
  return { hex: FALLBACK_BORDER_HEX, fallbackUsed: true };
}

function pickLogoUrl(brandKit: BrandKitFrameInput): string | null {
  const list = brandKit.logo_urls ?? [];
  for (const candidate of list) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function buildBorderSvg(width: number, height: number, hex: string): Buffer {
  // Stroke is centered on the path; offsetting rect by FRAME_BORDER_PX/2 pushes
  // the full 2px stroke INSIDE the canvas so the visible image is not cropped
  // and the output dimensions match the input exactly.
  const inset = FRAME_BORDER_PX / 2;
  const rectWidth = width - FRAME_BORDER_PX;
  const rectHeight = height - FRAME_BORDER_PX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="${inset}" y="${inset}" width="${rectWidth}" height="${rectHeight}" fill="none" stroke="${hex}" stroke-width="${FRAME_BORDER_PX}" /></svg>`;
  return Buffer.from(svg, 'utf8');
}

async function decodeDataUriLogo(dataUri: string): Promise<Buffer | null> {
  // Match: data:[<mediatype>][;base64],<data>
  const comma = dataUri.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUri.slice(5, comma); // strip "data:"
  const payload = dataUri.slice(comma + 1);
  if (meta.toLowerCase().includes(';base64')) {
    try {
      return Buffer.from(payload, 'base64');
    } catch {
      return null;
    }
  }
  // Treat URL-encoded textual payloads (commonly inline SVGs) as utf-8 bytes.
  try {
    return Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return Buffer.from(payload, 'utf8');
  }
}

export async function defaultLogoLoader(logoUrl: string): Promise<Buffer | null> {
  const trimmed = logoUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) {
    return decodeDataUriLogo(trimmed);
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    // Default loader is offline-only. Production callers that need to pull
    // remote logos must inject a logoLoader that fetches; this default path
    // keeps tests and local runs deterministic.
    return null;
  }
  if (trimmed.startsWith('file://')) {
    try {
      return await readFile(new URL(trimmed));
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('/')) {
    try {
      return await readFile(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

async function prepareLogoOverlay(
  logoBuffer: Buffer,
  canvasWidth: number,
): Promise<Buffer | null> {
  const targetWidth = Math.max(
    1,
    Math.round(canvasWidth * LOGO_RELATIVE_WIDTH),
  );
  try {
    return await sharp(logoBuffer, { failOn: 'none' })
      .resize({ width: targetWidth, withoutEnlargement: false, fit: 'inside' })
      .png()
      .toBuffer();
  } catch {
    // A malformed/unsupported logo (e.g., corrupt SVG) must NOT fail the whole
    // frame application; the border still gives a brand cue. Return null so
    // the caller composites without the logo.
    return null;
  }
}

// Mean luminance (0-255) of the pixel patch under the logo box, via sharp
// extract+stats. Returns null on any failure so the caller skips the scrim.
async function meanLumaUnderBox(
  assetBuffer: Buffer,
  box: { left: number; top: number; width: number; height: number },
  canvasW: number,
  canvasH: number,
): Promise<number | null> {
  const left = Math.max(0, Math.min(box.left, canvasW - 1));
  const top = Math.max(0, Math.min(box.top, canvasH - 1));
  const width = Math.max(1, Math.min(box.width, canvasW - left));
  const height = Math.max(1, Math.min(box.height, canvasH - top));
  try {
    const { channels } = await sharp(assetBuffer, { failOn: 'none' })
      .extract({ left, top, width, height })
      .stats();
    // Rec. 601 luma over the first three (RGB) channel means; tolerate
    // grayscale (1 channel) by falling back to mean[0].
    const r = channels[0]?.mean ?? 0;
    const g = channels[1]?.mean ?? r;
    const b = channels[2]?.mean ?? r;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  } catch {
    return null;
  }
}

// A soft rounded dark rectangle, fed through sharp().blur() to feather the
// edges so it reads as a halo, not a sticker.
function buildScrimSvg(w: number, h: number): Buffer {
  const radius = Math.round(Math.min(w, h) * 0.15);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="black" fill-opacity="${SCRIM_OPACITY}" /></svg>`;
  return Buffer.from(svg, 'utf8');
}

export interface ApplyBrandFrameResult {
  buffer: Buffer;
  applied: boolean;
  reason?:
    | 'not_eligible'
    | 'framed_with_logo'
    | 'framed_without_logo';
  borderHex: string;
  fallbackBorderUsed: boolean;
}

/**
 * Single-pass entry point that returns ONLY the buffer (matches the plan's
 * `applyBrandFrame({ assetBuffer, brandKit, channel, postType })` contract).
 * For callers that need diagnostics, use `applyBrandFrameDetailed`.
 */
export async function applyBrandFrame(input: ApplyBrandFrameInput): Promise<Buffer> {
  const result = await applyBrandFrameDetailed(input);
  return result.buffer;
}

/**
 * AA-159: brand framing is LOCAL_EDGE work — sharp compositing on this host,
 * no model and no gateway, so it costs zero tokens and its only cost is CPU
 * time. The wrapper measures wall-clock + `process.cpuUsage()` and is a
 * pass-through when the telemetry flag is off.
 */
export async function applyBrandFrameDetailed(
  input: ApplyBrandFrameInput,
): Promise<ApplyBrandFrameResult> {
  return withTaskExecutionLog(
    { engine: 'LOCAL_EDGE', taskKey: 'creative.apply_brand_frame' },
    () => applyBrandFrameCompute(input),
  );
}

async function applyBrandFrameCompute(
  input: ApplyBrandFrameInput,
): Promise<ApplyBrandFrameResult> {
  const { assetBuffer, brandKit, channel, postType } = input;
  if (!isFrameEligible(channel, postType)) {
    return {
      buffer: assetBuffer,
      applied: false,
      reason: 'not_eligible',
      borderHex: '',
      fallbackBorderUsed: false,
    };
  }

  const metadata = await sharp(assetBuffer, { failOn: 'none' }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    // Cannot compose without dimensions; preserve original bytes.
    return {
      buffer: assetBuffer,
      applied: false,
      reason: 'not_eligible',
      borderHex: '',
      fallbackBorderUsed: false,
    };
  }

  const drawBorder = input.border !== false;
  const { hex: borderHex, fallbackUsed: fallbackBorderUsed } = resolveBorderColor(brandKit);

  const logoUrl =
    input.logoSource && input.logoSource.trim().length > 0
      ? input.logoSource.trim()
      : pickLogoUrl(brandKit);
  const loader = input.logoLoader ?? defaultLogoLoader;
  let logoOverlay: Buffer | null = null;
  if (logoUrl) {
    const logoBytes = await loader(logoUrl).catch(() => null);
    if (logoBytes && logoBytes.length > 0) {
      logoOverlay = await prepareLogoOverlay(logoBytes, width);
    }
  }

  // Nothing to draw: logo-only mode (border:false) with no usable logo, or the
  // logo failed to load. Return the ORIGINAL bytes unchanged — no re-encode, no
  // checksum churn (the border-on path keeps its legacy border-only behavior).
  if (!logoOverlay && !drawBorder) {
    return {
      buffer: assetBuffer,
      applied: false,
      reason: 'framed_without_logo',
      borderHex,
      fallbackBorderUsed,
    };
  }

  type CompositeInputs = Parameters<ReturnType<typeof sharp>['composite']>[0];
  const composites: CompositeInputs = [];
  if (drawBorder) {
    composites.push({ input: buildBorderSvg(width, height, borderHex), top: 0, left: 0 });
  }
  if (logoOverlay) {
    const logoMeta = await sharp(logoOverlay).metadata();
    const logoWidth = logoMeta.width ?? Math.round(width * LOGO_RELATIVE_WIDTH);
    const logoHeight = logoMeta.height ?? logoWidth;
    const left = Math.max(0, width - logoWidth - LOGO_MARGIN_PX);
    const top = Math.max(0, height - logoHeight - LOGO_MARGIN_PX);

    // Feathered scrim only when the patch under the logo is bright enough to
    // swallow the light mark.
    const luma = await meanLumaUnderBox(
      assetBuffer,
      { left, top, width: logoWidth, height: logoHeight },
      width,
      height,
    );
    if (luma !== null && luma > SCRIM_LUMA_THRESHOLD) {
      const scrimW = Math.min(width, logoWidth + SCRIM_PAD_PX * 2);
      const scrimH = Math.min(height, logoHeight + SCRIM_PAD_PX * 2);
      const scrimLeft = Math.max(0, left - SCRIM_PAD_PX);
      const scrimTop = Math.max(0, top - SCRIM_PAD_PX);
      try {
        const scrim = await sharp(buildScrimSvg(scrimW, scrimH))
          .blur(SCRIM_BLUR_SIGMA)
          .png()
          .toBuffer();
        // Push the scrim BEFORE the logo so the logo renders on top of it.
        composites.push({ input: scrim, top: scrimTop, left: scrimLeft });
      } catch {
        // Scrim is a legibility nicety; never fail the frame on its account.
      }
    }
    composites.push({ input: logoOverlay, top, left });
  }

  const buffer = await sharp(assetBuffer, { failOn: 'none' })
    .composite(composites)
    .png()
    .toBuffer();

  return {
    buffer,
    applied: true,
    reason: logoOverlay ? 'framed_with_logo' : 'framed_without_logo',
    borderHex,
    fallbackBorderUsed,
  };
}
