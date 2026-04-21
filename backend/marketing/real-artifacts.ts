import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { resolveCodePath, resolveCodeRoot, resolveDataRoot } from '@/lib/runtime-paths';

import type { MarketingJobRuntimeDocument } from './runtime-state';

export const ARTIFACT_UNAVAILABLE_TEXT = 'Unavailable: not present in generated artifacts.';
export const ARTIFACT_INCOMPLETE_TEXT = 'Incomplete: generated artifacts do not yet contain this section.';

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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

function slugify(value: string, fallback = 'campaign'): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function trustedRoots(): string[] {
  return uniqueStrings([
    resolveDataRoot(),
    resolveCodeRoot(),
    process.env.OPENCLAW_LOCAL_LOBSTER_CWD,
    process.env.OPENCLAW_LOBSTER_CWD,
    resolveCodePath('lobster'),
    process.env.LOBSTER_STAGE1_CACHE_DIR,
    process.env.LOBSTER_STAGE2_CACHE_DIR,
    process.env.LOBSTER_STAGE3_CACHE_DIR,
    process.env.LOBSTER_STAGE4_CACHE_DIR,
  ]).map((root) => path.normalize(root));
}

export function lobsterRoots(): string[] {
  return uniqueStrings([
    process.env.OPENCLAW_LOCAL_LOBSTER_CWD,
    process.env.OPENCLAW_LOBSTER_CWD,
    resolveCodePath('lobster'),
  ]).map((root) => path.normalize(root));
}

export function lobsterOutputRoots(): string[] {
  // In the aries-app container the host's lobster/output dir is bind-mounted
  // read-only at ARIES_LOBSTER_HOST_OUTPUT_MOUNT. Include it here so directory
  // scans (landing-pages, ad-images, scripts, proposals) find the real files
  // written by the host-side Lobster pipeline. Without this, campaignRootForBrand
  // falls back to a path that only exists on the host, listFiles returns empty,
  // and the dashboard shows zero creative assets even though the pipeline ran.
  const hostMount = process.env.ARIES_LOBSTER_HOST_OUTPUT_MOUNT?.trim();
  return uniqueStrings([
    ...lobsterRoots().map((root) => path.join(root, 'output')),
    hostMount ? path.normalize(hostMount) : null,
  ]);
}

