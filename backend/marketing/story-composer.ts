/**
 * Story image composer.
 *
 * WHY THIS EXISTS: Instagram/Facebook STORY publishing via the Meta Graph API
 * accepts ONLY an image (the feed caption is ignored, and the API supports no
 * text/link stickers). So a published story is whatever is *in the pixels*. A
 * raw feed creative posted as a story therefore shows up with no words and no
 * call-to-action. This module composites the post's headline + a brand CTA URL
 * onto a 9:16 (1080×1920) story canvas so published stories carry context and
 * drive to the site.
 *
 * The composed image is persisted as a `creative_assets` row
 * (`storage_kind='ingested_asset'`) written under `DATA_ROOT/ingested-assets`,
 * exactly like an operator upload, so it is servable through the authoritative
 * id route (`/api/internal/hermes/media/<id>`) and fetchable by Meta once signed
 * by the dispatch path — no new serving route required.
 *
 * Pure composition (`composeStoryImage`) is separated from persistence
 * (`persistComposedStoryAsset`) so the layout logic is unit-testable without a
 * DB or filesystem.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import sharp from 'sharp';

export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

// DejaVu Sans (Book + Bold) ships in the runtime container's fontconfig set, so
// sharp's SVG text renderer resolves it. Keep this family in sync with the
// container's installed fonts (see DOCKER.md); a missing family renders blank.
const FONT_FAMILY = 'DejaVu Sans';
// Conservative average glyph advance as a fraction of font-size for DejaVu Sans
// Bold. Used only to size text so it never overflows — erring wide is safe
// (slightly smaller text), erring narrow clips, so this is intentionally high.
const BOLD_ADVANCE = 0.62;

const SIDE_MARGIN = 64;
const HEADLINE_MAX_CHARS = 140; // hard cap; longer hooks are truncated with an ellipsis.

const FALLBACK_CTA = 'aries.sugarandleather.com';
const FALLBACK_PRIMARY_HEX = '#0f172a'; // slate-900
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Word-wrap to at most `maxChars` per line. A single word longer than maxChars
 * is hard-split so it can never overflow the canvas.
 */
export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > maxChars) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * The CTA text to render on the story. Derives the bare host from APP_BASE_URL
 * (e.g. "https://aries.sugarandleather.com" -> "aries.sugarandleather.com") and
 * falls back to the canonical Aries host. NEVER returns a bare
 * "sugarandleather.com" — that is the wrong (leather-goods) site.
 */
export function resolveStoryCtaText(appBaseUrl: string | undefined = process.env.APP_BASE_URL): string {
  const raw = (appBaseUrl ?? '').trim();
  if (raw) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
      if (host && host !== 'sugarandleather.com') return host;
    } catch {
      /* fall through to the canonical fallback */
    }
  }
  return FALLBACK_CTA;
}

function resolvePrimaryHex(hex: string | null | undefined): string {
  const trimmed = (hex ?? '').trim();
  return HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : FALLBACK_PRIMARY_HEX;
}

export interface ComposeStoryImageInput {
  /** The base creative bytes (any sharp-decodable image). */
  baseImageBytes: Buffer;
  /** Headline copy (typically the post hook). Truncated to a sane length. */
  headline: string;
  /** CTA text, usually a bare host like "aries.sugarandleather.com". */
  ctaText: string;
  /** Brand primary color (hex) for the CTA pill; falls back to slate-900. */
  brandPrimaryHex?: string | null;
}

/**
 * Compose a 1080×1920 story image: a darkened, blurred full-bleed background
 * derived from the creative, the creative contained in the upper region, a
 * bottom scrim, the wrapped headline, and a CTA pill carrying the brand host.
 * Throws if the base image cannot be decoded — callers should fall back to the
 * raw creative so a publish is never blocked by a composition failure.
 */
