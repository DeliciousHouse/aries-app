import { createHash } from 'node:crypto';

import type {
  MarketingDashboardAsset,
  MarketingDashboardCalendarEvent,
  MarketingDashboardCampaign,
  MarketingDashboardCampaignContent,
  MarketingDashboardItemStatus,
  MarketingDashboardPost,
  MarketingDashboardPublishItem,
} from '@/backend/marketing/dashboard-content';
import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';
import { redactTokenLikeString } from '@/backend/social-content/payload';
import {
  parseSocialContentWorkflowOutput,
  readSocialContentRuntimeState,
  type SocialContentWorkflowProjection,
} from '@/backend/social-content/runtime-state';

const STATUS_KEYS: MarketingDashboardItemStatus[] = [
  'draft',
  'in_review',
  'ready',
  'ready_to_publish',
  'published_to_meta_paused',
  'scheduled',
  'live',
];

type UnknownRecord = Record<string, unknown>;

type SocialImageCreative = SocialContentWorkflowProjection['weekly_content_plan']['image_creatives'][number];
type SocialWeeklyPost = SocialContentWorkflowProjection['weekly_content_plan']['posts'][number];

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return redactTokenLikeString(value).trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => redactTokenLikeString(entry).trim())
    .filter(Boolean);
}

function requestedJobTypeFromDoc(doc: MarketingJobRuntimeDocument): string {
  const request = recordValue(doc.inputs?.request);
  return stringValue(request?.jobType || request?.job_type || 'brand_campaign').toLowerCase();
}

function latestSocialProjection(runtimeDoc: MarketingJobRuntimeDocument): SocialContentWorkflowProjection | null {
  const runtime = readSocialContentRuntimeState(runtimeDoc);
  if (!runtime) return null;

  let latest: SocialContentWorkflowProjection | null = null;
  for (const stage of runtime.stageOrder) {
    const projection = parseSocialContentWorkflowOutput(runtime.stages[stage]?.output);
    const plan = projection?.weekly_content_plan;
    if (
      projection &&
      plan &&
      (plan.window_days !== null || plan.posts.length > 0 || plan.image_creatives.length > 0 || plan.video_scripts.length > 0)
    ) {
      latest = projection;
    }
  }
  return latest;
}

function safeHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function publicCampaignId(jobId: string): string {
  return `social-${safeHash(jobId).slice(0, 12)}`;
}

function brandPalette(doc: MarketingJobRuntimeDocument): { primary: string; secondary: string; accent: string } {
  const colors = recordValue(doc.brand_kit?.colors);
  const palette = stringArray(colors?.palette);
  const primary = stringValue(colors?.primary) || palette[0] || '#14151f';
  const secondary = stringValue(colors?.secondary) || palette[1] || '#f3c969';
  const accent = stringValue(colors?.accent) || palette[2] || '#f8f4ea';
  return { primary, secondary, accent };
}

function brandName(doc: MarketingJobRuntimeDocument): string {
  const request = recordValue(doc.inputs?.request);
  return (
    stringValue(request?.businessName) ||
    stringValue(request?.brandName) ||
    stringValue(doc.brand_kit?.brand_name) ||
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
  doc: MarketingJobRuntimeDocument;
  creative: SocialImageCreative;
  index: number;
  brand: string;
}): string {
  const palette = brandPalette(input.doc);
  const hash = safeHash(input.doc.tenant_id, input.doc.job_id, input.creative.id, input.creative.title, input.creative.prompt);
  const seedA = Number.parseInt(hash.slice(0, 2), 16);
  const seedB = Number.parseInt(hash.slice(2, 4), 16);
  const seedC = Number.parseInt(hash.slice(4, 6), 16);
  const title = escapeSvgText(shortText(input.creative.title || `Image creative ${input.index + 1}`, 42));
  const prompt = escapeSvgText(shortText(input.creative.prompt, 86));
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

function startsAt(doc: MarketingJobRuntimeDocument, day: number): string {
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
  assets: MarketingDashboardAsset[];
  publishItems: MarketingDashboardPublishItem[];
  calendarEvents: MarketingDashboardCalendarEvent[];
}): Record<MarketingDashboardItemStatus, number> {
  const counts = emptyCounts();
  for (const item of [...input.posts, ...input.assets, ...input.publishItems, ...input.calendarEvents]) {
    counts[item.status] += 1;
  }
  return counts;
}

function mergeById<T extends { id: string }>(existing: T[], additions: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of additions) byId.set(item.id, item);
  return Array.from(byId.values());
}

function imageAssetId(creative: SocialImageCreative, index: number): string {
  return stringValue(creative.id) || `social-image-${index + 1}`;
}

