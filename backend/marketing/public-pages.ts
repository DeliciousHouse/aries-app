import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveCodePath } from '@/lib/runtime-paths';

type PublicMarketingArtifact = {
  body: string | Buffer;
  contentType: string;
  cacheControl: string;
};

type LandingContractMatch = {
  outputRoot: string;
  slug: string;
  contract: Record<string, unknown>;
  publicBrandSlug: string;
  campaignDirectoryName: string;
};

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => stringValue(entry)).filter(Boolean)
    : [];
}

function lobsterRoots(): string[] {
  return Array.from(
    new Set(
      [
        process.env.OPENCLAW_LOCAL_LOBSTER_CWD?.trim(),
        process.env.OPENCLAW_LOBSTER_CWD?.trim(),
        resolveCodePath('lobster'),
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  ).map((root) => path.resolve(root));
}

function lobsterOutputRoots(): string[] {
  return lobsterRoots().map((root) => path.join(root, 'output'));
}

function readJsonIfExists(filePath: string | null | undefined): Record<string, unknown> | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizePublicPath(pathname: string): string | null {
  const withoutQuery = pathname.split('?')[0] || pathname;
  const segments = withoutQuery
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))) {
    return null;
  }

  return `/${segments.join('/')}`;
}

function sniffMediaContentType(filePath: string): string | null {
  try {
    const buffer = readFileSync(filePath);
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (buffer.length >= 6) {
      const signature = buffer.subarray(0, 6).toString('utf8');
      if (signature === 'GIF87a' || signature === 'GIF89a') {
        return 'image/gif';
      }
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    // ISO Base Media File Format (mp4/mov/m4v/etc.) — second 4 bytes are
    // the 'ftyp' box type. Treat any such container as video/mp4 so the
    // browser can render it inline via <video>.
    if (buffer.length >= 8 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
      return 'video/mp4';
    }
  } catch {}

  return null;
}

function fileContentType(filePath: string): string {
  // Extension-first: QuickTime .mov files also contain an `ftyp` box, so
  // sniffing first would mislabel them as video/mp4. Only fall back to
  // magic-byte sniffing when the extension is missing or unrecognized.
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.m4v':
      return 'video/x-m4v';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.ogv':
    case '.ogg':
      return 'video/ogg';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
  }

  const sniffedMediaType = sniffMediaContentType(filePath);
  if (sniffedMediaType) {
    return sniffedMediaType;
  }

  return 'application/octet-stream';
}

function existingFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return statSync(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function injectBaseHref(html: string, baseHref: string): string {
  if (/<base\s/i.test(html)) {
    return html;
  }

  const baseTag = `<base href="${escapeHtml(baseHref)}" />`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }

  return `${baseTag}${html}`;
}