export async function composeStoryImage(input: ComposeStoryImageInput): Promise<Buffer> {
  const baseMeta = await sharp(input.baseImageBytes, { failOn: 'none' }).metadata();
  if (!baseMeta.width || !baseMeta.height) {
    throw new Error('story_composer_undecodable_base_image');
  }

  // Darkened, blurred full-bleed background so the 9:16 canvas is filled even
  // when the creative is 4:5/1:1 (avoids letterbox bars).
  const background = await sharp(input.baseImageBytes, { failOn: 'none' })
    .resize(STORY_WIDTH, STORY_HEIGHT, { fit: 'cover' })
    .blur(40)
    .modulate({ brightness: 0.5 })
    .toBuffer();

  // Foreground creative, contained in the upper ~60% so the lower third is free
  // for copy. withoutEnlargement:false lets small creatives scale up to fill.
  const fgMaxHeight = Math.round(STORY_HEIGHT * 0.6);
  const foreground = await sharp(input.baseImageBytes, { failOn: 'none' })
    .resize(STORY_WIDTH - 2 * SIDE_MARGIN, fgMaxHeight, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  const fgMeta = await sharp(foreground).metadata();
  const fgWidth = fgMeta.width ?? STORY_WIDTH - 2 * SIDE_MARGIN;
  const fgHeight = fgMeta.height ?? fgMaxHeight;
  const fgLeft = Math.max(0, Math.round((STORY_WIDTH - fgWidth) / 2));
  const fgTop = Math.round(STORY_HEIGHT * 0.09);

  // Headline: truncate, size by length, wrap to fit the canvas width.
  let headline = input.headline.trim().replace(/\s+/g, ' ');
  if (headline.length > HEADLINE_MAX_CHARS) {
    headline = `${headline.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
  }
  const headlineFont = headline.length <= 42 ? 76 : headline.length <= 80 ? 64 : 54;
  const headlineLineHeight = Math.round(headlineFont * 1.22);
  const maxHeadlineChars = Math.max(
    8,
    Math.floor((STORY_WIDTH - 2 * SIDE_MARGIN) / (headlineFont * BOLD_ADVANCE)),
  );
  const headlineLines = headline ? wrapText(headline, maxHeadlineChars) : [];

  // CTA: auto-size the font so the host always fits within the pill within the
  // side margins — this is what prevents the URL clipping seen in v1.
  const cta = input.ctaText.trim() || FALLBACK_CTA;
  const pillPadX = 40;
  const ctaMaxTextWidth = STORY_WIDTH - 2 * SIDE_MARGIN - 2 * pillPadX;
  let ctaFont = 46;
  const ctaFitFont = Math.floor(ctaMaxTextWidth / (Math.max(cta.length, 1) * BOLD_ADVANCE));
  if (ctaFitFont < ctaFont) ctaFont = Math.max(26, ctaFitFont);
  const ctaTextWidth = Math.ceil(cta.length * ctaFont * BOLD_ADVANCE);
  const pillWidth = Math.min(STORY_WIDTH - 2 * SIDE_MARGIN, ctaTextWidth + 2 * pillPadX);
  const pillHeight = Math.round(ctaFont * 1.9);

  // Vertical layout for the text block, anchored from the bottom up.
  const bottomMargin = 96;
  const pillTop = STORY_HEIGHT - bottomMargin - pillHeight;
  const headlineBlockHeight = headlineLines.length * headlineLineHeight;
  const headlineBaselineTop = pillTop - 56 - headlineBlockHeight + headlineFont; // first baseline

  const primaryHex = resolvePrimaryHex(input.brandPrimaryHex);
  const scrimTop = Math.round(STORY_HEIGHT * 0.5);

  const headlineSvg = headlineLines
    .map(
      (line, i) =>
        `<text x="${SIDE_MARGIN}" y="${headlineBaselineTop + i * headlineLineHeight}" font-family="${FONT_FAMILY}" font-weight="bold" font-size="${headlineFont}" fill="#ffffff">${escapeXml(line)}</text>`,
    )
    .join('');

  const ctaBaseline = pillTop + Math.round(pillHeight / 2) + Math.round(ctaFont * 0.36);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STORY_WIDTH}" height="${STORY_HEIGHT}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${scrimTop}" width="${STORY_WIDTH}" height="${STORY_HEIGHT - scrimTop}" fill="url(#scrim)"/>
  ${headlineSvg}
  <rect x="${SIDE_MARGIN}" y="${pillTop}" width="${pillWidth}" height="${pillHeight}" rx="${Math.round(pillHeight / 2)}" fill="${primaryHex}"/>
  <text x="${SIDE_MARGIN + pillPadX}" y="${ctaBaseline}" font-family="${FONT_FAMILY}" font-weight="bold" font-size="${ctaFont}" fill="#ffffff">${escapeXml(cta)}</text>
</svg>`;

  return sharp(background)
    .composite([
      { input: foreground, top: fgTop, left: fgLeft },
      { input: Buffer.from(svg, 'utf8'), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

// --- Persistence -----------------------------------------------------------

export type ComposerDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

// Mirrors upload-replace.ts: ingested_asset bytes live under
// DATA_ROOT/ingested-assets/<tenant>/<sha[:2]>/<sha>.png and are served by the
// id route. source_type='runtime_artifact' (an Aries-derived asset, NOT a base
// 'generated_by_aries' creative — keeps it out of the base-creative lookup in
// synthesize-publish-posts.ts), permission_scope='generated'.
const INSERT_COMPOSED_ASSET_SQL = `
  WITH ins AS (
    INSERT INTO creative_assets (
      tenant_id, source_type, permission_scope, media_type,
      storage_kind, storage_key, checksum, aspect_ratio,
      learning_lifecycle, usable_for_generation
    ) VALUES (
      $1, 'runtime_artifact', 'generated', 'image',
      'ingested_asset', $2, $3, '9:16',
      'observed', FALSE
    )
    RETURNING id
  )
  UPDATE creative_assets
     SET served_asset_ref = '/api/internal/hermes/media/' || ins.id::text
    FROM ins
   WHERE creative_assets.id = ins.id
  RETURNING creative_assets.id
`;

export interface PersistComposedStoryAssetInput {
  db: ComposerDb;
  tenantId: number;
  bytes: Buffer;
  dataRoot?: string;
  /** Test seam: override the byte writer. */
  writeBytes?: (absPath: string, bytes: Buffer) => Promise<void>;
}

/**
 * Write the composed PNG under DATA_ROOT/ingested-assets and insert a
 * `creative_assets` row pointing at it. Returns the new asset id (a uuid string)
 * to use as the story post's `creative_asset_ids`.
 */
export async function persistComposedStoryAsset(
  input: PersistComposedStoryAssetInput,
): Promise<string> {
  const sha = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const dataRoot = input.dataRoot ?? process.env.DATA_ROOT ?? '/data';
  const storageKey = path.join(
    dataRoot,
    'ingested-assets',
    String(input.tenantId),
    sha.slice(0, 2),
    `${sha}.png`,
  );

  const writer =
    input.writeBytes ??
    (async (absPath: string, bytes: Buffer) => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, bytes);
    });
  await writer(storageKey, input.bytes);

  const result = await input.db.query(INSERT_COMPOSED_ASSET_SQL, [input.tenantId, storageKey, sha]);
  const row = (result.rows ?? [])[0] as { id?: unknown } | undefined;
  const id = row?.id != null ? String(row.id) : '';
  if (!id) throw new Error('story_composer_insert_returned_no_id');
  return id;
}

// --- Production composer (resolve base bytes -> compose -> persist) ---------

const SELECT_BASE_CREATIVE_SQL = `
  SELECT storage_kind, storage_key, served_asset_ref
    FROM creative_assets
   WHERE tenant_id = $1
     AND orphaned_at IS NULL
     AND (id::text = $2 OR (source_asset_id = $2 AND source_job_id = $3))
   ORDER BY (id::text = $2) DESC
   LIMIT 1
`;

export interface ComposeStoryAssetForBaseInput {
  db: ComposerDb;
  tenantId: number;
  jobId: string;
  /** The base creative's uuid id OR Hermes source_asset_id (e.g. 'img_1'). */
  baseAssetId: string;
  headline: string;
  ctaText?: string;
  brandPrimaryHex?: string | null;
  dataRoot?: string;
  /** Test seam: resolve an on-disk path to bytes. */
  readBytes?: (absPath: string) => Promise<Buffer>;
  writeBytes?: (absPath: string, bytes: Buffer) => Promise<void>;
}

/**
 * Resolve a base creative's bytes, compose a story image with the headline +
 * CTA, persist it, and return the composed asset id. Returns `null` on ANY
 * failure (unresolvable base, external_url base, decode/compose error) so the
 * caller falls back to the raw creative and a publish is never blocked.
 *
 * runtime_asset bytes live under the read-only Hermes mount
 * (HERMES_IMAGE_CACHE_MOUNT/<basename>); ingested_asset bytes under DATA_ROOT.
 * external_url assets are skipped (no local bytes to compose from).
 */
export async function composeStoryAssetForBaseCreative(
  input: ComposeStoryAssetForBaseInput,
): Promise<string | null> {
  try {
    const res = await input.db.query(SELECT_BASE_CREATIVE_SQL, [
      input.tenantId,
      input.baseAssetId,
      input.jobId,
    ]);
    const row = (res.rows ?? [])[0] as
      | { storage_kind?: unknown; storage_key?: unknown; served_asset_ref?: unknown }
      | undefined;
    if (!row) return null;
    const storageKind = typeof row.storage_kind === 'string' ? row.storage_kind : '';
    const storageKey = typeof row.storage_key === 'string' ? row.storage_key : '';
    if (!storageKey) return null;

    let basePath: string | null = null;
    if (storageKind === 'runtime_asset') {
      const mount = (process.env.HERMES_IMAGE_CACHE_MOUNT || '').trim();
      if (!mount) return null;
      basePath = path.join(mount, path.basename(storageKey));
    } else if (storageKind === 'ingested_asset') {
      basePath = storageKey;
    } else {
      // external_url / none: no local bytes to compose from.
      return null;
    }

    const reader =
      input.readBytes ??
      (async (absPath: string) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(absPath);
      });
    const baseBytes = await reader(basePath);
    if (!baseBytes || baseBytes.length === 0) return null;

    const composed = await composeStoryImage({
      baseImageBytes: baseBytes,
      headline: input.headline,
      ctaText: input.ctaText ?? resolveStoryCtaText(),
      brandPrimaryHex: input.brandPrimaryHex ?? null,
    });

    return await persistComposedStoryAsset({
      db: input.db,
      tenantId: input.tenantId,
      bytes: composed,
      dataRoot: input.dataRoot,
      writeBytes: input.writeBytes,
    });
  } catch {
    // Never block a publish on composition failure — fall back to raw creative.
    return null;
  }
}