function createAssets(input: {
  doc: MarketingJobRuntimeDocument;
  projection: SocialContentWorkflowProjection;
  campaignId: string;
  campaignName: string;
  objective: string;
}): MarketingDashboardAsset[] {
  return input.projection.weekly_content_plan.image_creatives.map((creative, index) => {
    const id = imageAssetId(creative, index);
    const title = stringValue(creative.title) || `Weekly image creative ${index + 1}`;
    const previewUrl = stringValue(creative.artifact_url) || socialPreviewDataUri({
      doc: input.doc,
      creative,
      index,
      brand: input.campaignName,
    });
    const generatedPreview = previewUrl.startsWith('data:image/svg+xml;base64,');
    return {
      id,
      campaignId: input.campaignId,
      jobId: input.doc.job_id,
      type: 'image_ad',
      title,
      summary: stringValue(creative.prompt) || title,
      platform: 'social',
      platformLabel: 'Social content',
      campaignName: input.campaignName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: stringValue(input.doc.inputs?.brand_url) || null,
      previewUrl,
      thumbnailUrl: previewUrl,
      contentType: generatedPreview ? 'image/svg+xml' : 'image/png',
      status: normalizeDashboardStatus(creative.status, 'in_review'),
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      relatedPostIds: [],
      relatedPublishItemIds: [],
      provenance: provenance('production'),
    } satisfies MarketingDashboardAsset;
  });
}

function resolvePostAssetId(post: SocialWeeklyPost, assets: MarketingDashboardAsset[], index: number): string | null {
  const preferred = stringValue(post.creative_brief_id);
  if (preferred && assets.some((asset) => asset.id === preferred)) return preferred;
  return assets[index % Math.max(1, assets.length)]?.id ?? null;
}

function createPosts(input: {
  doc: MarketingJobRuntimeDocument;
  projection: SocialContentWorkflowProjection;
  assets: MarketingDashboardAsset[];
  campaignId: string;
  campaignName: string;
  objective: string;
}): MarketingDashboardPost[] {
  return input.projection.weekly_content_plan.posts.map((post, index) => {
    const platform = (post.platforms.find(Boolean) || 'meta').toLowerCase();
    const previewAssetId = resolvePostAssetId(post, input.assets, index);
    return {
      id: `social-post-${index + 1}`,
      campaignId: input.campaignId,
      jobId: input.doc.job_id,
      type: 'platform_post',
      title: stringValue(post.title) || `Weekly social post ${index + 1}`,
      summary: stringValue(post.caption) || stringValue(post.post_type) || 'Weekly social post ready for review.',
      platform,
      platformLabel: platformLabel(platform),
      campaignName: input.campaignName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: stringValue(input.doc.inputs?.brand_url) || null,
      previewAssetId,
      status: normalizeDashboardStatus(post.status, 'in_review'),
      createdAt: input.doc.updated_at || input.doc.created_at || null,
      conceptId: stringValue(post.creative_brief_id) || null,
      relatedAssetIds: previewAssetId ? [previewAssetId] : [],
      relatedPublishItemIds: [],
      provenance: provenance('production'),
    } satisfies MarketingDashboardPost;
  });
}

