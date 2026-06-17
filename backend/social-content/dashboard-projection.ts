import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  MarketingDashboardAsset,
  MarketingDashboardCalendarEvent,
  MarketingDashboardPost,
  MarketingDashboardSocialContentJob,
  MarketingDashboardSocialContentJobCompatibilityStatus,
  MarketingDashboardSocialContentJobContent,
  MarketingDashboardItemStatus,
  MarketingDashboardPublishItem,
} from '@/backend/marketing/dashboard-content';
import { availableHermesMediaUrl } from '@/backend/marketing/hermes-media-presence';
import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';
import { redactTokenLikeString } from '@/backend/social-content/payload';
import { sanitizeServedAssetRef } from '@/validators/creative-memory';
import {
  parseSocialContentWorkflowOutput,
  readSocialContentRuntimeState,
  type SocialContentWorkflowProjection,
} from '@/backend/social-content/runtime-state';
import { socialCopyArtifactPath } from '@/backend/social-content/social-copy-store';

const STATUS_KEYS: MarketingDashboardItemStatus[] = [
  'draft',
  'in_review',
  'ready',
  'ready_to_publish',
  'published_to_meta_paused',
  'scheduled',
  'live',
];
const DASHBOARD_REDACTED_VALUE = '[redacted]';
const DASHBOARD_SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|clientSecret|api[_-]?key|apiKey|access[_-]?key|accessKey|AWSAccessKeyId|authorization|password|passwd|token|signature|sig|secret|key)\b\s*[:=]\s*(Bearer\s+)?[^\s&;,'"<>]+/gi;

type UnknownRecord = Record<string, unknown>;

type SocialImageCreative = SocialContentWorkflowProjection['weekly_content_plan']['image_creatives'][number];
type SocialVideoScript = SocialContentWorkflowProjection['weekly_content_plan']['video_scripts'][number];
type SocialWeeklyPost = SocialContentWorkflowProjection['weekly_content_plan']['posts'][number];
type SocialCopyProjection = {
  caption: string | null;
  hashtags: string[];
  cta: string | null;
  copyWarnings: string[];
};

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function recordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is UnknownRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const redacted = redactTokenLikeString(value).replace(
      DASHBOARD_SENSITIVE_ASSIGNMENT_PATTERN,
      (_match, key: string) => `${key}=${DASHBOARD_REDACTED_VALUE}`,
    );
    return redacted.trim() || fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function rawStringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTenantId(doc: SocialContentJobRuntimeDocument, value: string): boolean {
  const tenantId = typeof doc.tenant_id === 'string' ? doc.tenant_id.trim() : '';
  return tenantId.length > 0 && value.includes(tenantId);
}

function tenantSafeString(doc: SocialContentJobRuntimeDocument, value: unknown, fallback = ''): string {
  const tenantId = typeof doc.tenant_id === 'string' ? doc.tenant_id.trim() : '';
  const redacted = stringValue(value, fallback);
  if (!tenantId) return redacted;
  return redacted.replace(new RegExp(escapeRegExp(tenantId), 'g'), 'tenant');
}

function publicId(doc: SocialContentJobRuntimeDocument, value: unknown, fallback: string): string {
  const raw = stringValue(value);
  if (!raw) return fallback;
  if (containsTenantId(doc, raw)) {
    return `${fallback}-${safeHash(doc.job_id, raw).slice(0, 8)}`;
  }
  return raw;
}

function safeDashboardUrl(doc: SocialContentJobRuntimeDocument, value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw) {
    try {
      const rawUrl = new URL(raw);
      if (hasSensitiveQueryParams(rawUrl)) return null;
    } catch {
      return null;
    }
  }
  const redacted = stringValue(value);
  if (!redacted || containsTenantId(doc, redacted)) return null;
  try {
    const url = new URL(redacted);
    if (isPublicHttpUrl(url)) return url.toString();
  } catch {
    return null;
  }
  return null;
}

function safeImagePreviewUrl(doc: SocialContentJobRuntimeDocument, value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw) {
    try {
      const rawUrl = new URL(raw);
      if (hasSensitiveQueryParams(rawUrl)) return null;
    } catch {
      return null;
    }
  }
  const redacted = stringValue(value);
  if (!redacted || containsTenantId(doc, redacted)) return null;
  try {
    const url = new URL(redacted);
    if (isPublicHttpUrl(url)) return url.toString();
  } catch {
    return null;
  }
  return null;
}

function marketingJobAssetBasePath(doc: SocialContentJobRuntimeDocument): string {
  return `/api/marketing/jobs/${encodeURIComponent(doc.job_id)}/assets/`;
}

function safeMarketingJobAssetUrl(doc: SocialContentJobRuntimeDocument, value: unknown): string | null {
  const ref = sanitizeServedAssetRef(value);
  if (!ref) return null;
  return ref.startsWith(marketingJobAssetBasePath(doc)) ? ref : null;
}

