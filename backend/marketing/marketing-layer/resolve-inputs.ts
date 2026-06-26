/**
 * Resolve the PER-TENANT marketing-layer inputs for a reel from that tenant's
 * own content_package copy + brand kit. Never reaches across tenants: hook/value/
 * CTA come from the post, colors/logo/url from the tenant's brand kit.
 */
import { existsSync } from 'node:fs';
import type { ReelMarketingColors, ReelMarketingCopy } from './compose-reel';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** First sentence (or first ~13 words) of a body, sans trailing punctuation. */
function firstSentence(s: string, maxWords = 13): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^[^.!?]*[.!?]/);
  let out = (m ? m[0] : t).replace(/[.!?]+$/, '').trim();
  const w = out.split(' ');
  if (w.length > maxWords) out = w.slice(0, maxWords).join(' ');
  return out;
}

/**
 * A short, clean wordmark from a brand_name; empty when it's a long tagline.
 * For a tagline we return '' rather than guessing a word — the logo carries the
 * brand on the end-card, and a wrong wordmark is worse than none.
 */
function cleanBrandName(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  return s.length <= 20 && s.split(/\s+/).length <= 3 ? s : '';
}

export interface ContentPackageCopy {
  hook?: unknown;
  body?: unknown;
  cta?: unknown;
  post_number?: unknown;
}

/** Find the content_package entry for an asset by post_number/placement; else [0]. */
export function findContentPackageCopy(
  primaryOutput: unknown,
  asset: { placement?: unknown; post_number?: unknown },
): ContentPackageCopy {
  const cp = (primaryOutput as Record<string, unknown> | null)?.content_package;
  if (!Array.isArray(cp) || cp.length === 0) return {};
  const pnRaw = (asset.post_number ?? asset.placement) as unknown;
  const pn = typeof pnRaw === 'number' ? pnRaw : Number(pnRaw);
  if (Number.isFinite(pn)) {
    const match = cp.find(
      (e) => e && typeof e === 'object' && Number((e as Record<string, unknown>).post_number) === pn,
    );
    if (match) return match as ContentPackageCopy;
  }
  return (cp[0] ?? {}) as ContentPackageCopy;
}

export interface ResolvedReelInputs {
  copy: ReelMarketingCopy;
  colors: ReelMarketingColors;
  logoPath: string | null;
}

export function resolveReelMarketingInputs(args: {
  entry: ContentPackageCopy;
  brandKit?: Record<string, unknown> | null;
  fallbackLogoPath?: string | null;
  fallbackUrl?: string | null;
}): ResolvedReelInputs {
  const bk = (args.brandKit ?? {}) as Record<string, unknown>;
  const colors = (bk.colors ?? {}) as Record<string, unknown>;

  const rawUrl = str(bk.brand_url) || str(bk.website) || str(args.fallbackUrl ?? '');
  const url = rawUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  const kitLogo = str(bk.logo_file_path);
  const logoPath =
    kitLogo && existsSync(kitLogo)
      ? kitLogo
      : args.fallbackLogoPath && existsSync(args.fallbackLogoPath)
        ? args.fallbackLogoPath
        : null;

  return {
    copy: {
      hook: str(args.entry.hook),
      value: firstSentence(str(args.entry.body)),
      cta: str(args.entry.cta),
      brandName: cleanBrandName(str(bk.brand_name)),
      url,
    },
    colors: {
      primaryHex: str(colors.primary) || null,
      accentHex: str(colors.accent) || str(colors.secondary) || null,
    },
    logoPath,
  };
}