function createPublishItems(input: {
  doc: MarketingJobRuntimeDocument;
  posts: MarketingDashboardPost[];
  campaignId: string;
  campaignName: string;
  objective: string;
  includePublishQueue: boolean;
}): MarketingDashboardPublishItem[] {
  if (!input.includePublishQueue) return [];
  return input.posts.map((post, index) => ({
    id: `social-publish-${index + 1}`,
    campaignId: input.campaignId,
    jobId: input.doc.job_id,
    type: post.status === 'live' ? 'live_post' : post.status === 'scheduled' ? 'scheduled_post' : 'publish_package',
    title: post.title,
    summary: `Ready to publish on ${post.platformLabel}.`,
    platform: post.platform,
    platformLabel: post.platformLabel,
    campaignName: input.campaignName,
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
}

function createCalendarEvents(input: {
  doc: MarketingJobRuntimeDocument;
  projection: SocialContentWorkflowProjection;
  posts: MarketingDashboardPost[];
  campaignId: string;
  campaignName: string;
  objective: string;
}): MarketingDashboardCalendarEvent[] {
  const windowDays = Math.max(1, input.projection.weekly_content_plan.window_days ?? 7);
  return input.projection.weekly_content_plan.posts.map((post, index) => {
    const linkedPost = input.posts[index];
    const day = dayIndex(post.day, index + 1, windowDays);
    return {
      id: `social-calendar-${index + 1}`,
      campaignId: input.campaignId,
      jobId: input.doc.job_id,
      title: linkedPost?.title || `Weekly social post ${index + 1}`,
      platform: linkedPost?.platform || 'meta',
      platformLabel: linkedPost?.platformLabel || 'Meta',
      startsAt: startsAt(input.doc, day),
      endsAt: null,
      status: linkedPost?.status || 'in_review',
      statusLabel: linkedPost?.status || 'in_review',
      campaignName: input.campaignName,
      funnelStage: 'weekly_content',
      objective: input.objective,
      destinationUrl: linkedPost?.destinationUrl || stringValue(input.doc.inputs?.brand_url) || null,
      previewAssetId: linkedPost?.previewAssetId || null,
      sourcePostId: linkedPost?.id || null,
      sourcePublishItemId: null,
      provenance: provenance('runtime'),
    } satisfies MarketingDashboardCalendarEvent;
  });
}

function createCampaign(input: {
  doc: MarketingJobRuntimeDocument;
  dashboard: MarketingDashboardCampaignContent;
  campaignId: string;
  campaignName: string;
  objective: string;
  posts: MarketingDashboardPost[];
  assets: MarketingDashboardAsset[];
  publishItems: MarketingDashboardPublishItem[];
  calendarEvents: MarketingDashboardCalendarEvent[];
}): MarketingDashboardCampaign | null {
  const existing = input.dashboard.campaign;
  const counts = {
    posts: input.posts.length,
    landingPages: existing?.counts.landingPages ?? 0,
    imageAds: input.assets.filter((asset) => asset.type === 'image_ad').length,
    videoAds: existing?.counts.videoAds ?? 0,
    scripts: existing?.counts.scripts ?? 0,
    publishItems: input.publishItems.length,
    proposalConcepts: existing?.counts.proposalConcepts ?? 0,
    ready: input.assets.filter((asset) => asset.status === 'ready').length + input.posts.filter((post) => post.status === 'ready').length,
    readyToPublish: input.publishItems.filter((item) => item.status === 'ready_to_publish').length,
    pausedMetaAds: existing?.counts.pausedMetaAds ?? 0,
    scheduled: input.publishItems.filter((item) => item.status === 'scheduled').length,
    live: input.publishItems.filter((item) => item.status === 'live').length,
  };
  return {
    id: existing?.id || input.campaignId,
    jobId: input.doc.job_id,
    externalCampaignId: existing?.externalCampaignId || input.campaignId,
    name: input.campaignName,
    objective: input.objective,
    funnelStage: 'weekly_content',
    summary: `${input.posts.length} weekly posts with ${input.assets.length} unique image previews.`,
    stageLabel: 'Weekly social content',
    status: input.publishItems.length > 0 ? 'ready_to_publish' : input.posts.length > 0 ? 'in_review' : 'draft',
    compatibilityStatus: input.publishItems.length > 0 ? 'approved' : 'in_review',
    campaignWindow: existing?.campaignWindow ?? null,
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
  } satisfies MarketingDashboardCampaign;
}

export function buildSocialContentDashboardProjection(
  runtimeDoc: MarketingJobRuntimeDocument,
  dashboard: MarketingDashboardCampaignContent,
): MarketingDashboardCampaignContent {
  if (requestedJobTypeFromDoc(runtimeDoc) !== 'weekly_social_content') {
    return dashboard;
  }
  const projection = latestSocialProjection(runtimeDoc);
  if (!projection) {
    return dashboard;
  }

  const runtime = readSocialContentRuntimeState(runtimeDoc);
  const campaignId = dashboard.campaign?.id || publicCampaignId(runtimeDoc.job_id);
  const campaignName = dashboard.campaign?.name || brandName(runtimeDoc);
  const request = recordValue(runtimeDoc.inputs?.request);
  const objective =
    dashboard.campaign?.objective ||
    stringValue(request?.primaryGoal) ||
    stringValue(request?.goal) ||
    'Weekly social content';

  const assets = createAssets({ doc: runtimeDoc, projection, campaignId, campaignName, objective });
  const posts = createPosts({ doc: runtimeDoc, projection, assets, campaignId, campaignName, objective });
  const includePublishQueue = runtime?.publishingRequested === true || runtime?.currentStage === 'publish_review' || runtime?.currentStage === 'completed';
  const publishItems = createPublishItems({ doc: runtimeDoc, posts, campaignId, campaignName, objective, includePublishQueue });
  const calendarEvents = createCalendarEvents({ doc: runtimeDoc, projection, posts, campaignId, campaignName, objective });

  const mergedAssets = mergeById(dashboard.assets, assets);
  const mergedPosts = mergeById(dashboard.posts, posts);
  const mergedPublishItems = mergeById(dashboard.publishItems, publishItems);
  const mergedCalendarEvents = mergeById(dashboard.calendarEvents, calendarEvents);
  const campaign = createCampaign({
    doc: runtimeDoc,
    dashboard,
    campaignId,
    campaignName,
    objective,
    posts: mergedPosts,
    assets: mergedAssets,
    publishItems: mergedPublishItems,
    calendarEvents: mergedCalendarEvents,
  });

  return {
    campaign,
    posts: mergedPosts,
    assets: mergedAssets,
    publishItems: mergedPublishItems,
    calendarEvents: mergedCalendarEvents,
    statuses: {
      countsByStatus: recountStatuses({
        posts: mergedPosts,
        assets: mergedAssets,
        publishItems: mergedPublishItems,
        calendarEvents: mergedCalendarEvents,
      }),
    },
  };
}