function safeVideoPreviewUrl(doc: SocialContentJobRuntimeDocument, value: unknown): string | null {
  const servedAssetUrl = safeMarketingJobAssetUrl(doc, value);
  if (servedAssetUrl) return servedAssetUrl;

  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw) {
    try {
      const rawUrl = new URL(raw);
      if (hasSensitiveQueryParams(rawUrl)) return null;
    } catch {
      return null;
    }
  }

  const redacted = stringValue(value);
  if (!redacted || containsTenantId(doc, redacted)) return null;
  try {
    const url = new URL(redacted);
    if (isPublicHttpUrl(url)) return url.toString();
  } catch {
    return null;
  }
  return null;
}

function contentTypeForPreviewUrl(previewUrl: string): string {
  const dataMatch = previewUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if (dataMatch) return dataMatch[1].toLowerCase();
  return 'image/png';
}

function hasSensitiveQueryParams(url: URL): boolean {
  for (const key of Array.from(url.searchParams.keys())) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const compact = key.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (
      normalized.includes('token') ||
      normalized.includes('secret') ||
      normalized.includes('password') ||
      normalized.includes('passwd') ||
      normalized.includes('signature') ||
      normalized.includes('credential') ||
      normalized.includes('authorization') ||
      normalized === 'sig' ||
      normalized === 'key' ||
      normalized === 'api_key' ||
      normalized.endsWith('_key') ||
      normalized.includes('policy') ||
      compact.includes('apikey') ||
      compact.includes('accesskey') ||
      compact.includes('awsaccesskeyid')
    ) {
      return true;
    }
  }
  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPublicHttpUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (hostname.includes(':')) return false;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
  if (isPrivateIpv4(hostname)) return false;
  if (hasSensitiveQueryParams(url)) return false;
  return true;
}

function tenantSafeDashboardValue<T>(doc: SocialContentJobRuntimeDocument, value: T): T {
  if (typeof value === 'string') return tenantSafeString(doc, value) as T;
  if (Array.isArray(value)) return value.map((entry) => tenantSafeDashboardValue(doc, entry)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, tenantSafeDashboardValue(doc, entry)]),
    ) as T;
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => redactTokenLikeString(entry).trim())
    .filter(Boolean);
}