function inlineDesignSystemCss(html: string, cssText: string | null): string {
  if (!cssText) {
    return html.replace(/<link[^>]+design-system\.css['"][^>]*>/i, '');
  }

  const styleTag = `<style data-aries-design-system>\n${cssText}\n</style>`;
  if (/<link[^>]+design-system\.css['"][^>]*>/i.test(html)) {
    return html.replace(/<link[^>]+design-system\.css['"][^>]*>/i, styleTag);
  }

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${styleTag}`);
  }

  return `${styleTag}${html}`;
}

function defaultPublicStyles(): string {
  return [
    'body{margin:0;padding:0;background:#0f1720;color:#f5f2eb;font-family:Georgia,"Times New Roman",serif;}',
    'main{max-width:960px;margin:0 auto;padding:48px 24px 80px;}',
    'section{margin:0 0 24px;}',
    '.card{padding:24px;border:1px solid rgba(255,255,255,.12);border-radius:20px;background:#16212c;}',
    '.eyebrow{letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:#d4a94f;font-weight:700;}',
    '.cta{display:inline-block;padding:14px 22px;background:#d4a94f;color:#111827;border-radius:999px;font-weight:700;text-decoration:none;}',
    'ul,ol{padding-left:20px;}',
  ].join('');
}

function buildFallbackLandingHtml(match: LandingContractMatch): string {
  const landingPage = recordValue(match.contract.landing_page) ?? {};
  const creative = recordValue(match.contract.creative) ?? {};
  const heroHeadline = stringValue(landingPage.hero_headline || creative.headline, 'Campaign preview');
  const heroSubheadline = stringValue(landingPage.hero_subheadline);
  const primaryCta = stringValue(landingPage.primary_cta || creative.primary_cta, 'Learn more');
  const bodyLines = stringArray(creative.body_lines);
  const proofPoints = stringArray(creative.proof_points);
  const sections = stringArray(landingPage.sections);
  const title = stringValue(match.contract.campaign_id, heroHeadline);

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${defaultPublicStyles()}</style>`,
    '</head><body><main>',
    `<section class="card"><p class="eyebrow">Public campaign preview</p><h1>${escapeHtml(heroHeadline)}</h1>`,
    heroSubheadline ? `<p>${escapeHtml(heroSubheadline)}</p>` : '',
    bodyLines.length > 0 ? `<div>${bodyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>` : '',
    `<p><a class="cta" href="#cta">${escapeHtml(primaryCta)}</a></p></section>`,
    proofPoints.length > 0
      ? `<section class="card"><h2>Proof</h2><ul>${proofPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul></section>`
      : '',
    sections.length > 0
      ? `<section class="card"><h2>Page Structure</h2><ol>${sections.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ol></section>`
      : '',
    `<section id="cta" class="card"><h2>Next Step</h2><p><a class="cta" href="#">${escapeHtml(primaryCta)}</a></p></section>`,
    '</main></body></html>',
  ].join('');
}

function transformLandingHtml(html: string, requestPath: string, designSystemCss: string | null): string {
  const baseHref = requestPath.endsWith('/') ? requestPath : `${requestPath}/`;
  return injectBaseHref(inlineDesignSystemCss(html, designSystemCss), baseHref);
}

function findLandingContractBySlug(slug: string): LandingContractMatch | null {
  for (const outputRoot of lobsterOutputRoots()) {
    const staticContractsRoot = path.join(outputRoot, 'static-contracts');
    if (!existsSync(staticContractsRoot)) {
      continue;
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(staticContractsRoot);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const contract = readJsonIfExists(path.join(staticContractsRoot, entry, 'landing-page.json'));
      if (!contract) {
        continue;
      }

      const landingPage = recordValue(contract.landing_page);
      const contractSlug = stringValue(landingPage?.slug);
      if (!contractSlug || contractSlug.replace(/\/+$/, '') !== slug.replace(/\/+$/, '')) {
        continue;
      }

      const publicBrandSlug = contractSlug.split('/').filter(Boolean)[0] || '';
      if (!publicBrandSlug.startsWith('public-')) {
        continue;
      }

      return {
        outputRoot,
        slug: contractSlug,
        contract,
        publicBrandSlug,
        campaignDirectoryName: contractSlug.replace(/^\//, '').replace(/\//g, '-'),
      };
    }
  }

  return null;
}

function directPublicArtifact(pathname: string): PublicMarketingArtifact | null {
  const normalizedPath = normalizePublicPath(pathname);
  if (!normalizedPath) {
    return null;
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const directPath = existingFile(path.join(outputRoot, ...segments));
    if (directPath) {
      return {
        body: readFileSync(directPath),
        contentType: fileContentType(directPath),
        cacheControl: 'public, max-age=300',
      };
    }
  }

  const publicBrandSlug = segments[0];
  if (!publicBrandSlug.startsWith('public-')) {
    return null;
  }

  const restSegments = segments[1] === 'campaign' ? segments.slice(2) : segments.slice(1);
  if (restSegments.length === 0) {
    return null;
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const campaignRoot = path.join(outputRoot, `${publicBrandSlug}-campaign`);
    const campaignFile = existingFile(path.join(campaignRoot, ...restSegments));
    if (campaignFile) {
      return {
        body: readFileSync(campaignFile),
        contentType: fileContentType(campaignFile),
        cacheControl: 'public, max-age=300',
      };
    }

    const landingPageFile = existingFile(path.join(campaignRoot, 'landing-pages', ...restSegments));
    if (landingPageFile) {
      return {
        body: readFileSync(landingPageFile),
        contentType: fileContentType(landingPageFile),
        cacheControl: 'public, max-age=300',
      };
    }
  }

  return null;
}

export function resolvePublicMarketingArtifact(pathname: string): PublicMarketingArtifact | null {
  const direct = directPublicArtifact(pathname);
  if (direct) {
    return direct;
  }

  const normalizedPath = normalizePublicPath(pathname);
  if (!normalizedPath) {
    return null;
  }

  const match = findLandingContractBySlug(normalizedPath);
  if (!match) {
    return null;
  }

  const htmlPath = path.join(match.outputRoot, match.campaignDirectoryName, 'landing-pages', 'index.html');
  const designSystemPath = path.join(match.outputRoot, `${match.publicBrandSlug}-design-system.css`);
  const designSystemCss = existsSync(designSystemPath) ? readFileSync(designSystemPath, 'utf8') : null;
  const body = existsSync(htmlPath)
    ? transformLandingHtml(readFileSync(htmlPath, 'utf8'), normalizedPath, designSystemCss)
    : buildFallbackLandingHtml(match);

  return {
    body,
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'public, max-age=60',
  };
}