function absoluteCompatibilityCandidates(filePath: string): string[] {
  const normalized = path.normalize(filePath);
  const codeRoot = path.normalize(resolveCodeRoot());
  const candidates = new Set([normalized]);
  const remapPrefixes = [
    '/home/node/workspace/aries-app',
    '/app/aries-app',
    path.join(codeRoot, 'aries-app'),
  ].map((prefix) => path.normalize(prefix));

  for (const prefix of remapPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}${path.sep}`)) {
      const suffix = normalized.slice(prefix.length).replace(/^[\\/]+/, '');
      candidates.add(path.join(codeRoot, suffix));
      for (const lobsterRoot of lobsterRoots()) {
        if (suffix === 'lobster' || suffix.startsWith(`lobster${path.sep}`)) {
          candidates.add(path.join(lobsterRoot, suffix.replace(/^lobster[\\/]+/, '')));
        }
      }
    }
  }

  return Array.from(candidates);
}

export function resolveMarketingArtifactPath(filePath: string | null | undefined): string | null {
  const raw = stringValue(filePath);
  if (!raw) {
    return null;
  }

  if (path.isAbsolute(raw)) {
    for (const candidate of absoluteCompatibilityCandidates(raw)) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  for (const root of trustedRoots()) {
    const candidate = path.resolve(root, raw);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function readMarketingArtifactText(filePath: string | null | undefined): string | null {
  const resolvedPath = resolveMarketingArtifactPath(filePath);
  if (!resolvedPath) {
    return null;
  }

  try {
    const text = readFileSync(resolvedPath, 'utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function readMarketingArtifactJson(filePath: string | null | undefined): Record<string, unknown> | null {
  const resolvedPath = resolveMarketingArtifactPath(filePath);
  if (!resolvedPath) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]?);/gi, (match, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
      hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
      lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
      bull: '\u2022', middot: '\u00b7',
    };
    return named[lower] !== undefined ? named[lower] : match;
  });
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

export function isLowSignalGeneratedText(value: string | null | undefined): boolean {
  const normalized = stringValue(value).toLowerCase();
  return (
    !normalized ||
    normalized === 'n/a' ||
    normalized === 'no details yet.' ||
    /^(hook|opening line|problem|proof|cta|headline|summary|body)\s*:?\s*$/.test(normalized) ||
    /^(problem|proof|hook|opening line|headline|summary|message|core message|deliver proof|body)\s*:\s*(based on the provided brand|based on the brand identity|here is the brand strategy analysis)/.test(normalized) ||
    normalized.startsWith('based on the provided brand') ||
    normalized.startsWith('based on the brand identity') ||
    normalized.startsWith('here is the brand strategy analysis') ||
    normalized.includes('here is a concise strategy analysis') ||
    normalized.includes('here is the concise brand strategy')
  );
}

export function normalizeArtifactText(value: string | null | undefined): string | null {
  const normalized = stringValue(value);
  if (!normalized || isLowSignalGeneratedText(normalized)) {
    return null;
  }
  return stripCliIdioms(normalized);
}

// CLI-facing instructions occasionally leak from workflow scripts into fields
// that surface directly in the approval UI (approval_message, summary,
// core_message). The most recent offender was
//   "Reply with approval and rerun with launch_approved=true to generate ..."
// — a developer instruction aimed at whoever was invoking the lobster pipeline
// on the command line, which rendered verbatim inside the cyan approval card.
// This helper is a defense-in-depth pass: producers (e.g. lobster/bin/*) are
// the primary fix, but we also scrub the rendered text so a future regression
// elsewhere can't leak the same pattern to end users.
// Order matters: rewrite whole CLI-instruction sentences BEFORE stripping the
// inner flag tokens, otherwise the outer sentence-level pattern no longer
// matches once the flag token is gone and we're left with grammatically
// broken halves like "Reply with approval and to generate publish-ready assets."
const CLI_IDIOM_REWRITES: Array<[RegExp, string]> = [
  // "Reply/Respond with approval and (re-run|rerun|retry|invoke|restart) ..."
  // sentence — strip the whole sentence up to the next period, because the
  // trailing clause ("to generate publish-ready assets") is still CLI guidance
  // even after the flag name is scrubbed.
  [/\s*(?:reply|respond)\s+with\s+approval\s+and\s+(?:re[- ]?run|rerun|retry|invoke|restart)\b[^.]*\.?\s*/gi, ' '],
  // Standalone "rerun with foo_bar=true/false ..." sentence (no "reply with
  // approval and" preamble), also up to the next period.
  [/\s*(?:re[- ]?run|rerun|retry|invoke|restart)\s+with\s+[a-z0-9_-]+\s*=\s*(?:true|false)\b[^.]*\.?\s*/gi, ' '],
  // Bare `flag=true` / `flag=false` tokens left behind after the rewrites above
  // or appearing standalone in other fields.
  [/\b[a-z][a-z0-9_-]*\s*=\s*(?:true|false)\b/gi, ''],
  // Long-form CLI flags that shouldn't appear in UI copy.
  [/\s--[a-z][a-z0-9-]*(?:=[^\s.,;]+)?/gi, ''],
];

function stripCliIdioms(value: string): string {
  let result = value;
  for (const [pattern, replacement] of CLI_IDIOM_REWRITES) {
    result = result.replace(pattern, replacement);
  }
  // Collapse any double-spaces / leftover punctuation introduced by rewrites.
  return result.replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export function explicitArtifactValue(value: string | null | undefined, fallback = ARTIFACT_UNAVAILABLE_TEXT): string {
  return normalizeArtifactText(value) || fallback;
}

export function inferBrandSlug(runtimeDoc: MarketingJobRuntimeDocument): string {
  const runtimeInputs = runtimeDoc.inputs as Record<string, unknown>;
  const runtimeRequest = recordValue(runtimeInputs.request);
  const candidateUrl =
    stringValue(runtimeDoc.brand_kit?.canonical_url) ||
    stringValue(runtimeDoc.brand_kit?.source_url) ||
    stringValue(runtimeDoc.inputs.brand_url);

  const explicitBrandSlug =
    stringValue(runtimeRequest?.brandSlug) ||
    stringValue(runtimeRequest?.brand_slug) ||
    stringValue(runtimeInputs.brandSlug) ||
    stringValue(runtimeInputs.brand_slug);
  if (explicitBrandSlug) {
    return slugify(explicitBrandSlug, 'campaign');
  }

  if (candidateUrl) {
    try {
      return slugify(new URL(candidateUrl).hostname.replace(/^www\./, ''), slugify(runtimeDoc.tenant_id, 'campaign'));
    } catch {}
  }

  return slugify(
    stringValue(runtimeInputs.brand_slug) || stringValue(runtimeDoc.tenant_id) || stringValue(runtimeDoc.brand_kit?.brand_name),
    'campaign',
  );
}

export function campaignRootForBrand(brandSlug: string): string | null {
  for (const outputRoot of lobsterOutputRoots()) {
    const candidate = path.join(outputRoot, `${brandSlug}-campaign`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return lobsterOutputRoots()[0] ? path.join(lobsterOutputRoots()[0], `${brandSlug}-campaign`) : null;
}

function firstReadablePath(paths: Array<string | null | undefined>): string | null {
  for (const candidate of paths) {
    const resolved = resolveMarketingArtifactPath(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function firstFileMatching(dirPath: string | null, matcher: (fileName: string) => boolean): string | null {
  const resolvedDir = resolveMarketingArtifactPath(dirPath);
  if (!resolvedDir || !existsSync(resolvedDir)) {
    return null;
  }

  try {
    const fileName = readdirSync(resolvedDir)
      .filter((entry) => matcher(entry))
      .sort()[0];
    return fileName ? path.join(resolvedDir, fileName) : null;
  } catch {
    return null;
  }
}

function extractTagTexts(html: string, tagName: string): string[] {
  const matcher = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const results: string[] = [];
  let next = matcher.exec(html);
  while (next) {
    const text = stripHtml(next[1] || '');
    if (text) {
      results.push(text);
    }
    next = matcher.exec(html);
  }
  return results;
}

function firstAnchorText(html: string): { text: string | null; href: string | null } {
  const match = html.match(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
  if (!match) {
    return { text: null, href: null };
  }
  return {
    text: stripHtml(match[3] || '') || null,
    href: stringValue(match[2]) || null,
  };
}

export type LandingPageArtifactDetails = {
  path: string | null;
  headline: string | null;
  subheadline: string | null;
  cta: string | null;
  slug: string | null;
  sections: string[];
};

export function readLandingPageArtifactDetails(input: {
  path?: string | null;
  runtimeDoc?: MarketingJobRuntimeDocument | null;
  brandSlug?: string | null;
}): LandingPageArtifactDetails {
  const brandSlug = stringValue(input.brandSlug) || (input.runtimeDoc ? inferBrandSlug(input.runtimeDoc) : '');
  const campaignRoot = brandSlug ? campaignRootForBrand(brandSlug) : null;
  const resolvedPath = firstReadablePath([
    input.path,
    firstFileMatching(campaignRoot ? path.join(campaignRoot, 'landing-pages') : null, (fileName) => fileName.endsWith('.html')),
  ]);
  const html = readMarketingArtifactText(resolvedPath);
  if (!html) {
    return {
      path: resolvedPath,
      headline: null,
      subheadline: null,
      cta: null,
      slug: null,
      sections: [],
    };
  }

  const headings = extractTagTexts(html, 'h1');
  const paragraphs = extractTagTexts(html, 'p');
  const sectionTitles = [...extractTagTexts(html, 'h2'), ...extractTagTexts(html, 'h3')];
  const anchor = firstAnchorText(html);
  const slug = (() => {
    if (anchor.href && anchor.href !== '#' && !anchor.href.startsWith('#')) {
      return anchor.href;
    }
    if (!resolvedPath) {
      return null;
    }
    const baseName = path.basename(resolvedPath).toLowerCase();
    return baseName === 'index.html' ? '/' : baseName;
  })();

  return {
    path: resolvedPath,
    headline: normalizeArtifactText(headings[0]),
    subheadline: normalizeArtifactText(paragraphs[0]),
    cta: normalizeArtifactText(anchor.text),
    slug,
    sections: sectionTitles.map((title) => title.trim()).filter(Boolean),
  };
}

function extractMarkdownSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im'));
  return match?.[1]?.trim() || null;
}

function cleanMarkdownLines(value: string | null | undefined): string[] {
  return stringValue(value)
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^#+\s*/, '').trim())
    .filter(Boolean);
}

function scriptPaths(brandSlug: string): { metaScriptPath: string | null; shortVideoPath: string | null } {
  const campaignRoot = campaignRootForBrand(brandSlug);
  return {
    metaScriptPath: firstFileMatching(
      campaignRoot ? path.join(campaignRoot, 'scripts') : null,
      (fileName) => /meta/i.test(fileName) && /\.(md|txt|json)$/i.test(fileName),
    ),
    shortVideoPath: firstFileMatching(
      campaignRoot ? path.join(campaignRoot, 'scripts') : null,
      (fileName) => /(video|reel|short)/i.test(fileName) && /\.(md|txt|json)$/i.test(fileName),
    ),
  };
}

export type ScriptArtifactDetails = {
  metaScriptPath: string | null;
  metaAdHook: string | null;
  metaAdBody: string[];
  shortVideoScriptPath: string | null;
  shortVideoOpeningLine: string | null;
  shortVideoBeats: string[];
};

export function readScriptArtifactDetails(input: {
  metaScriptPath?: string | null;
  shortVideoScriptPath?: string | null;
  runtimeDoc?: MarketingJobRuntimeDocument | null;
  brandSlug?: string | null;
}): ScriptArtifactDetails {
  const brandSlug = stringValue(input.brandSlug) || (input.runtimeDoc ? inferBrandSlug(input.runtimeDoc) : '');
  const fallbackPaths = brandSlug ? scriptPaths(brandSlug) : { metaScriptPath: null, shortVideoPath: null };
  const metaScriptPath = firstReadablePath([input.metaScriptPath, fallbackPaths.metaScriptPath]);
  const shortVideoScriptPath = firstReadablePath([input.shortVideoScriptPath, fallbackPaths.shortVideoPath]);
  const metaText = readMarketingArtifactText(metaScriptPath);
  const videoText = readMarketingArtifactText(shortVideoScriptPath);
  const metaJson = readMarketingArtifactJson(metaScriptPath);
  const videoJson = readMarketingArtifactJson(shortVideoScriptPath);

  const metaAdHook =
    normalizeArtifactText(stringValue(metaJson?.hook || metaJson?.headline)) ||
    normalizeArtifactText(cleanMarkdownLines(extractMarkdownSection(metaText || '', 'Hook'))[0]);
  const metaAdBodyFromJson = stringArray(metaJson?.body_lines)
    .map((line) => stringValue(line))
    .filter(Boolean)
    .filter((line) => !isLowSignalGeneratedText(line));
  const metaAdBodyFromMarkdown = cleanMarkdownLines(extractMarkdownSection(metaText || '', 'Body')).filter(
    (line) => !isLowSignalGeneratedText(line),
  );
  const metaAdBody = metaAdBodyFromJson.length > 0 ? metaAdBodyFromJson : metaAdBodyFromMarkdown;
  const shortVideoOpeningLine =
    normalizeArtifactText(stringValue(videoJson?.opening_line || videoJson?.headline || videoJson?.hook)) ||
    normalizeArtifactText(cleanMarkdownLines(extractMarkdownSection(videoText || '', 'Opening Line'))[0]);
  const shortVideoBeatsFromJson = stringArray(videoJson?.beats)
    .map((line) => stringValue(line))
    .filter(Boolean)
    .filter((line) => !isLowSignalGeneratedText(line));
  const shortVideoBeatsFromMarkdown = cleanMarkdownLines(extractMarkdownSection(videoText || '', 'Beats')).filter(
    (line) => !isLowSignalGeneratedText(line),
  );
  const shortVideoBeats =
    shortVideoBeatsFromJson.length > 0 ? shortVideoBeatsFromJson : shortVideoBeatsFromMarkdown;

  return {
    metaScriptPath,
    metaAdHook,
    metaAdBody: metaAdBody.length > 0 ? metaAdBody : [],
    shortVideoScriptPath,
    shortVideoOpeningLine,
    shortVideoBeats: shortVideoBeats.length > 0 ? shortVideoBeats : [],
  };
}

export type PublishCopyDetails = {
  path: string | null;
  headline: string | null;
  bodyLines: string[];
  cta: string | null;
  proofPoints: string[];
};

export function readPublishCopyDetails(filePath: string | null | undefined): PublishCopyDetails {
  const resolvedPath = resolveMarketingArtifactPath(filePath);
  const payload = readMarketingArtifactJson(resolvedPath);
  if (payload) {
    return {
      path: resolvedPath,
      headline: normalizeArtifactText(stringValue(payload.headline || payload.title || payload.hook)),
      bodyLines: stringArray(payload.body_lines).filter((line) => !isLowSignalGeneratedText(line)),
      cta: normalizeArtifactText(stringValue(payload.primary_cta || payload.cta)),
      proofPoints: stringArray(payload.proof_points).filter((line) => !isLowSignalGeneratedText(line)),
    };
  }

  const text = readMarketingArtifactText(resolvedPath);
  if (!text) {
    return {
      path: resolvedPath,
      headline: null,
      bodyLines: [],
      cta: null,
      proofPoints: [],
    };
  }

  const lines = text
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => !isLowSignalGeneratedText(line));

  return {
    path: resolvedPath,
    headline: normalizeArtifactText(lines[0]),
    bodyLines: lines.slice(1, 4),
    cta: null,
    proofPoints: [],
  };
}