function uniqueIds(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function rawTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function rawTrimmedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function socialCopyForPostId(jobId: string): Map<string, SocialCopyProjection> {
  const filePath = socialCopyArtifactPath(jobId);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return new Map();
    }
    console.warn('[social-copy-projection] failed to read social-copy artifact', {
      jobId,
      filePath,
      code: 'social_copy_artifact_read_error',
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }

  try {
    const parsed = recordValue(JSON.parse(raw));
    const posts = Array.isArray(parsed?.posts) ? parsed.posts : [];
    const byId = new Map<string, SocialCopyProjection>();

    for (const entry of posts) {
      const record = recordValue(entry);
      const id = rawTrimmedString(record?.id);
      if (!id) continue;

      byId.set(id, {
        caption: rawTrimmedString(record?.caption),
        hashtags: rawTrimmedStringArray(record?.hashtags),
        cta: rawTrimmedString(record?.cta),
        copyWarnings: rawTrimmedStringArray(record?.warnings),
      });
    }

    return byId;
  } catch (error) {
    console.warn('[social-copy-projection] failed to parse social-copy artifact', {
      jobId,
      filePath,
      code: 'social_copy_artifact_invalid_json',
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

function normalizedSocialPostId(post: SocialWeeklyPost, index: number): string {
  const record = post as unknown as UnknownRecord;
  return firstRawStringValue([
    record.id,
    record.post_id,
    record.postId,
    post.creative_brief_id,
    `social-post-${index + 1}`,
  ]);
}

function requestedJobTypeFromDoc(doc: SocialContentJobRuntimeDocument): string {
  const request = recordValue(doc.inputs?.request);
  return stringValue(request?.jobType || request?.job_type || 'weekly_social_content').toLowerCase();
}

function latestSocialProjection(runtimeDoc: SocialContentJobRuntimeDocument): SocialContentWorkflowProjection | null {
  const runtime = readSocialContentRuntimeState(runtimeDoc);

  let summary = '';
  let windowDays: number | null = null;
  let posts: SocialContentWorkflowProjection['weekly_content_plan']['posts'] = [];
  let imageCreatives: SocialContentWorkflowProjection['weekly_content_plan']['image_creatives'] = [];
  let videoScripts: SocialContentWorkflowProjection['weekly_content_plan']['video_scripts'] = [];

  if (runtime) {
    for (const stage of runtime.stageOrder) {
      const projection = parseSocialContentWorkflowOutput(runtime.stages[stage]?.output);
      if (!projection) continue;
      const plan = projection.weekly_content_plan;
      if (projection.summary) summary = projection.summary;
      if (plan.window_days !== null) windowDays = plan.window_days;
      if (plan.posts.length > 0) posts = plan.posts;
      if (plan.image_creatives.length > 0) imageCreatives = plan.image_creatives;
      if (plan.video_scripts.length > 0) videoScripts = plan.video_scripts;
    }
  }

  // Fallback: when the social-content runtime stage outputs miss the bridged
  // image_creatives — which happens when auto-approve fires and the next
  // callback overwrites the social-content stage output with a resume-context
  // payload instead of the production result — pull from the marketing-side
  // stage records. The bridge writes its canonicalized output into
  // doc.stages[stage].primary_output via markStageCompleted, so that's a
  // durable secondary source. Fill only fields the runtime didn't supply,
  // preserving the runtime as primary.
  const marketingStageOrder = Array.isArray(runtimeDoc.stage_order) ? runtimeDoc.stage_order : [];
  for (const marketingStage of marketingStageOrder) {
    const stageRecord = runtimeDoc.stages?.[marketingStage];
    if (!stageRecord) continue;
    const projection = parseSocialContentWorkflowOutput(stageRecord.primary_output);
    if (!projection) continue;
    const plan = projection.weekly_content_plan;
    if (!summary && projection.summary) summary = projection.summary;
    if (windowDays === null && plan.window_days !== null) windowDays = plan.window_days;
    if (posts.length === 0 && plan.posts.length > 0) posts = plan.posts;
    if (imageCreatives.length === 0 && plan.image_creatives.length > 0) imageCreatives = plan.image_creatives;
    if (videoScripts.length === 0 && plan.video_scripts.length > 0) videoScripts = plan.video_scripts;
  }

  const hasProjection = windowDays !== null || posts.length > 0 || imageCreatives.length > 0 || videoScripts.length > 0;
  if (!hasProjection) return null;
  return {
    summary,
    weekly_content_plan: {
      window_days: windowDays,
      posts,
      image_creatives: imageCreatives,
      video_scripts: videoScripts,
    },
  };
}

function safeHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function publicCampaignId(jobId: string): string {
  return `social-${safeHash(jobId).slice(0, 12)}`;
}

function safeHexColor(value: string, fallback: string): string {
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized) || /^#[0-9a-f]{3}$/i.test(normalized)) return normalized;
  return fallback;
}

function brandPalette(doc: SocialContentJobRuntimeDocument): { primary: string; secondary: string; accent: string } {
  const colors = recordValue(doc.brand_kit?.colors);
  const palette = stringArray(colors?.palette);
  const primary = safeHexColor(tenantSafeString(doc, colors?.primary) || palette[0] || '', '#14151f');
  const secondary = safeHexColor(tenantSafeString(doc, colors?.secondary) || palette[1] || '', '#f3c969');
  const accent = safeHexColor(tenantSafeString(doc, colors?.accent) || palette[2] || '', '#f8f4ea');
  return { primary, secondary, accent };
}

function brandName(doc: SocialContentJobRuntimeDocument): string {
  const request = recordValue(doc.inputs?.request);
  return (
    tenantSafeString(doc, request?.businessName) ||
    tenantSafeString(doc, request?.brandName) ||
    tenantSafeString(doc, doc.brand_kit?.brand_name) ||
    'Weekly social content'
  );
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shortText(value: string, maxLength: number): string {
  const normalized = redactTokenLikeString(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function socialPreviewDataUri(input: {
  doc: SocialContentJobRuntimeDocument;
  creative: SocialImageCreative;
  index: number;
  brand: string;
}): string {
  const palette = brandPalette(input.doc);
  const hash = safeHash(input.doc.tenant_id, input.doc.job_id, input.creative.id, input.creative.title, input.creative.prompt);
  const seedA = Number.parseInt(hash.slice(0, 2), 16);
  const seedB = Number.parseInt(hash.slice(2, 4), 16);
  const seedC = Number.parseInt(hash.slice(4, 6), 16);
  const title = escapeSvgText(shortText(tenantSafeString(input.doc, input.creative.title, `Image creative ${input.index + 1}`), 42));
  const prompt = escapeSvgText(shortText(tenantSafeString(input.doc, input.creative.prompt), 86));
  const brand = escapeSvgText(shortText(input.brand, 36));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${escapeSvgText(palette.primary)}"/>
      <stop offset="0.58" stop-color="${escapeSvgText(palette.secondary)}"/>
      <stop offset="1" stop-color="${escapeSvgText(palette.accent)}"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="1200" height="1500" fill="url(#bg)"/>
  <circle cx="${190 + seedA}" cy="${230 + seedB}" r="${150 + (seedC % 90)}" fill="rgba(255,255,255,0.24)" filter="url(#soft)"/>
  <circle cx="${830 + (seedB % 160)}" cy="${390 + (seedA % 130)}" r="${120 + (seedA % 80)}" fill="rgba(0,0,0,0.18)" filter="url(#soft)"/>
  <path d="M80 ${930 + (seedB % 130)} C 300 ${760 + (seedC % 160)}, 520 ${1120 - (seedA % 150)}, 1120 ${830 + (seedA % 120)}" stroke="rgba(255,255,255,0.52)" stroke-width="28" fill="none" stroke-linecap="round"/>
  <rect x="86" y="96" width="1028" height="1308" rx="78" fill="rgba(8,10,18,0.30)" stroke="rgba(255,255,255,0.28)" stroke-width="2"/>
  <text x="132" y="180" fill="rgba(255,255,255,0.72)" font-family="Inter, Arial, sans-serif" font-size="34" letter-spacing="8">${brand}</text>
  <text x="132" y="1030" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="82" font-weight="800">${title}</text>
  <foreignObject x="132" y="1088" width="900" height="190">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Inter, Arial, sans-serif; color: rgba(255,255,255,0.82); font-size: 38px; line-height: 1.22;">${prompt}</div>
  </foreignObject>
  <text x="132" y="1328" fill="rgba(255,255,255,0.64)" font-family="Inter, Arial, sans-serif" font-size="28">Unique weekly social content preview ${input.index + 1}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function platformLabel(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'meta') return 'Meta';
  if (normalized === 'instagram') return 'Instagram';
  if (normalized === 'linkedin') return 'LinkedIn';
  if (normalized === 'tiktok') return 'TikTok';
  if (normalized === 'youtube') return 'YouTube';
  if (normalized === 'x') return 'X';
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Social';
}

function normalizeDashboardStatus(value: string, fallback: MarketingDashboardItemStatus): MarketingDashboardItemStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'published' || normalized === 'live') return 'live';
  if (normalized === 'scheduled') return 'scheduled';
  if (normalized === 'approved' || normalized === 'ready' || normalized === 'generated') return 'ready';
  if (normalized === 'needs_review' || normalized === 'in_review') return 'in_review';
  if (normalized === 'ready_to_publish') return 'ready_to_publish';
  if (normalized === 'draft') return 'draft';
  return fallback;
}

function dayIndex(day: string, fallback: number, windowDays: number): number {
  const label = day.trim().match(/^day\s*(\d+)$/i) ?? day.trim().match(/^(\d+)$/);
  if (label) {
    const parsed = Number.parseInt(label[1], 10);
    if (Number.isFinite(parsed)) return Math.min(windowDays, Math.max(1, parsed));
  }
  return Math.min(windowDays, Math.max(1, fallback));
}

function startsAt(doc: SocialContentJobRuntimeDocument, day: number): string {
  const parsed = Date.parse(doc.created_at);
  const source = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  const start = Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate());
  return new Date(start + (day - 1) * 24 * 60 * 60 * 1000).toISOString();
}

function provenance(sourceStage: 'runtime' | 'strategy' | 'production' | 'publish') {
  return {
    sourceKind: 'creative_output' as const,
    sourceStage,
    sourceRunId: null,
    isDerivedSchedule: true,
    isPlatformNative: false,
  };
}

function emptyCounts(): Record<MarketingDashboardItemStatus, number> {
  return Object.fromEntries(STATUS_KEYS.map((key) => [key, 0])) as Record<MarketingDashboardItemStatus, number>;
}

function recountStatuses(input: {
  posts: MarketingDashboardPost[];
  publishItems: MarketingDashboardPublishItem[];
}): Record<MarketingDashboardItemStatus, number> {
  const counts = emptyCounts();
  for (const item of [...input.posts, ...input.publishItems]) {
    counts[item.status] += 1;
  }
  return counts;
}

function compatibilityStatusFor(status: MarketingDashboardItemStatus): MarketingDashboardSocialContentJobCompatibilityStatus {
  if (status === 'live') return 'live';
  if (status === 'scheduled') return 'scheduled';
  if (status === 'published_to_meta_paused' || status === 'ready_to_publish' || status === 'ready') return 'approved';
  if (status === 'in_review') return 'in_review';
  return 'draft';
}

function aggregateCampaignStatus(input: {
  posts: MarketingDashboardPost[];
  publishItems: MarketingDashboardPublishItem[];
}): MarketingDashboardItemStatus {
  const items = [...input.publishItems, ...input.posts];
  if (items.some((item) => item.status === 'live')) return 'live';
  if (items.some((item) => item.status === 'scheduled')) return 'scheduled';
  if (items.some((item) => item.status === 'published_to_meta_paused')) return 'published_to_meta_paused';
  if (items.some((item) => item.status === 'ready_to_publish')) return 'ready_to_publish';
  if (items.some((item) => item.status === 'ready')) return 'ready';
  if (items.some((item) => item.status === 'in_review')) return 'in_review';
  return 'draft';
}

function mergeById<T extends { id: string }>(existing: T[], additions: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of additions) byId.set(item.id, item);
  return Array.from(byId.values());
}

function attachPostRelationsToAssets(posts: MarketingDashboardPost[], assets: MarketingDashboardAsset[]): MarketingDashboardAsset[] {
  const relatedPostIdsByAssetId = new Map<string, Set<string>>();

  for (const post of posts) {
    for (const assetId of post.relatedAssetIds) {
      const assetPostIds = relatedPostIdsByAssetId.get(assetId) ?? new Set<string>();
      assetPostIds.add(post.id);
      relatedPostIdsByAssetId.set(assetId, assetPostIds);
    }
  }

  return assets.map((asset) => ({
    ...asset,
    relatedPostIds: Array.from(new Set([
      ...asset.relatedPostIds,
      ...Array.from(relatedPostIdsByAssetId.get(asset.id) ?? []),
    ])),
  }));
}

function imageAssetId(doc: SocialContentJobRuntimeDocument, creative: SocialImageCreative, index: number): string {
  return publicId(doc, creative.id, `social-image-${index + 1}`);
}

function videoScriptAssetId(doc: SocialContentJobRuntimeDocument, script: SocialVideoScript, index: number): string {
  return publicId(doc, script.id, `social-video-script-${index + 1}`);
}

function firstStringValue(values: unknown[]): string {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstRawStringValue(values: unknown[]): string {
  for (const value of values) {
    const normalized = rawStringValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function createRenderedVideoAssets(input: {
  doc: SocialContentJobRuntimeDocument;
  postId: string;
  postName: string;
  objective: string;
}): MarketingDashboardAsset[] {
  const runtime = readSocialContentRuntimeState(input.doc);
  const directArtifacts = runtime?.stages.video_render?.artifacts ?? [];
  const metadataArtifacts = recordArray(runtime?.stages.video_render?.output?.artifacts);
  const byId = new Map<
    string,
    { artifactId: string; title: string; status: string; summary: string | null; url: string | null; metadata: UnknownRecord }
  >();

  for (const artifact of directArtifacts) {
    byId.set(artifact.id, {
      artifactId: artifact.id,
      title: artifact.title,
      status: artifact.status,
      summary: artifact.summary,
      url: artifact.url,
      metadata: recordValue(artifact.metadata) ?? {},
    });
  }

  for (const artifact of metadataArtifacts) {
    const artifactId = firstStringValue([artifact.id, artifact.asset_id, artifact.family_id, artifact.familyId]) || `video-render-${byId.size + 1}`;
    const existing = byId.get(artifactId);
    const metadata = recordValue(artifact.metadata) ?? {};
    byId.set(artifactId, {
      artifactId,
      title: firstStringValue([existing?.title, artifact.title, artifact.family_name, artifact.familyName]),
      status: firstStringValue([existing?.status, artifact.status]) || 'ready',
      summary: firstStringValue([existing?.summary, artifact.summary]) || null,
      url: firstRawStringValue([existing?.url, artifact.url, artifact.video_url, artifact.videoUrl]) || null,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...metadata,
        ...artifact,
      },
    });
  }

  return Array.from(byId.values()).flatMap((artifact, index) => {
    const metadata = artifact.metadata;
    const previewUrl = safeVideoPreviewUrl(
      input.doc,
      firstRawStringValue([
        artifact.url,
        metadata.url,
        metadata.video_url,
        metadata.videoUrl,
        metadata.preview_url,
        metadata.previewUrl,
        metadata.servedAssetRef,
      ]),
    );
    if (!previewUrl) return [];

    const thumbnailUrl = safeVideoPreviewUrl(
      input.doc,
      firstRawStringValue([
        metadata.poster_url,
        metadata.posterUrl,
        metadata.thumbnail_url,
        metadata.thumbnailUrl,
        metadata.thumbnail_path,
        metadata.thumbnailPath,
        metadata.poster_path,
        metadata.posterPath,
      ]),
    );
    const platform = firstStringValue([metadata.platform_slug, metadata.platformSlug, metadata.platform]) || 'social';
    const familyLabel = tenantSafeString(
      input.doc,
      firstStringValue([metadata.family_name, metadata.familyName, metadata.family_id, metadata.familyId]),
    );
    const aspectRatio = tenantSafeString(input.doc, firstStringValue([metadata.aspect_ratio, metadata.aspectRatio]));
    const durationSeconds = tenantSafeString(
      input.doc,
      firstStringValue([metadata.duration_seconds, metadata.durationSeconds]),
    );
    const title =
      tenantSafeString(input.doc, artifact.title) ||
      tenantSafeString(input.doc, firstStringValue([metadata.title, metadata.family_name, metadata.familyName])) ||
      `${platformLabel(platform)} rendered video ${index + 1}`;
    const detailSummary = [familyLabel, aspectRatio, durationSeconds ? `${durationSeconds}s` : ''].filter(Boolean).join(' · ');

    return [{
      id: publicId(input.doc, artifact.artifactId, `social-video-render-${index + 1}`),
      postId: input.postId,
      jobId: input.doc.job_id,
      type: 'video_ad',
      title,
      summary: tenantSafeString(input.doc, artifact.summary) || detailSummary || title,
      platform,
      platformLabel: platformLabel(platform),
      postName: input.postName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: safeDashboardUrl(input.doc, input.doc.inputs?.brand_url),
      previewUrl,
      thumbnailUrl,
      contentType: 'video/mp4',
      status: normalizeDashboardStatus(artifact.status, 'ready'),
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      relatedPostIds: [],
      relatedPublishItemIds: [],
      provenance: provenance('production'),
    } satisfies MarketingDashboardAsset];
  });
}

function createAssets(input: {
  doc: SocialContentJobRuntimeDocument;
  projection: SocialContentWorkflowProjection;
  postId: string;
  postName: string;
  objective: string;
}): MarketingDashboardAsset[] {
  const imageAssets = input.projection.weekly_content_plan.image_creatives.map((creative, index) => {
    const id = imageAssetId(input.doc, creative, index);
    const title = tenantSafeString(input.doc, creative.title) || `Weekly image creative ${index + 1}`;
    // availableHermesMediaUrl nulls an `artifact_url` whose Hermes-cache file has
    // been evicted (qa-defect #599) so the placeholder data-URI fallback fires
    // instead of a dead `<img src>` → 404. Pure pass-through for live media.
    const previewUrl = availableHermesMediaUrl(safeImagePreviewUrl(input.doc, creative.artifact_url)) || socialPreviewDataUri({
      doc: input.doc,
      creative,
      index,
      brand: input.postName,
    });
    return {
      id,
      postId: input.postId,
      jobId: input.doc.job_id,
      type: 'image_ad',
      title,
      summary: tenantSafeString(input.doc, creative.prompt) || title,
      platform: 'social',
      platformLabel: 'Social content',
      postName: input.postName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: safeDashboardUrl(input.doc, input.doc.inputs?.brand_url),
      previewUrl,
      thumbnailUrl: previewUrl,
      contentType: contentTypeForPreviewUrl(previewUrl),
      status: normalizeDashboardStatus(creative.status, 'in_review'),
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      relatedPostIds: [],
      relatedPublishItemIds: [],
      provenance: provenance('production'),
    } satisfies MarketingDashboardAsset;
  });

  const scriptAssets = input.projection.weekly_content_plan.video_scripts.map((script, index) => {
    const id = videoScriptAssetId(input.doc, script, index);
    const title = tenantSafeString(input.doc, script.title) || `Weekly video script ${index + 1}`;
    const duration = script.duration_seconds ? `${script.duration_seconds}s` : 'Short-form';
    return {
      id,
      postId: input.postId,
      jobId: input.doc.job_id,
      type: 'script',
      title,
      summary: tenantSafeString(input.doc, script.script_markdown) || `${duration} weekly social video script ready for review.`,
      platform: 'social',
      platformLabel: 'Social content',
      postName: input.postName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: safeDashboardUrl(input.doc, input.doc.inputs?.brand_url),
      previewUrl: null,
      thumbnailUrl: null,
      contentType: 'text/markdown',
      status: normalizeDashboardStatus(script.status, 'in_review'),
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      relatedPostIds: [],
      relatedPublishItemIds: [],
      provenance: provenance('production'),
    } satisfies MarketingDashboardAsset;
  });

  const renderedVideoAssets = createRenderedVideoAssets(input);

  return [...imageAssets, ...scriptAssets, ...renderedVideoAssets];
}

function resolvePostAssetId(doc: SocialContentJobRuntimeDocument, post: SocialWeeklyPost, assets: MarketingDashboardAsset[], index: number): string | null {
  const previewAssets = assets.filter((asset) => asset.type === 'image_ad' && Boolean(asset.previewUrl || asset.thumbnailUrl));
  const preferred = publicId(doc, post.creative_brief_id, `social-image-${index + 1}`);
  if (preferred && previewAssets.some((asset) => asset.id === preferred)) return preferred;
  return previewAssets[index % Math.max(1, previewAssets.length)]?.id ?? null;
}

function createPosts(input: {
  doc: SocialContentJobRuntimeDocument;
  projection: SocialContentWorkflowProjection;
  assets: MarketingDashboardAsset[];
  postId: string;
  postName: string;
  objective: string;
  socialCopyByPostId: Map<string, SocialCopyProjection>;
}): MarketingDashboardPost[] {
  return input.projection.weekly_content_plan.posts.map((post, index) => {
    const platform = (post.platforms.find(Boolean) || 'meta').toLowerCase();
    const previewAssetId = resolvePostAssetId(input.doc, post, input.assets, index);
    const socialCopy = input.socialCopyByPostId.get(normalizedSocialPostId(post, index));
    // Use the planner-assigned post.id when present so social-copy can match by
    // it (normalizedSocialPostId returns the same value) and so asset reverse
    // links via attachPostRelationsToAssets carry the real id forward to
    // dashboard.assets[].relatedPostIds. Falls back to the synthetic
    // social-post-N for legacy plans that omit id.
    const postId = post.id || `social-post-${index + 1}`;
    return {
      id: postId,
      postId: input.postId,
      jobId: input.doc.job_id,
      type: 'platform_post',
      title: tenantSafeString(input.doc, post.title) || `Weekly social post ${index + 1}`,
      summary: tenantSafeString(input.doc, post.caption) || tenantSafeString(input.doc, post.post_type) || 'Weekly social post ready for review.',
      caption: socialCopy?.caption ? tenantSafeString(input.doc, socialCopy.caption) : null,
      hashtags: socialCopy?.hashtags.map((hashtag) => tenantSafeString(input.doc, hashtag)) ?? [],
      cta: socialCopy?.cta ? tenantSafeString(input.doc, socialCopy.cta) : null,
      copyWarnings: socialCopy?.copyWarnings.map((warning) => tenantSafeString(input.doc, warning)) ?? [],
      platform,
      platformLabel: platformLabel(platform),
      postName: input.postName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: safeDashboardUrl(input.doc, input.doc.inputs?.brand_url),
      previewAssetId,
      status: normalizeDashboardStatus(post.status, 'in_review'),
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      conceptId: previewAssetId,
      relatedAssetIds: previewAssetId ? [previewAssetId] : [],
      relatedPublishItemIds: [],
      provenance: provenance('production'),
    } satisfies MarketingDashboardPost;
  });
}

function createPublishItems(input: {
  doc: SocialContentJobRuntimeDocument;
  posts: MarketingDashboardPost[];
  postId: string;
  postName: string;
  objective: string;
  includePublishQueue: boolean;
  realPublishedPostCount: number;
}): MarketingDashboardPublishItem[] {
  // The real publish artifact is a DB `posts` row, synthesized on the
  // publish-completed callback (`synthesizePublishPostsFromContentPackage`).
  // When those rows exist, the campaign HAS published items regardless of the
  // legacy `includePublishQueue` runtime-state gate — which keyed off
  // legacy state that the Hermes pipeline does not always set.
  const hasRealPosts = input.realPublishedPostCount > 0;
  if (!input.includePublishQueue && !hasRealPosts) return [];

  const items = input.posts.map((post, index) => ({
    id: `social-publish-${index + 1}`,
    postId: input.postId,
    jobId: input.doc.job_id,
    type: post.status === 'live' ? 'live_post' : post.status === 'scheduled' ? 'scheduled_post' : 'publish_package',
    title: post.title,
    summary: `Ready to publish on ${post.platformLabel}.`,
    platform: post.platform,
    platformLabel: post.platformLabel,
    postName: input.postName,
    funnelStage: 'weekly_content',
    objective: input.objective,
    destinationUrl: post.destinationUrl,
    previewAssetId: post.previewAssetId,
    status: post.status === 'live' ? 'live' : post.status === 'scheduled' ? 'scheduled' : 'ready_to_publish',
    createdAt: input.doc.updated_at || input.doc.created_at || null,
    relatedAssetIds: post.relatedAssetIds,
    relatedPostIds: [post.id],
    provenance: provenance('publish'),
  } satisfies MarketingDashboardPublishItem));

  // The projection's `weekly_content_plan.posts` can be sparser than the real
  // synthesized `posts` rows (a completed pipeline may have a stale/empty
  // projection while the DB holds the published reality). Pad the publish
  // queue so the counter reflects the actual DB row count.
  for (let index = items.length; index < input.realPublishedPostCount; index += 1) {
    items.push({
      id: `social-publish-${index + 1}`,
      postId: input.postId,
      jobId: input.doc.job_id,
      type: 'publish_package',
      title: `Published social post ${index + 1}`,
      summary: 'Published social post.',
      platform: 'social',
      platformLabel: 'Social content',
      postName: input.postName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: safeDashboardUrl(input.doc, input.doc.inputs?.brand_url),
      previewAssetId: null,
      status: 'ready_to_publish',
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      relatedAssetIds: [],
      relatedPostIds: [],
      provenance: provenance('publish'),
    } satisfies MarketingDashboardPublishItem);
  }
  return items;
}

function createCalendarEvents(input: {
  doc: SocialContentJobRuntimeDocument;
  projection: SocialContentWorkflowProjection;
  posts: MarketingDashboardPost[];
  postId: string;
  postName: string;
  objective: string;
}): MarketingDashboardCalendarEvent[] {
  const windowDays = Math.max(1, input.projection.weekly_content_plan.window_days ?? 7);
  return input.projection.weekly_content_plan.posts.map((post, index) => {
    const linkedPost = input.posts[index];
    const day = dayIndex(post.day, index + 1, windowDays);
    return {
      id: `social-calendar-${index + 1}`,
      postId: input.postId,
      jobId: input.doc.job_id,
      title: linkedPost?.title || `Weekly social post ${index + 1}`,
      platform: linkedPost?.platform || 'meta',
      platformLabel: linkedPost?.platformLabel || 'Meta',
      startsAt: startsAt(input.doc, day),
      endsAt: null,
      status: linkedPost?.status || 'in_review',
      statusLabel: linkedPost?.status || 'in_review',
      postName: input.postName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: linkedPost?.destinationUrl || safeDashboardUrl(input.doc, input.doc.inputs?.brand_url),
      previewAssetId: linkedPost?.previewAssetId || null,
      sourcePostId: linkedPost?.id || null,
      sourcePublishItemId: null,
      provenance: provenance('runtime'),
    } satisfies MarketingDashboardCalendarEvent;
  });
}

function createCampaign(input: {
  doc: SocialContentJobRuntimeDocument;
  dashboard: MarketingDashboardSocialContentJobContent;
  postId: string;
  postName: string;
  objective: string;
  posts: MarketingDashboardPost[];
  assets: MarketingDashboardAsset[];
  publishItems: MarketingDashboardPublishItem[];
  calendarEvents: MarketingDashboardCalendarEvent[];
}): MarketingDashboardSocialContentJob | null {
  const existing = input.dashboard.post;
  const statusCounts = recountStatuses({ posts: input.posts, publishItems: input.publishItems });
  const postStatus = aggregateCampaignStatus({ posts: input.posts, publishItems: input.publishItems });
  const counts = {
    posts: input.posts.length,
    landingPages: existing?.counts.landingPages ?? 0,
    imageAds: input.assets.filter((asset) => asset.type === 'image_ad').length,
    videoAds: input.assets.filter((asset) => asset.type === 'video_ad').length,
    scripts: input.assets.filter((asset) => asset.type === 'script').length,
    publishItems: input.publishItems.length,
    proposalConcepts: existing?.counts.proposalConcepts ?? 0,
    ready: statusCounts.ready,
    readyToPublish: statusCounts.ready_to_publish,
    pausedMetaAds: statusCounts.published_to_meta_paused,
    scheduled: statusCounts.scheduled,
    live: statusCounts.live,
  };
  return {
    id: input.postId,
    jobId: input.doc.job_id,
    externalPostId: existing?.externalPostId && !containsTenantId(input.doc, existing.externalPostId) ? existing.externalPostId : input.postId,
    name: input.postName,
    objective: input.objective,
    funnelStage: 'weekly_content',
    summary: `${input.posts.length} weekly posts with ${counts.imageAds} image previews and ${counts.videoAds} rendered videos.`,
    stageLabel: 'Weekly social content',
    status: postStatus,
    compatibilityStatus: compatibilityStatusFor(postStatus),
    postWindow: existing?.postWindow ?? null,
    updatedAt: input.doc.updated_at || input.doc.created_at || null,
    approvalRequired: existing?.approvalRequired ?? false,
    approvalActionHref: existing?.approvalActionHref,
    previewPostIds: input.posts.slice(0, 4).map((post) => post.id),
    previewAssetIds: input.assets.slice(0, 4).map((asset) => asset.id),
    postIds: input.posts.map((post) => post.id),
    assetIds: input.assets.map((asset) => asset.id),
    publishItemIds: input.publishItems.map((item) => item.id),
    calendarEventIds: input.calendarEvents.map((event) => event.id),
    counts,
    provenance: provenance('runtime'),
  } satisfies MarketingDashboardSocialContentJob;
}

export function buildSocialContentDashboardProjection(
  runtimeDoc: SocialContentJobRuntimeDocument,
  dashboard: MarketingDashboardSocialContentJobContent,
  options: { realPublishedPostCount?: number } = {},
): MarketingDashboardSocialContentJobContent {
  // One-off campaigns ride the same social-content Hermes pipeline per design
  // premise P3, so this projection layer must surface them too. The earlier
  // gate accepted only weekly, which silently emptied the dashboard for any
  // one_off campaign and left aggregate routes stuck on "Loading…".
  const reqJobType = requestedJobTypeFromDoc(runtimeDoc);
  if (reqJobType !== 'weekly_social_content' && reqJobType !== 'one_off_post' && reqJobType !== 'one_off_campaign') {
    return dashboard;
  }
  const realPublishedPostCount =
    typeof options.realPublishedPostCount === 'number' && options.realPublishedPostCount > 0
      ? options.realPublishedPostCount
      : 0;
  const projection = latestSocialProjection(runtimeDoc);
  if (!projection) {
    return dashboard;
  }

  const runtime = readSocialContentRuntimeState(runtimeDoc);
  const existingCampaignId = dashboard.post?.id || '';
  const postId = existingCampaignId && !containsTenantId(runtimeDoc, existingCampaignId) ? existingCampaignId : publicCampaignId(runtimeDoc.job_id);
  const postName = tenantSafeString(runtimeDoc, dashboard.post?.name) || brandName(runtimeDoc);
  const request = recordValue(runtimeDoc.inputs?.request);
  const objective =
    tenantSafeString(runtimeDoc, dashboard.post?.objective) ||
    tenantSafeString(runtimeDoc, request?.primaryGoal) ||
    tenantSafeString(runtimeDoc, request?.goal) ||
    'Weekly social content';

  const assets = createAssets({ doc: runtimeDoc, projection, postId, postName, objective });
  const socialCopyByPostId = socialCopyForPostId(runtimeDoc.job_id);
  const posts = createPosts({
    doc: runtimeDoc,
    projection,
    assets,
    postId,
    postName,
    objective,
    socialCopyByPostId,
  });
  const includePublishQueue = runtime?.publishingRequested === true || runtime?.currentStage === 'publish_review' || runtime?.currentStage === 'completed';
  const publishItems = createPublishItems({
    doc: runtimeDoc,
    posts,
    postId,
    postName,
    objective,
    includePublishQueue,
    realPublishedPostCount,
  });
  const calendarEvents = createCalendarEvents({ doc: runtimeDoc, projection, posts, postId, postName, objective });

  const mergedAssets = attachPostRelationsToAssets(posts, mergeById(dashboard.assets, assets));
  const mergedPosts = mergeById(dashboard.posts, posts);
  const mergedPublishItems = mergeById(dashboard.publishItems, publishItems);
  const mergedCalendarEvents = mergeById(dashboard.calendarEvents, calendarEvents);
  const socialContentJob = createCampaign({
    doc: runtimeDoc,
    dashboard,
    postId,
    postName,
    objective,
    posts: mergedPosts,
    assets: mergedAssets,
    publishItems: mergedPublishItems,
    calendarEvents: mergedCalendarEvents,
  });

  return tenantSafeDashboardValue(runtimeDoc, {
    post: socialContentJob,
    posts: mergedPosts,
    assets: mergedAssets,
    publishItems: mergedPublishItems,
    calendarEvents: mergedCalendarEvents,
    statuses: {
      countsByStatus: recountStatuses({
        posts: mergedPosts,
        publishItems: mergedPublishItems,
      }),
    },
  });
}
