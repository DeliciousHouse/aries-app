import { readFile } from 'node:fs/promises';

import sharp from 'sharp';

import type {
  SocialContentImageChannel,
  SocialContentMediaPostType,
} from '@/backend/social-content/aspect-matrix';

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
}

// Border stroke: 2px is wide enough to read on a 1080×1080 IG canvas without
// crowding the bleed; matches the value the operator preview UI (T22) will
// echo back. Logo footprint targets ~12% of canvas width — visible without
// dominating composition. Margin keeps the logo off the bleed edge.
const FRAME_BORDER_PX = 2;
const LOGO_RELATIVE_WIDTH = 0.12;
const LOGO_MARGIN_PX = 24;
const FALLBACK_BORDER_HEX = '#0f172a'; // slate-900: neutral, high-contrast on most static feeds.

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

export async function applyBrandFrameDetailed(
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

  const { hex: borderHex, fallbackUsed: fallbackBorderUsed } = resolveBorderColor(brandKit);
  const borderSvg = buildBorderSvg(width, height, borderHex);

  const logoUrl = pickLogoUrl(brandKit);
  const loader = input.logoLoader ?? defaultLogoLoader;
  let logoOverlay: Buffer | null = null;
  if (logoUrl) {
    const logoBytes = await loader(logoUrl).catch(() => null);
    if (logoBytes && logoBytes.length > 0) {
      logoOverlay = await prepareLogoOverlay(logoBytes, width);
    }
  }

  const composites: sharp.OverlayOptions[] = [
    { input: borderSvg, top: 0, left: 0 },
  ];
  if (logoOverlay) {
    const logoMeta = await sharp(logoOverlay).metadata();
    const logoWidth = logoMeta.width ?? Math.round(width * LOGO_RELATIVE_WIDTH);
    const logoHeight = logoMeta.height ?? logoWidth;
    const left = Math.max(0, width - logoWidth - LOGO_MARGIN_PX);
    const top = Math.max(0, height - logoHeight - LOGO_MARGIN_PX);
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
