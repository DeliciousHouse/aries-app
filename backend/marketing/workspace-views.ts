import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  SocialContentBrief,
  MarketingCreativeAssetReviewPayload,
  MarketingCreativeReviewPayload,
  MarketingDashboardPost,
  MarketingDashboardSocialContentJob,
  MarketingDashboardSocialContentJobCompatibilityStatus,
  MarketingDashboardSocialContentJobContent,
  MarketingDashboardContent,
  MarketingDashboardItemStatus,
  MarketingReviewAttachment,
  MarketingReviewSection,
  MarketingStageReviewPayload,
} from '@/lib/api/marketing';
import { processConcurrent } from '@/lib/process-concurrent';

import { buildMarketingAssetLinks, findMarketingAsset } from './asset-library';
import {
  collectProductionReviewArtifacts,
  collectStrategyReviewArtifacts,
} from './artifact-collector';
import { createSocialContentJobFacts, type MarketingJobFacts } from './job-facts';
import { recordMatchesCurrentSource, sourceFingerprintFromRecord } from './brand-identity';
import { sanitizeBrandKitSummaryText } from './brand-kit';
import { buildSocialContentDashboardProjection } from '@/backend/social-content/dashboard-projection';
import { sanitizeAssetPreviewsForMissingMedia } from './hermes-media-presence';
import { getMarketingDashboardSocialContentJobContent } from './dashboard-content';
import { countPublishedPostsForJob } from './published-posts-count';
import { loadSocialContentJobRuntime, listSocialContentJobIdsForTenant, resolveStageOutput, type SocialContentJobRuntimeDocument } from './runtime-state';
import {
  ARTIFACT_INCOMPLETE_TEXT,
  ARTIFACT_UNAVAILABLE_TEXT,
  normalizeArtifactText,
  readLandingPageArtifactDetails,
  readScriptArtifactDetails,
} from './real-artifacts';
import {
  ensureSocialContentWorkspaceRecord,
  loadSocialContentWorkspaceRecord,
  marketingWorkspaceAssetUrl,
  saveSocialContentWorkspaceRecord,
  syncSocialContentWorkflowState,
  type SocialContentStatusHistoryEntry,
  type SocialContentStageReviewEvidenceKind,
  type SocialContentWorkspaceRecord,
  type SocialContentWorkflowState,
  type MarketingReviewStageKey,
  type MarketingReviewStatus,
} from './workspace-store';
import { loadValidatedMarketingProfileDocs, loadValidatedMarketingProfileSnapshot } from './validated-profile-store';
import { pool } from '@/lib/db';
import {
  SELECT_PRODUCTION_CREATIVE_ASSETS_SQL,
  type ProductionCreativeAssetRow,
  queryProductionCreativeAssets,
} from './production-assets-query';

export type SocialContentWorkspaceView = {
  jobId: string;
  tenantId: string | null;
  socialContentBrief: SocialContentBrief | null;
  workflowState: SocialContentWorkflowState;
  statusHistory: SocialContentStatusHistoryEntry[];
  brandReview: MarketingStageReviewPayload | null;
  strategyReview: MarketingStageReviewPayload | null;
  creativeReview: MarketingCreativeReviewPayload | null;
  publishBlockedReason: string | null;
  dashboard: MarketingDashboardSocialContentJobContent;
};

type StagePayloadBundle = {
  websiteAnalysis: Record<string, unknown> | null;
  brandProfile: Record<string, unknown> | null;
  socialContentPlanner: Record<string, unknown> | null;
  strategyPreview: Record<string, unknown> | null;
  productionPreview: Record<string, unknown> | null;
  brandBibleText: string | null;
  designSystemCss: string | null;
  proposalMarkdown: string | null;
  sources: {
    websiteAnalysis: 'runtime' | 'artifact_fallback' | 'none';
    brandProfile: 'runtime' | 'artifact_fallback' | 'none';
    socialContentPlanner: 'runtime' | 'artifact_fallback' | 'none';
    strategyPreview: 'runtime' | 'artifact_fallback' | 'none';
    productionPreview: 'runtime' | 'artifact_fallback' | 'none';
    brandBible: 'asset' | 'none';
    designSystem: 'asset' | 'none';
    proposalMarkdown: 'asset' | 'none';
  };
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

async function readJsonIfExists(filePath: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!filePath) {
    return null;
  }

  try {
    return recordValue(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function readTextIfExists(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  try {
    const text = (await readFile(filePath, 'utf8')).trim();
    return text || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

function familyIdFromImagePath(filePath: string | null): string | null {
  if (!filePath) {
    return null;
  }
  const basename = path.basename(filePath);
  const match = /^(meta-[a-z0-9-]+)\.(png|jpe?g|webp)$/i.exec(basename);
  return match ? match[1] : null;
}

function currentSourceUrl(runtimeDoc: SocialContentJobRuntimeDocument): string | null {
  const request = recordValue(runtimeDoc.inputs.request);
  return stringValue(request?.websiteUrl) || stringValue(request?.brandUrl) || stringValue(runtimeDoc.inputs.brand_url) || null;
}

function sourceMatchedStrategyPayload(
  value: Record<string, unknown> | null,
  sourceUrl: string | null,
  runSourceEvidence: Record<string, unknown> | null,
  hasRunSourceCandidate: boolean,
): Record<string, unknown> | null {
  if (!value || !recordMatchesCurrentSource(value, sourceUrl)) {
    return null;
  }
  if (!sourceUrl || sourceFingerprintFromRecord(value) || runSourceEvidence || !hasRunSourceCandidate) {
    return value;
  }
  return null;
}

function emptyStatusSummary() {
  return {
    countsByStatus: {
      draft: 0,
      in_review: 0,
      ready: 0,
      ready_to_publish: 0,
      published_to_meta_paused: 0,
      scheduled: 0,
      live: 0,
    } satisfies Record<MarketingDashboardItemStatus, number>,
  };
}

function postStatusHistoryEntry(entry: SocialContentStatusHistoryEntry): SocialContentStatusHistoryEntry {
  return {
    id: entry.id,
    at: entry.at,
    actor: entry.actor,
    type: entry.type,
    workflowState: entry.workflowState,
    stage: entry.stage,
    assetId: entry.assetId,
    action: entry.action,
    note: entry.note ?? null,
    status: entry.status,
  };
}

function formatList(items: Array<string | null | undefined>): string {
  const normalized = items.map((item) => stringValue(item)).filter(Boolean);
  return normalized.length > 0 ? normalized.map((item) => `- ${item}`).join('\n') : '';
}

function labeledBlock(items: Array<[string, string | string[] | null | undefined]>): string {
  return items
    .map(([label, value]) => {
      const body = Array.isArray(value)
        ? value.filter(Boolean).join('\n')
        : stringValue(value);
      return body ? `${label}\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function normalizeStrategyChannelDetail(value: unknown): string | null {
  const normalized = normalizeArtifactText(stringValue(value));
  if (!normalized) {
    return null;
  }

  if (/^translate the core message into .+ execution\.?$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

export function strategyChannelBlock(channel: Record<string, unknown>): string {
  const channelName = stringValue(channel.channel || channel.platform_slug || channel.platform, 'Channel').toUpperCase();
  const detailBlocks = [
    ['Goal', normalizeStrategyChannelDetail(channel.goal)],
    ['Message', normalizeStrategyChannelDetail(channel.message)],
    ['Creative bias', normalizeStrategyChannelDetail(channel.creative_bias)],
    ['CTA', normalizeStrategyChannelDetail(channel.cta)],
  ]
    .map(([label, value]) => (value ? `${label}\n${value}` : ''))
    .filter(Boolean);

  if (detailBlocks.length === 0) {
    const instructions = normalizeStrategyChannelDetail(channel.instructions);
    if (instructions) {
      return [channelName, instructions].join('\n\n');
    }
    return '';
  }

  return [channelName, ...detailBlocks].join('\n\n');
}

function workflowPostStatus(workflowState: SocialContentWorkflowState): MarketingDashboardItemStatus {
  switch (workflowState) {
    case 'approved':
      return 'ready';
    case 'ready_to_publish':
      return 'ready_to_publish';
    case 'published':
      return 'live';
    case 'brand_review_required':
    case 'strategy_review_required':
    case 'creative_review_required':
    case 'revisions_requested':
      return 'in_review';
    default:
      return 'draft';
  }
}

function workflowCompatibilityStatus(
  workflowState: SocialContentWorkflowState,
  postStatus: MarketingDashboardItemStatus,
): MarketingDashboardSocialContentJobCompatibilityStatus {
  switch (workflowState) {
    case 'revisions_requested':
      return 'changes_requested';
    case 'brand_review_required':
    case 'strategy_review_required':
    case 'creative_review_required':
      return 'in_review';
    case 'approved':
    case 'ready_to_publish':
      return 'approved';
    case 'published':
      return postStatus === 'scheduled' ? 'scheduled' : postStatus === 'live' ? 'live' : 'approved';
    default:
      return 'draft';
  }
}

function gatedItemStatus(
  status: MarketingDashboardItemStatus,
  workflowState: SocialContentWorkflowState,
): MarketingDashboardItemStatus {
  if (workflowState === 'published') {
    return status;
  }

  if (workflowState === 'ready_to_publish') {
    if (status === 'published_to_meta_paused' || status === 'scheduled' || status === 'live') {
      return 'ready_to_publish';
    }
    return status;
  }

  if (status === 'ready_to_publish' || status === 'published_to_meta_paused' || status === 'scheduled' || status === 'live') {
    return 'in_review';
  }

  return status;
}

function withGatedDashboardStatus(
  dashboard: MarketingDashboardSocialContentJobContent,
  workflowState: SocialContentWorkflowState,
): MarketingDashboardSocialContentJobContent {
  const posts = dashboard.posts.map((post) => ({
    ...post,
    status: gatedItemStatus(post.status, workflowState),
  }));
  const assets = dashboard.assets.map((asset) => ({
    ...asset,
    status: gatedItemStatus(asset.status, workflowState),
  }));
  const publishItems = dashboard.publishItems.map((item) => ({
    ...item,
    status: gatedItemStatus(item.status, workflowState),
  }));
  const calendarEvents = dashboard.calendarEvents.map((event) => ({
    ...event,
    status: gatedItemStatus(event.status, workflowState),
  }));
  const statuses = emptyStatusSummary();

  for (const item of [...posts, ...publishItems]) {
    statuses.countsByStatus[item.status] += 1;
  }

  const post = dashboard.post
    ? ({
        ...dashboard.post,
        approvalRequired:
          workflowState === 'revisions_requested'
            ? false
            : dashboard.post.approvalRequired,
        approvalActionHref:
          workflowState === 'revisions_requested'
            ? undefined
            : dashboard.post.approvalActionHref,
        status:
          workflowState === 'published'
            ? gatedItemStatus(dashboard.post.status, workflowState)
            : workflowPostStatus(workflowState),
        compatibilityStatus: workflowCompatibilityStatus(
          workflowState,
          workflowState === 'published'
            ? gatedItemStatus(dashboard.post.status, workflowState)
            : workflowPostStatus(workflowState),
        ),
        counts: {
          ...dashboard.post.counts,
          ready: [...posts, ...publishItems].filter((item) => item.status === 'ready').length,
          readyToPublish: [...posts, ...publishItems].filter((item) => item.status === 'ready_to_publish').length,
          pausedMetaAds: [...posts, ...publishItems].filter((item) => item.status === 'published_to_meta_paused').length,
          scheduled: [...posts, ...publishItems].filter((item) => item.status === 'scheduled').length,
          live: [...posts, ...publishItems].filter((item) => item.status === 'live').length,
        },
      } satisfies MarketingDashboardSocialContentJob)
    : null;

  return {
    post,
    posts,
    assets,
    publishItems,
    calendarEvents,
    statuses,
  };
}

function buildSocialContentBrief(record: SocialContentWorkspaceRecord): SocialContentBrief {
  return {
    websiteUrl: record.brief.websiteUrl,
    businessName: record.brief.businessName,
    businessType: record.brief.businessType,
    approverName: record.brief.approverName,
    goal: record.brief.goal,
    offer: record.brief.offer,
    competitorUrl: record.brief.competitorUrl,
    channels: record.brief.channels,
    brandVoice: record.brief.brandVoice,
    styleVibe: record.brief.styleVibe,
    visualReferences: record.brief.visualReferences,
    mustUseCopy: record.brief.mustUseCopy,
    mustAvoidAesthetics: record.brief.mustAvoidAesthetics,
    notes: record.brief.notes,
    brandAssets: record.brief.brandAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      fileName: asset.fileName,
      contentType: asset.contentType,
      size: asset.size,
      uploadedAt: asset.uploadedAt,
      url: marketingWorkspaceAssetUrl(record.job_id, asset.id),
    })),
  };
}

export function primaryOutputToSocialContentPlanner(
  stageOutput: Record<string, unknown>,
): Record<string, unknown> {
  const channelAdaptation = recordValue(stageOutput.channel_adaptation);
  const channelPlans = channelAdaptation
    ? Object.entries(channelAdaptation).map(([platform, instructions]) => ({ platform, instructions }))
    : [];
  return {
    campaign_plan: {
      core_message: stringValue(stageOutput.positioning) ?? '',
      channel_plans: channelPlans,
      content_package: Array.isArray(stageOutput.content_package) ? stageOutput.content_package : [],
    },
    creative_direction: stringValue(stageOutput.creative_direction) ?? '',
  };
}

export function primaryOutputToProductionPreview(
  stageOutput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    production_handoff: {
      production_brief: {
        weekly_plan: stageOutput.weekly_content_plan ?? null,
        content_package: Array.isArray(stageOutput.content_package) ? stageOutput.content_package : [],
        artifacts: stageOutput.artifacts ?? null,
      },
    },
  };
}

async function loadStagePayloadBundle(
  runtimeDoc: SocialContentJobRuntimeDocument,
  facts: MarketingJobFacts,
): Promise<StagePayloadBundle> {
  const sourceUrl = currentSourceUrl(runtimeDoc);
  const validatedDocs = await loadValidatedMarketingProfileDocs(runtimeDoc.tenant_id, {
    currentSourceUrl: sourceUrl,
  });
  const strategyOutputs = recordValue(runtimeDoc.stages.strategy.outputs) || {};
  const productionOutputs = recordValue(runtimeDoc.stages.production.outputs) || {};
  const strategyFallback = await collectStrategyReviewArtifacts(
    facts,
    runtimeDoc.stages.strategy.primary_output || { run_id: runtimeDoc.stages.strategy.run_id },
  );
  const productionFallback = await collectProductionReviewArtifacts(
    facts,
    runtimeDoc.stages.production.primary_output || { run_id: runtimeDoc.stages.production.run_id },
  );

  const runtimeWebsiteAnalysisPath = stringValue(strategyOutputs.validated_website_analysis_path) || stringValue(strategyOutputs.website_brand_analysis_path);
  const runtimeBrandProfilePath =
    stringValue(strategyOutputs.validated_brand_profile_path) ||
    stringValue(strategyOutputs.brand_profile_path);
  const runtimeCampaignPlannerPath = stringValue(strategyOutputs.social_content_planner_path)
    ?? stringValue(strategyOutputs.campaign_planner_path); // legacy compat
  const runtimeStrategyPreviewPath = stringValue(strategyOutputs.strategy_review_path);
  const runtimeProductionPreviewPath = stringValue(productionOutputs.production_review_path);

  const fallbackWebsiteAnalysisPath = stringValue(strategyFallback.outputs.website_brand_analysis_path);
  const fallbackBrandProfilePath = stringValue(strategyFallback.outputs.validated_brand_profile_path);
  const fallbackCampaignPlannerPath = stringValue(strategyFallback.outputs.social_content_planner_path)
    ?? stringValue(strategyFallback.outputs.campaign_planner_path); // legacy compat
  const fallbackStrategyPreviewPath = stringValue(strategyFallback.outputs.strategy_review_path);
  const fallbackProductionPreviewPath = stringValue(productionFallback.outputs.production_review_path);
  const runtimeWebsiteAnalysisFile = await readJsonIfExists(runtimeWebsiteAnalysisPath);
  const runtimeBrandProfileFile = await readJsonIfExists(runtimeBrandProfilePath);
  const runtimeCampaignPlannerFile = await readJsonIfExists(runtimeCampaignPlannerPath);
  const runtimeStrategyPreviewFile = await readJsonIfExists(runtimeStrategyPreviewPath);
  const runtimeProductionPreviewFile = await readJsonIfExists(runtimeProductionPreviewPath);
  const fallbackWebsiteAnalysisFile = await readJsonIfExists(fallbackWebsiteAnalysisPath);
  const fallbackBrandProfileFile = await readJsonIfExists(fallbackBrandProfilePath);
  const fallbackCampaignPlannerFile = await readJsonIfExists(fallbackCampaignPlannerPath);
  const fallbackStrategyPreviewFile = await readJsonIfExists(fallbackStrategyPreviewPath);
  const fallbackProductionPreviewFile = await readJsonIfExists(fallbackProductionPreviewPath);

  const rawRuntimeRunWebsiteAnalysis =
    recordValue(strategyOutputs.website) ||
    runtimeWebsiteAnalysisFile;
  const runtimeRunWebsiteAnalysis =
    (recordMatchesCurrentSource(recordValue(strategyOutputs.website), sourceUrl) ? recordValue(strategyOutputs.website) : null) ||
    (recordMatchesCurrentSource(runtimeWebsiteAnalysisFile, sourceUrl)
      ? runtimeWebsiteAnalysisFile
      : null);
  const runtimeWebsiteAnalysis =
    runtimeRunWebsiteAnalysis ||
    validatedDocs.websiteAnalysis;
  const runtimeBrandProfile =
    (recordMatchesCurrentSource(recordValue(strategyOutputs.brand_profile), sourceUrl)
      ? recordValue(strategyOutputs.brand_profile)
      : null) ||
    (recordMatchesCurrentSource(runtimeBrandProfileFile, sourceUrl)
      ? runtimeBrandProfileFile
      : null);
  const runtimeCampaignPlanner = sourceMatchedStrategyPayload(
    recordValue(strategyOutputs.planner) || runtimeCampaignPlannerFile,
    sourceUrl,
    runtimeRunWebsiteAnalysis,
    !!rawRuntimeRunWebsiteAnalysis,
  );
  const runtimeStrategyPreview = sourceMatchedStrategyPayload(
    recordValue(strategyOutputs.review) || runtimeStrategyPreviewFile,
    sourceUrl,
    runtimeRunWebsiteAnalysis,
    !!rawRuntimeRunWebsiteAnalysis,
  );
  const runtimeProductionPreview = recordValue(productionOutputs.review) ||
    runtimeProductionPreviewFile;

  const rawFallbackRunWebsiteAnalysis =
    fallbackWebsiteAnalysisFile ||
    recordValue(strategyFallback.outputs.website);
  const fallbackRunWebsiteAnalysis =
    (recordMatchesCurrentSource(fallbackWebsiteAnalysisFile, sourceUrl)
      ? fallbackWebsiteAnalysisFile
      : null) ||
    (recordMatchesCurrentSource(recordValue(strategyFallback.outputs.website), sourceUrl)
      ? recordValue(strategyFallback.outputs.website)
      : null);
  const websiteAnalysis = runtimeWebsiteAnalysis || fallbackRunWebsiteAnalysis;
  const brandProfile = runtimeBrandProfile ||
    validatedDocs.brandProfile ||
    (recordMatchesCurrentSource(fallbackBrandProfileFile, sourceUrl)
      ? fallbackBrandProfileFile
      : null) ||
    (recordMatchesCurrentSource(recordValue(strategyFallback.outputs.brand_profile), sourceUrl)
      ? recordValue(strategyFallback.outputs.brand_profile)
      : null);
  const strategyPrimaryOutput = resolveStageOutput(runtimeDoc, 'strategy');
  const productionPrimaryOutput = resolveStageOutput(runtimeDoc, 'production');
  const primaryOutputCampaignPlannerRaw = strategyPrimaryOutput && Object.keys(strategyOutputs).length === 0
    ? primaryOutputToSocialContentPlanner(strategyPrimaryOutput)
    : null;
  const primaryOutputCampaignPlanner = (() => {
    if (!primaryOutputCampaignPlannerRaw) return null;
    const plan = recordValue(primaryOutputCampaignPlannerRaw.campaign_plan);
    const hasContent =
      !!stringValue(plan?.core_message) ||
      recordArray(plan?.channel_plans).length > 0 ||
      recordArray(plan?.content_package).length > 0 ||
      !!stringValue(primaryOutputCampaignPlannerRaw.creative_direction);
    return hasContent ? primaryOutputCampaignPlannerRaw : null;
  })();
  const primaryOutputProductionPreview = productionPrimaryOutput && Object.keys(productionOutputs).length === 0
    ? primaryOutputToProductionPreview(productionPrimaryOutput)
    : null;

  const socialContentPlanner = runtimeCampaignPlanner ||
    sourceMatchedStrategyPayload(
      fallbackCampaignPlannerFile || recordValue(strategyFallback.outputs.planner),
      sourceUrl,
      fallbackRunWebsiteAnalysis,
      !!rawFallbackRunWebsiteAnalysis,
    ) ||
    primaryOutputCampaignPlanner;
  const strategyPreview = runtimeStrategyPreview ||
    sourceMatchedStrategyPayload(
      fallbackStrategyPreviewFile || recordValue(strategyFallback.outputs.review),
      sourceUrl,
      fallbackRunWebsiteAnalysis,
      !!rawFallbackRunWebsiteAnalysis,
    );
  const productionPreview = runtimeProductionPreview ||
    fallbackProductionPreviewFile ||
    recordValue(productionFallback.outputs.review) ||
    primaryOutputProductionPreview;

  const hasCurrentSourceBrandArtifacts = !!(websiteAnalysis || brandProfile);
  const hasCurrentSourceStrategyArtifacts = !!(socialContentPlanner || strategyPreview || hasCurrentSourceBrandArtifacts);

  const brandBibleAsset = await findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'brand-bible-markdown', facts);
  const designSystemAsset = await findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'brand-design-system', facts);
  const proposalMarkdownAsset = await findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'strategy-proposal-markdown', facts);

  return {
    websiteAnalysis,
    brandProfile,
    socialContentPlanner,
    strategyPreview,
    productionPreview,
    brandBibleText: hasCurrentSourceBrandArtifacts
      ? await readTextIfExists(
          brandBibleAsset?.filePath || stringValue(recordValue(websiteAnalysis?.artifacts)?.brand_bible_markdown_path),
        )
      : null,
    designSystemCss: hasCurrentSourceBrandArtifacts
      ? await readTextIfExists(
          designSystemAsset?.filePath || stringValue(recordValue(websiteAnalysis?.artifacts)?.design_system_css_path),
        )
      : null,
    proposalMarkdown: hasCurrentSourceStrategyArtifacts ? await readTextIfExists(proposalMarkdownAsset?.filePath) : null,
    sources: {
      websiteAnalysis: runtimeWebsiteAnalysis
        ? 'runtime'
        : websiteAnalysis
          ? 'artifact_fallback'
          : 'none',
      brandProfile: runtimeBrandProfile
        ? 'runtime'
        : brandProfile
          ? 'artifact_fallback'
          : 'none',
      socialContentPlanner: runtimeCampaignPlanner
        ? 'runtime'
        : socialContentPlanner
          ? 'artifact_fallback'
          : 'none',
      strategyPreview: runtimeStrategyPreview
        ? 'runtime'
        : strategyPreview
          ? 'artifact_fallback'
          : 'none',
      productionPreview: runtimeProductionPreview
        ? 'runtime'
        : productionPreview
          ? 'artifact_fallback'
          : 'none',
      brandBible: brandBibleAsset?.filePath ? 'asset' : 'none',
      designSystem: designSystemAsset?.filePath ? 'asset' : 'none',
      proposalMarkdown: proposalMarkdownAsset?.filePath ? 'asset' : 'none',
    },
  };
}

function hasRealBrandArtifacts(payloads: StagePayloadBundle): boolean {
  return !!(
    payloads.websiteAnalysis ||
    payloads.brandProfile ||
    payloads.brandBibleText ||
    payloads.designSystemCss
  );
}

function uploadedBrandAssets(record: SocialContentWorkspaceRecord): boolean {
  return record.brief.brandAssets.length > 0;
}

function syncBrandReviewEvidenceState(
  record: SocialContentWorkspaceRecord,
  input: {
    brandReviewRenderable: boolean;
    hasRealBrandArtifacts: boolean;
  },
): { changed: boolean; resetToPending: boolean } {
  if (!input.brandReviewRenderable) {
    return { changed: false, resetToPending: false };
  }

  const current = record.stage_reviews.brand;
  const nextEvidenceKind: SocialContentStageReviewEvidenceKind = input.hasRealBrandArtifacts
    ? 'real_artifacts'
    : 'upload_only';
  let changed = false;
  let resetToPending = false;

  if (input.hasRealBrandArtifacts && current.evidenceKind === 'upload_only') {
    record.stage_reviews.brand = {
      ...current,
      status: 'pending_review',
      updatedAt: null,
      evidenceKind: 'real_artifacts',
    };
    return {
      changed: true,
      resetToPending: true,
    };
  }

  if (current.status === 'not_ready') {
    record.stage_reviews.brand = {
      ...current,
      status: 'pending_review',
      evidenceKind: nextEvidenceKind,
    };
    changed = true;
  } else if (current.evidenceKind !== nextEvidenceKind) {
    record.stage_reviews.brand = {
      ...current,
      evidenceKind: nextEvidenceKind,
    };
    changed = true;
  }

  return { changed, resetToPending };
}

function marketingAttachment(
  id: string,
  label: string,
  url: string,
  contentType: string,
  kind: MarketingReviewAttachment['kind'],
): MarketingReviewAttachment {
  return { id, label, url, contentType, kind };
}

function stageHistory(
  history: SocialContentStatusHistoryEntry[],
  stage: MarketingReviewStageKey,
  assetId?: string,
): SocialContentStatusHistoryEntry[] {
  return history
    .filter((entry) => {
      if (assetId) {
        return entry.assetId === assetId || entry.type === 'state_changed';
      }
      return entry.stage === stage || entry.type === 'state_changed';
    })
    .map(postStatusHistoryEntry);
}

async function buildBrandReview(
  runtimeDoc: SocialContentJobRuntimeDocument,
  record: SocialContentWorkspaceRecord,
  payloads: StagePayloadBundle,
  facts: MarketingJobFacts,
): Promise<MarketingStageReviewPayload | null> {
  const hasGeneratedBrandArtifacts = hasRealBrandArtifacts(payloads);
  const hasUploadedBrandAssets = uploadedBrandAssets(record);
  if (!hasGeneratedBrandArtifacts && !hasUploadedBrandAssets) {
    return null;
  }

  const validatedProfile = await loadValidatedMarketingProfileSnapshot(runtimeDoc.tenant_id, {
    currentSourceUrl: currentSourceUrl(runtimeDoc) || record.brief.websiteUrl || null,
  });
  const brandProfile = payloads.brandProfile;
  const creativeHandoff = recordValue(brandProfile?.creative_handoff);
  const brandAnalysis = recordValue(payloads.websiteAnalysis?.brand_analysis);
  const brandIdentity = validatedProfile.brandIdentity;
  const runtimeBrandKit = runtimeDoc.brand_kit;
  const runtimeBrandName = stringValue(validatedProfile.brandName, stringValue(runtimeBrandKit?.brand_name));
  const runtimeCanonicalUrl = stringValue(validatedProfile.canonicalUrl, stringValue(runtimeBrandKit?.canonical_url));
  const runtimeOfferSummary = stringValue(
    validatedProfile.offer,
    sanitizeBrandKitSummaryText(stringValue(runtimeBrandKit?.offer_summary)) ?? undefined,
  );
  const runtimeVoiceSummary = sanitizeBrandKitSummaryText(stringValue(runtimeBrandKit?.brand_voice_summary));
  const runtimeLogoUrls = runtimeBrandKit?.logo_urls ?? [];
  const runtimePalette = runtimeBrandKit?.colors.palette ?? [];
  const runtimeFonts = runtimeBrandKit?.font_families ?? [];
  const runtimeExternalLinks = runtimeBrandKit?.external_links ?? [];
  const validatedLandingHooks = Array.isArray(recordValue(validatedProfile.hooks)?.['landing-page'])
    ? (recordValue(validatedProfile.hooks)?.['landing-page'] as unknown[])
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const attachments: MarketingReviewAttachment[] = [];
  const assetLinks = new Map((await buildMarketingAssetLinks(runtimeDoc.job_id, runtimeDoc, facts)).map((asset) => [asset.id, asset] as const));

  for (const asset of record.brief.brandAssets) {
    attachments.push(
      marketingAttachment(
        asset.id,
        asset.name,
        marketingWorkspaceAssetUrl(runtimeDoc.job_id, asset.id),
        asset.contentType,
        'brand_asset',
      ),
    );
  }

  const brandBible = assetLinks.get('brand-bible-markdown');
  const designSystem = assetLinks.get('brand-design-system');
  const websiteAnalysis = assetLinks.get('strategy-website-analysis');

  if (websiteAnalysis && hasGeneratedBrandArtifacts) {
    attachments.push(marketingAttachment(websiteAnalysis.id, websiteAnalysis.label, websiteAnalysis.url, websiteAnalysis.contentType, 'document'));
  }
  if (brandBible && hasGeneratedBrandArtifacts) {
    attachments.push(marketingAttachment(brandBible.id, brandBible.label, brandBible.url, brandBible.contentType, 'document'));
  }
  if (designSystem && hasGeneratedBrandArtifacts) {
    attachments.push(marketingAttachment(designSystem.id, designSystem.label, designSystem.url, designSystem.contentType, 'artifact'));
  }

  const messageDirectionBody = labeledBlock([
    [
      'Offer focus',
      stringValue(
        brandIdentity?.offer,
        stringValue(validatedProfile.offer, stringValue(creativeHandoff?.offer, stringValue(brandAnalysis?.offer_summary, runtimeOfferSummary))),
      ),
    ],
    [
      'Primary promise',
      stringValue(brandIdentity?.promise, validatedLandingHooks[0] || stringValue(brandAnalysis?.brand_promise)),
    ],
    [
      'Audience',
      stringValue(
        brandIdentity?.audience,
        stringValue(validatedProfile.audience, stringValue(creativeHandoff?.audience, stringValue(brandAnalysis?.audience_summary, stringValue(brandAnalysis?.audience)))),
      ),
    ],
    [
      'Proof direction',
      stringValue(
        brandIdentity?.proofStyle,
        formatList(
          validatedProfile.proofPoints.length > 0
            ? validatedProfile.proofPoints
            : (Array.isArray(creativeHandoff?.proof_points) ? stringArray(creativeHandoff?.proof_points) : stringArray(brandAnalysis?.proof_points)),
        ),
      ),
    ],
    [
      'CTA direction',
      stringValue(
        brandIdentity?.ctaStyle,
        formatList(
          validatedProfile.primaryCta
            ? [validatedProfile.primaryCta]
            : (stringValue(creativeHandoff?.primary_cta)
                ? [stringValue(creativeHandoff?.primary_cta)]
                : stringArray(brandAnalysis?.cta_preferences)),
        ),
      ),
    ],
    [
      'Voice',
      stringValue(
        brandIdentity?.toneOfVoice,
        formatList(
          validatedProfile.brandVoice.length > 0
            ? validatedProfile.brandVoice
            : (Array.isArray(creativeHandoff?.brand_voice) ? stringArray(creativeHandoff?.brand_voice) : stringArray(brandAnalysis?.brand_voice)),
        ),
      ),
    ],
    ['Must-use copy', record.brief.mustUseCopy || null],
  ]);

  const visualDirectionBody = labeledBlock([
    [
      'Style direction',
      stringValue(brandIdentity?.styleVibe, record.brief.styleVibe),
    ],
    [
      'Visible marks',
      runtimeLogoUrls.length > 0 ? `${runtimeLogoUrls.length} current-source mark${runtimeLogoUrls.length === 1 ? '' : 's'} captured.` : null,
    ],
    [
      'Palette cues',
      runtimePalette.length > 0 ? `${runtimePalette.length} palette cue${runtimePalette.length === 1 ? '' : 's'} captured from the current source.` : null,
    ],
    [
      'Typography cues',
      runtimeFonts.length > 0 ? `${runtimeFonts.length} typography cue${runtimeFonts.length === 1 ? '' : 's'} captured from the current source.` : null,
    ],
    [
      'Visible brand links',
      runtimeExternalLinks.length > 0 ? formatList(runtimeExternalLinks.map((link) => `${link.platform}: ${link.url}`)) : null,
    ],
    ['Must-avoid aesthetics', record.brief.mustAvoidAesthetics || null],
  ]);

  const sections: MarketingReviewSection[] = hasGeneratedBrandArtifacts
    ? [
        {
          id: 'brand-summary',
          title: 'Brand summary',
          body: labeledBlock([
            ['Brand', stringValue(validatedProfile.brandName, stringValue(creativeHandoff?.brand_name, stringValue(brandAnalysis?.brand_name, runtimeBrandName)))],
            ['Website', stringValue(validatedProfile.websiteUrl, stringValue(creativeHandoff?.website_url, stringValue(brandAnalysis?.website_url, record.brief.websiteUrl || runtimeDoc.inputs.brand_url)))],
            ['Canonical URL', stringValue(validatedProfile.canonicalUrl, stringValue(brandAnalysis?.canonical_url, runtimeCanonicalUrl))],
            ['Positioning', stringValue(brandIdentity?.positioning, stringValue(validatedProfile.positioning, stringValue(creativeHandoff?.positioning, stringValue(brandAnalysis?.positioning_summary, stringValue(brandAnalysis?.positioning)))))],
            ['Audience', stringValue(brandIdentity?.audience, stringValue(validatedProfile.audience, stringValue(creativeHandoff?.audience, stringValue(brandAnalysis?.audience_summary, stringValue(brandAnalysis?.audience)))))],
            ['Identity summary', stringValue(brandIdentity?.summary, runtimeVoiceSummary ?? undefined)],
          ]),
        },
        {
          id: 'messaging-direction',
          title: 'Messaging direction',
          body: messageDirectionBody,
        },
        {
          id: 'visual-direction',
          title: 'Visual direction',
          body: visualDirectionBody,
        },
      ]
    : [
        {
          id: 'intake-constraints',
          title: 'Intake constraints',
          body: labeledBlock([
            ['Website', record.brief.websiteUrl || runtimeDoc.inputs.brand_url],
            ['Business name', record.brief.businessName],
            ['Business type', record.brief.businessType],
            ['Goal', record.brief.goal],
            ['Offer', record.brief.offer],
            ['Brand voice', record.brief.brandVoice],
            ['Style / vibe', record.brief.styleVibe],
            ['Visual references', formatList(record.brief.visualReferences)],
            ['Must-use copy', record.brief.mustUseCopy || 'None provided.'],
            ['Must-avoid aesthetics', record.brief.mustAvoidAesthetics || 'None provided.'],
            ['Notes', record.brief.notes || 'None provided.'],
          ]),
        },
        {
          id: 'uploaded-brand-assets',
          title: 'Uploaded brand assets',
          body: formatList(record.brief.brandAssets.map((asset) => asset.name)),
        },
      ];

  if (sections.every((section) => !section.body.trim()) && attachments.length === 0) {
    return null;
  }

  return {
    reviewId: `${runtimeDoc.job_id}::brand-review`,
    reviewType: 'brand',
    status: record.stage_reviews.brand.status,
    title: 'Brand Review',
    summary: hasGeneratedBrandArtifacts
      ? stringValue(
          brandIdentity?.summary,
          stringValue(
            validatedProfile.positioning,
            stringValue(runtimeOfferSummary, stringValue(brandAnalysis?.brand_promise, runtimeVoiceSummary ?? undefined)),
          ) ?? undefined,
        )
      : stringValue(record.brief.brandVoice, 'Uploaded brand assets and intake constraints are ready for review.'),
    notePlaceholder: 'Add brand-direction notes, copy edits, or visual guardrails.',
    brandIdentity,
    sections: sections.filter((section) => section.body.trim().length > 0),
    attachments,
    history: stageHistory(record.status_history, 'brand'),
    latestNote: record.stage_reviews.brand.latestNote,
  };
}

// Strategy Review header summary. Pure of side effects so it can be tested
// directly: pass a campaign_plan record (or undefined), get back the rendered
// summary string.
//
// Do NOT fall back to reviewPacket?.objective when core_message is missing —
// an objective ("drive 50 demo bookings") and a summary ("we own the calm
// weekly social content lane") are structurally different fields. Mapping one
// onto the other produced headers that misled reviewers about what they were
// approving. When core_message is missing, return the generic prompt copy.
export function deriveStrategyReviewSummary(
  socialContentPlan: Record<string, unknown> | undefined | null,
): string {
  return (
    stringValue(socialContentPlan?.core_message) ||
    'Review the campaign proposal before creative production is treated as approved.'
  );
}

async function buildStrategyReview(
  runtimeDoc: SocialContentJobRuntimeDocument,
  record: SocialContentWorkspaceRecord,
  payloads: StagePayloadBundle,
  facts: MarketingJobFacts,
): Promise<MarketingStageReviewPayload | null> {
  const socialContentPlan = recordValue(payloads.socialContentPlanner?.campaign_plan);
  const reviewPacket = recordValue(payloads.strategyPreview?.review_packet);
  const productionBrief = recordValue(recordValue(payloads.productionPreview?.production_handoff)?.production_brief);
  if (!socialContentPlan && !reviewPacket && !productionBrief && !payloads.proposalMarkdown) {
    return null;
  }
  const attachments: MarketingReviewAttachment[] = [];
  const assetLinks = new Map((await buildMarketingAssetLinks(runtimeDoc.job_id, runtimeDoc, facts)).map((asset) => [asset.id, asset] as const));

  for (const assetId of ['strategy-campaign-planner', 'strategy-review-preview', 'strategy-proposal-markdown', 'strategy-proposal-html'] as const) {
    const asset = assetLinks.get(assetId);
    if (asset) {
      attachments.push(marketingAttachment(asset.id, asset.label, asset.url, asset.contentType, assetId.includes('html') ? 'preview' : 'document'));
    }
  }

  const channelPlans = (
    recordArray(socialContentPlan?.channel_plans).length > 0
      ? recordArray(socialContentPlan?.channel_plans)
      : recordArray(productionBrief?.channel_priorities)
  )
    .map(strategyChannelBlock)
    .filter(Boolean);
  const scopedChannels = stringArray(reviewPacket?.channels_in_scope);
  const sections: MarketingReviewSection[] = [
    {
      id: 'social-content-summary',
      title: 'Social content proposal',
      body: labeledBlock([
        ['Post name', stringValue(socialContentPlan?.campaign_name, stringValue(reviewPacket?.campaign_name))],
        ['Objective', stringValue(socialContentPlan?.objective, stringValue(reviewPacket?.objective))],
        ['Core message', stringValue(socialContentPlan?.core_message, stringValue(reviewPacket?.core_message))],
        ['Audience', stringValue(socialContentPlan?.audience)],
        ['Offer', stringValue(socialContentPlan?.offer)],
        ['Primary CTA', stringValue(socialContentPlan?.primary_cta)],
      ]),
    },
    {
      id: 'channel-plan',
      title: 'Channel plan',
      body:
        channelPlans.join('\n\n') ||
        (scopedChannels.length > 0 ? formatList(scopedChannels) : ARTIFACT_INCOMPLETE_TEXT),
    },
  ];

  const creativeDirection = stringValue(payloads.socialContentPlanner?.creative_direction);
  if (creativeDirection) {
    sections.push({
      id: 'creative-direction',
      title: 'Creative direction',
      body: creativeDirection,
    });
  }

  const proposedPosts = recordArray(socialContentPlan?.content_package);
  if (proposedPosts.length > 0) {
    const postBlocks = proposedPosts.map((post, i) => {
      const num = stringValue(post.post_number) || String(i + 1);
      const platforms = stringArray(post.platforms);
      return labeledBlock([
        [`Post ${num}`, null],
        ['Hook', stringValue(post.hook)],
        ['Body', stringValue(post.body)],
        ['CTA', stringValue(post.cta)],
        ['Format', stringValue(post.format)],
        ['Platforms', platforms.length > 0 ? formatList(platforms) : null],
      ]);
    });
    sections.push({
      id: 'proposed-posts',
      title: 'Proposed posts',
      body: postBlocks.filter(Boolean).join('\n\n---\n\n'),
    });
  }

  if (payloads.proposalMarkdown) {
    sections.push({
      id: 'proposal-markdown',
      title: 'Full proposal',
      body: payloads.proposalMarkdown,
    });
  }

  if (sections.every((section) => !section.body.trim()) && attachments.length === 0) {
    return null;
  }

  return {
    reviewId: `${runtimeDoc.job_id}::strategy-review`,
    reviewType: 'strategy',
    status: record.stage_reviews.strategy.status,
    title: 'Strategy Review',
    summary: deriveStrategyReviewSummary(socialContentPlan),
    notePlaceholder: 'Call out strategic changes, channel shifts, or proposal edits.',
    sections: sections.filter((section) => section.body.trim().length > 0),
    attachments,
    history: stageHistory(record.status_history, 'strategy'),
    latestNote: record.stage_reviews.strategy.latestNote,
  };
}

async function buildCreativeAssets(
  runtimeDoc: SocialContentJobRuntimeDocument,
  record: SocialContentWorkspaceRecord,
  dashboard: MarketingDashboardSocialContentJobContent,
  productionPreview: Record<string, unknown> | null,
  facts: MarketingJobFacts,
): Promise<MarketingCreativeAssetReviewPayload[]> {
  const creativeAssets = dashboard.assets.filter(
    (asset) =>
      ['landing_page', 'image_ad', 'script', 'copy'].includes(asset.type) &&
      (asset.relatedPublishItemIds.length === 0 || asset.provenance.sourceKind === 'creative_output'),
  );
  const reviewPacket = recordValue(productionPreview?.review_packet);
  const assetPreviews = recordValue(reviewPacket?.asset_previews);
  const fallbackLanding = await readLandingPageArtifactDetails({ runtimeDoc });
  const fallbackScripts = await readScriptArtifactDetails({ runtimeDoc });

  let metaAdScriptsByFamily:
    | Record<string, unknown>
    | null
    | undefined;

  async function getMetaAdScriptsByFamily(): Promise<Record<string, unknown> | null> {
    if (metaAdScriptsByFamily !== undefined) {
      return metaAdScriptsByFamily;
    }
    const scriptwriterPayload = await facts.stagePayload('production', 'scriptwriter');
    metaAdScriptsByFamily = recordValue(
      recordValue(scriptwriterPayload?.script_assets)?.meta_ad_scripts_by_family,
    );
    return metaAdScriptsByFamily;
  }

  async function perFamilyHook(filePath: string | null): Promise<string | null> {
    const familyId = familyIdFromImagePath(filePath);
    if (!familyId) {
      return null;
    }
    const scriptsByFamily = await getMetaAdScriptsByFamily();
    if (!scriptsByFamily) {
      return null;
    }
    const entry = recordValue(scriptsByFamily[familyId]);
    return stringValue(entry?.hook) || null;
  }

  const productionContentPackage = recordArray(
    recordValue(runtimeDoc.stages.production.primary_output)?.content_package,
  );
  const strategyContentPackage = recordArray(
    recordValue(runtimeDoc.stages.strategy.primary_output)?.content_package,
  );
  function primaryOutputHookForAsset(assetId: string): string | null {
    const match = /^img_(\d+)$/.exec(assetId);
    if (!match) return null;
    const postIndex = parseInt(match[1], 10) - 1;
    const pkg = productionContentPackage.length > 0 ? productionContentPackage : strategyContentPackage;
    return stringValue(pkg[postIndex]?.hook) || null;
  }

  return Promise.all(creativeAssets.map(async (asset) => {
    const reviewState = record.creative_asset_reviews[asset.id];
    const resolvedAsset = await findMarketingAsset(runtimeDoc.job_id, runtimeDoc, asset.id, facts);
    const fileName = resolvedAsset?.filePath ? path.basename(resolvedAsset.filePath) : null;
    const isVideoScript = asset.platform === 'video' || /video|short/i.test(`${asset.id} ${asset.title}`);
    const scriptDetails = isVideoScript
      ? await readScriptArtifactDetails({ shortVideoScriptPath: resolvedAsset?.filePath || null, runtimeDoc })
      : await readScriptArtifactDetails({ metaScriptPath: resolvedAsset?.filePath || null, runtimeDoc });
    const landingDetails = asset.type === 'landing_page'
      ? await readLandingPageArtifactDetails({ path: resolvedAsset?.filePath || null, runtimeDoc })
      : fallbackLanding;
    const detailLines: string[] = [];
    const assetSummary =
      asset.type === 'landing_page'
        ? normalizeArtifactText(landingDetails.headline) ||
          normalizeArtifactText(landingDetails.subheadline) ||
          normalizeArtifactText(stringValue(assetPreviews?.landing_page_headline))
        : asset.type === 'image_ad'
          ? normalizeArtifactText(await perFamilyHook(resolvedAsset?.filePath || null)) ||
            normalizeArtifactText(scriptDetails.metaAdHook) ||
            normalizeArtifactText(fallbackScripts.metaAdHook) ||
            normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook)) ||
            normalizeArtifactText(primaryOutputHookForAsset(asset.id))
          : isVideoScript
            ? normalizeArtifactText(scriptDetails.shortVideoOpeningLine) ||
              normalizeArtifactText(fallbackScripts.shortVideoOpeningLine) ||
              normalizeArtifactText(stringValue(assetPreviews?.video_opening_line))
            : normalizeArtifactText(scriptDetails.metaAdHook) ||
              normalizeArtifactText(fallbackScripts.metaAdHook) ||
              normalizeArtifactText(scriptDetails.metaAdBody[0]) ||
              normalizeArtifactText(fallbackScripts.metaAdBody[0]) ||
              normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook));
    detailLines.push(`Platform: ${asset.platformLabel}`);
    if (fileName) {
      detailLines.push(`Source file: ${fileName}`);
    }
    if (asset.destinationUrl) {
      detailLines.push(`Destination: ${asset.destinationUrl}`);
    }
    if (asset.type === 'landing_page') {
      detailLines.push(`Headline: ${landingDetails.headline || normalizeArtifactText(stringValue(assetPreviews?.landing_page_headline)) || ARTIFACT_UNAVAILABLE_TEXT}`);
      if (landingDetails.slug) {
        detailLines.push(`Slug: ${landingDetails.slug}`);
      }
    } else if (asset.type === 'image_ad') {
      detailLines.push(`Ad hook: ${await perFamilyHook(resolvedAsset?.filePath || null) || scriptDetails.metaAdHook || fallbackScripts.metaAdHook || normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook)) || primaryOutputHookForAsset(asset.id) || ARTIFACT_UNAVAILABLE_TEXT}`);
    } else if (isVideoScript) {
      detailLines.push(`Opening line: ${scriptDetails.shortVideoOpeningLine || fallbackScripts.shortVideoOpeningLine || normalizeArtifactText(stringValue(assetPreviews?.video_opening_line)) || ARTIFACT_UNAVAILABLE_TEXT}`);
      if ((scriptDetails.shortVideoBeats[0] || fallbackScripts.shortVideoBeats[0])) {
        detailLines.push(`First beat: ${scriptDetails.shortVideoBeats[0] || fallbackScripts.shortVideoBeats[0]}`);
      }
    } else {
      detailLines.push(`Hook: ${scriptDetails.metaAdHook || fallbackScripts.metaAdHook || normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook)) || ARTIFACT_UNAVAILABLE_TEXT}`);
      if ((scriptDetails.metaAdBody[0] || fallbackScripts.metaAdBody[0])) {
        detailLines.push(`Body line: ${scriptDetails.metaAdBody[0] || fallbackScripts.metaAdBody[0]}`);
      }
    }

    return {
      reviewId: `${runtimeDoc.job_id}::creative:${asset.id}`,
      reviewType: 'creative',
      assetId: asset.id,
      title: asset.title,
      summary: assetSummary || ARTIFACT_UNAVAILABLE_TEXT,
      platformLabel: asset.platformLabel,
      status: reviewState?.status || 'pending_review',
      contentType: asset.contentType,
      previewUrl: asset.thumbnailUrl || asset.previewUrl,
      fullPreviewUrl: asset.previewUrl || asset.thumbnailUrl,
      destinationUrl: asset.destinationUrl,
      notes: detailLines,
      latestNote: reviewState?.latestNote || null,
      history: stageHistory(record.status_history, 'creative', asset.id),
    };
  }));
}

function creativeReviewStatus(
  assets: MarketingCreativeAssetReviewPayload[],
): MarketingReviewStatus {
  if (assets.some((asset) => asset.status === 'changes_requested')) {
    return 'changes_requested';
  }
  if (assets.some((asset) => asset.status === 'rejected')) {
    return 'rejected';
  }
  if (assets.length > 0 && assets.every((asset) => asset.status === 'approved')) {
    return 'approved';
  }
  return assets.length > 0 ? 'pending_review' : 'not_ready';
}

async function buildCreativeReview(
  runtimeDoc: SocialContentJobRuntimeDocument,
  record: SocialContentWorkspaceRecord,
  dashboard: MarketingDashboardSocialContentJobContent,
  productionPreview: Record<string, unknown> | null,
  publishBlockedReason: string | null,
  counts: { approved: number; pending: number; rejected: number },
  facts: MarketingJobFacts,
): Promise<MarketingCreativeReviewPayload | null> {
  const assets = await buildCreativeAssets(runtimeDoc, record, dashboard, productionPreview, facts);
  if (assets.length === 0) {
    return null;
  }

  return {
    status: creativeReviewStatus(assets),
    title: 'Creative Review',
    summary: 'Review every launch asset in full before publish can be unlocked.',
    latestNote: record.stage_reviews.creative.latestNote,
    approvalComplete: counts.pending === 0 && counts.rejected === 0,
    approvedCount: counts.approved,
    pendingCount: counts.pending,
    rejectedCount: counts.rejected,
    publishBlockedReason,
    assets,
    history: stageHistory(record.status_history, 'creative'),
  };
}

function ensureReviewReadyState(record: SocialContentWorkspaceRecord, stage: MarketingReviewStageKey): boolean {
  const current = record.stage_reviews[stage];
  if (current.status !== 'not_ready') {
    return false;
  }
  record.stage_reviews[stage] = {
    ...current,
    status: 'pending_review',
  };
  return true;
}

function ensureCreativeAssetReadyState(record: SocialContentWorkspaceRecord, assetIds: string[]): boolean {
  let changed = false;
  for (const assetId of assetIds) {
    if (!record.creative_asset_reviews[assetId]) {
      record.creative_asset_reviews[assetId] = {
        assetId,
        status: 'pending_review',
        latestNote: null,
        updatedAt: null,
      };
      changed = true;
    }
  }
  return changed;
}

function isAutoApprovableReviewStatus(status: MarketingReviewStatus): boolean {
  return status === 'not_ready' || status === 'pending_review';
}

function syncWorkspaceReviewsFromRuntime(
  record: SocialContentWorkspaceRecord,
  runtimeDoc: SocialContentJobRuntimeDocument,
  creativeAssetIds: string[],
  input: {
    hasRealBrandArtifacts: boolean;
    allowBrandAutoApproval: boolean;
  },
): boolean {
  const updatedAt = new Date().toISOString();
  let changed = false;

  const brandProgressed =
    runtimeDoc.current_stage !== 'research' ||
    runtimeDoc.stages.strategy.status !== 'not_started' ||
    runtimeDoc.stages.production.status !== 'not_started' ||
    runtimeDoc.stages.publish.status !== 'not_started';
  const strategyProgressed =
    runtimeDoc.current_stage === 'production' ||
    runtimeDoc.current_stage === 'publish' ||
    runtimeDoc.stages.production.status !== 'not_started' ||
    runtimeDoc.stages.publish.status !== 'not_started';
  const creativeProgressed =
    runtimeDoc.state === 'completed' ||
    runtimeDoc.stages.publish.status === 'in_progress' ||
    runtimeDoc.stages.publish.status === 'completed' ||
    runtimeDoc.stages.publish.status === 'failed';

  const maybeApproveStage = (stage: MarketingReviewStageKey, shouldApprove: boolean) => {
    if (!shouldApprove) {
      return;
    }
    const current = record.stage_reviews[stage];
    if (!isAutoApprovableReviewStatus(current.status)) {
      return;
    }
    record.stage_reviews[stage] = {
      ...current,
      status: 'approved',
      updatedAt: current.updatedAt || updatedAt,
    };
    changed = true;
  };

  maybeApproveStage('brand', input.hasRealBrandArtifacts && input.allowBrandAutoApproval && brandProgressed);
  maybeApproveStage('strategy', strategyProgressed);
  maybeApproveStage('creative', creativeProgressed && creativeAssetIds.length > 0);

  if (creativeProgressed) {
    for (const assetId of creativeAssetIds) {
      const current = record.creative_asset_reviews[assetId];
      if (current && !isAutoApprovableReviewStatus(current.status)) {
        continue;
      }
      record.creative_asset_reviews[assetId] = {
        assetId,
        status: 'approved',
        latestNote: current?.latestNote || null,
        updatedAt: current?.updatedAt || updatedAt,
      };
      changed = true;
    }
  }

  return changed;
}

// SELECT_PRODUCTION_CREATIVE_ASSETS_SQL, ProductionCreativeAssetRow, and
// queryProductionCreativeAssets are imported from ./production-assets-query
// (moved there to avoid a circular import with dashboard-content.ts).

export type BuildSocialContentWorkspaceViewOptions = {
  /**
   * Reuse an already-loaded runtime doc instead of re-reading it from disk.
   * Hot paths (the social content list fan-out) load the doc once and thread it
   * through the status build and this view build to avoid redundant reads.
   */
  runtimeDoc?: SocialContentJobRuntimeDocument | null;
};

export async function buildSocialContentWorkspaceView(
  jobId: string,
  options: BuildSocialContentWorkspaceViewOptions = {},
): Promise<SocialContentWorkspaceView> {
  const runtimeDoc =
    options.runtimeDoc !== undefined ? options.runtimeDoc : await loadSocialContentJobRuntime(jobId);
  if (!runtimeDoc) {
    return {
      jobId,
      tenantId: null,
      socialContentBrief: null,
      workflowState: 'draft',
      statusHistory: [],
      brandReview: null,
      strategyReview: null,
      creativeReview: null,
      publishBlockedReason: null,
      dashboard: {
        post: null,
        posts: [],
        assets: [],
        publishItems: [],
        calendarEvents: [],
        statuses: emptyStatusSummary(),
      },
    };
  }

  const record = await ensureSocialContentWorkspaceRecord({
    jobId,
    tenantId: runtimeDoc.tenant_id,
    payload: recordValue(runtimeDoc.inputs.request) || {},
  });
  const facts = createSocialContentJobFacts(runtimeDoc, null);
  const rawDashboard = buildSocialContentDashboardProjection(
    runtimeDoc,
    // Pin the dashboard reference date to the job's created_at. Otherwise the
    // base dashboard's derived (no-explicit-startsAt) calendar events anchor to
    // wall-clock `new Date()`, so the SAME job's view.dashboard drifts day-over-
    // day with zero state change. Pinning makes view.dashboard a pure function
    // of state — required so the persisted dashboard_list_projection snapshot
    // stays byte-identical to a later rebuild (and aligns with the projection
    // layer, which already anchors its own calendar events to created_at).
    //
    // GUARD the parse exactly like the rest of the codebase (dashboard-projection
    // startsAt(), jobs-status weeklyWindowStart()): loadSocialContentJobRuntime
    // never validates created_at, so a legacy/hand-edited/partial doc can carry a
    // missing or malformed value. An unguarded `new Date(bad)` is an Invalid Date
    // that throws RangeError at .toISOString() downstream and, via processConcurrent
    // re-throw, 500s the WHOLE tenant list/dashboard. Fall back to wall-clock.
    await getMarketingDashboardSocialContentJobContent(jobId, {
      referenceDate: (() => {
        const parsed = Date.parse(runtimeDoc.created_at);
        return Number.isFinite(parsed) ? new Date(parsed) : new Date();
      })(),
    }),
    { realPublishedPostCount: await countPublishedPostsForJob(runtimeDoc.tenant_id, runtimeDoc.job_id) },
  );
  const payloads = await loadStagePayloadBundle(runtimeDoc, facts);
  const realBrandArtifactsReady = hasRealBrandArtifacts(payloads);
  const hasUploadedBrandAssets = uploadedBrandAssets(record);
  const brandReviewRenderable = realBrandArtifactsReady || hasUploadedBrandAssets;
  const brandWorkflowReady = realBrandArtifactsReady;
  const strategyReady =
    !!payloads.socialContentPlanner ||
    !!payloads.strategyPreview ||
    !!payloads.proposalMarkdown;
  const creativeAssetIds = rawDashboard.assets
    .filter(
      (asset) =>
        ['landing_page', 'image_ad', 'script', 'copy'].includes(asset.type) &&
        (asset.relatedPublishItemIds.length === 0 || asset.provenance.sourceKind === 'creative_output'),
    )
    .map((asset) => asset.id);

  let changed = false;
  let brandReviewResetToPending = false;
  if (brandReviewRenderable) {
    const brandReviewState = syncBrandReviewEvidenceState(record, {
      brandReviewRenderable,
      hasRealBrandArtifacts: realBrandArtifactsReady,
    });
    changed = brandReviewState.changed || changed;
    brandReviewResetToPending = brandReviewState.resetToPending;
  }
  if (strategyReady) {
    changed = ensureReviewReadyState(record, 'strategy') || changed;
  }
  if (creativeAssetIds.length > 0) {
    changed = ensureReviewReadyState(record, 'creative') || changed;
    changed = ensureCreativeAssetReadyState(record, creativeAssetIds) || changed;
  }
  changed = syncWorkspaceReviewsFromRuntime(record, runtimeDoc, creativeAssetIds, {
    hasRealBrandArtifacts: realBrandArtifactsReady,
    allowBrandAutoApproval: !brandReviewResetToPending,
  }) || changed;
  if (changed) {
    saveSocialContentWorkspaceRecord(record);
  }

  const workflowResolution = syncSocialContentWorkflowState(record, {
    brandWorkflowReady,
    strategyReviewReady: strategyReady,
    creativeReviewReady: creativeAssetIds.length > 0,
    creativeAssetIds,
    publishReadySignal:
      rawDashboard.publishItems.length > 0 &&
      (rawDashboard.statuses.countsByStatus.ready_to_publish > 0 ||
        rawDashboard.statuses.countsByStatus.published_to_meta_paused > 0 ||
        rawDashboard.statuses.countsByStatus.scheduled > 0 ||
        rawDashboard.statuses.countsByStatus.live > 0),
    publishedSignal:
      rawDashboard.statuses.countsByStatus.published_to_meta_paused > 0 ||
      rawDashboard.statuses.countsByStatus.scheduled > 0 ||
      rawDashboard.statuses.countsByStatus.live > 0,
    completedSignal: runtimeDoc.state === 'completed',
  });

  const dashboard = withGatedDashboardStatus(rawDashboard, workflowResolution.workflowState);
  const brandReview = brandReviewRenderable ? await buildBrandReview(runtimeDoc, record, payloads, facts) : null;
  const strategyReview = strategyReady ? await buildStrategyReview(runtimeDoc, record, payloads, facts) : null;
  let creativeReview = await buildCreativeReview(
    runtimeDoc,
    record,
    dashboard,
    payloads.productionPreview,
    workflowResolution.publishBlockedReason,
    {
      approved: workflowResolution.creativeApprovedCount,
      pending: workflowResolution.creativePendingCount,
      rejected: workflowResolution.creativeRejectedCount,
    },
    facts,
  );

  // Merge in production creative_assets rows from the DB that were ingested by
  // ingestProductionCreativeAssetsToDb (hermes-callbacks.ts, production-completed
  // branch). The dashboard content pipeline does not read creative_assets directly,
  // so without this merge the workspace view returns empty assets even when the
  // DB has rows for completed Hermes image generation.
  const dbProductionAssets = await queryProductionCreativeAssets(runtimeDoc.tenant_id, jobId);
  if (dbProductionAssets.length > 0) {
    const existingAssetIds = new Set(creativeReview?.assets.map((a) => a.assetId) ?? []);
    const newDbAssets: import('@/lib/api/marketing').MarketingCreativeAssetReviewPayload[] = [];
    for (const row of dbProductionAssets) {
      const assetId = row.source_asset_id ?? row.id;
      if (existingAssetIds.has(assetId)) continue;
      const isVideo = row.media_type === 'video';
      newDbAssets.push({
        reviewId: `${jobId}::creative:${assetId}`,
        reviewType: 'creative' as const,
        assetId,
        title: isVideo ? 'Generated Video' : 'Generated Image',
        summary: 'Production creative generated by Hermes.',
        platformLabel: 'Meta',
        status: 'approved' as const,
        contentType: isVideo ? 'video/mp4' : 'image/png',
        previewUrl: row.served_asset_ref,
        fullPreviewUrl: row.served_asset_ref,
        posterUrl: null,
        destinationUrl: null,
        notes: [],
        latestNote: null,
        history: [],
      });
    }
    if (newDbAssets.length > 0) {
      if (creativeReview) {
        creativeReview = {
          ...creativeReview,
          assets: [...creativeReview.assets, ...newDbAssets],
        };
      } else {
        creativeReview = {
          status: 'approved' as const,
          title: 'Creative Review',
          summary: 'Review every launch asset in full before publish can be unlocked.',
          latestNote: null,
          approvalComplete: true,
          approvedCount: newDbAssets.length,
          pendingCount: 0,
          rejectedCount: 0,
          publishBlockedReason: workflowResolution.publishBlockedReason,
          assets: newDbAssets,
          history: [],
        };
      }
    }
  }

  console.info('[marketing-hydration]', {
    event: 'workspace-view',
    jobId,
    tenantId: runtimeDoc.tenant_id,
    brandReviewSource: brandReview
      ? payloads.sources.websiteAnalysis !== 'none'
        ? 'websiteAnalysis'
        : payloads.sources.brandProfile !== 'none'
          ? 'brandProfile'
          : hasUploadedBrandAssets
            ? 'brief_assets'
            : 'none'
      : 'none',
    brandReviewReason: brandReview
      ? realBrandArtifactsReady
        ? 'hydrated'
        : 'upload_only'
      : 'no_real_brand_artifacts',
    strategyReviewSource: strategyReview
      ? payloads.sources.strategyPreview !== 'none'
        ? payloads.sources.strategyPreview
        : payloads.sources.socialContentPlanner !== 'none'
          ? payloads.sources.socialContentPlanner
          : payloads.sources.proposalMarkdown
      : 'none',
    strategyReviewReason: strategyReview ? 'hydrated' : 'no_real_strategy_artifacts',
    creativeReviewSource: creativeReview ? 'dashboard_creative_assets' : 'none',
    creativeReviewReason: creativeReview ? 'hydrated' : 'no_real_creative_assets',
    dashboardCountsSource:
      rawDashboard.posts.length > 0 || rawDashboard.assets.length > 0 || rawDashboard.publishItems.length > 0
        ? 'runtime_dashboard_content'
        : 'none',
    dashboardCounts: dashboard.post?.counts || null,
  });

  return {
    jobId,
    tenantId: runtimeDoc.tenant_id,
    socialContentBrief: buildSocialContentBrief(record),
    workflowState: workflowResolution.workflowState,
    statusHistory: record.status_history.map(postStatusHistoryEntry),
    brandReview,
    strategyReview,
    creativeReview,
    publishBlockedReason: workflowResolution.publishBlockedReason,
    dashboard,
  };
}

function mergeDashboardContent(items: MarketingDashboardSocialContentJobContent[]): MarketingDashboardContent {
  const statuses = emptyStatusSummary();
  const merged: MarketingDashboardContent = {
    socialContentJobs: [],
    posts: [],
    assets: [],
    publishItems: [],
    calendarEvents: [],
    statuses,
  };

  for (const item of items) {
    if (item.post) {
      merged.socialContentJobs.push(item.post);
    }
    merged.posts.push(...item.posts);
    merged.assets.push(...item.assets);
    merged.publishItems.push(...item.publishItems);
    merged.calendarEvents.push(...item.calendarEvents);
    for (const status of Object.keys(statuses.countsByStatus) as MarketingDashboardItemStatus[]) {
      statuses.countsByStatus[status] += item.statuses.countsByStatus[status];
    }
  }

  merged.socialContentJobs.sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || '');
    const rightUpdated = Date.parse(right.updatedAt || '');
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0);
  });
  merged.calendarEvents.sort((left, right) => left.startsAt.localeCompare(right.startsAt));

  return merged;
}

function postIdentity(post: MarketingDashboardSocialContentJob | null, jobId: string): string {
  if (!post) {
    return `job::${jobId}`;
  }
  return post.externalPostId || post.name || `job::${jobId}`;
}

export async function getWorkflowAwareDashboardContentForTenant(tenantId: string): Promise<MarketingDashboardContent> {
  const jobIds = await listSocialContentJobIdsForTenant(tenantId);

  // FAST PATH: read each job's denormalized dashboard projection (post + the
  // posts/assets/publishItems/calendarEvents/statuses arrays) O(1) from the
  // workspace record and skip the expensive buildSocialContentWorkspaceView
  // (loadStagePayloadBundle). The projection IS view.dashboard (post +
  // listRow.dashboard arrays), persisted byte-identically at every write site.
  // Legacy / never-computed jobs fall back to the full build (the campaign-list
  // endpoint + the write sites persist the projection, so those jobs become
  // O(1) on a subsequent load). Bounded concurrency 4 (guardrail #1);
  // processConcurrent preserves input order so dedup stays first-wins in jobId
  // order — byte-identical selection to the old loop.
  const built = await processConcurrent(
    jobIds,
    async (jobId): Promise<MarketingDashboardSocialContentJobContent> => {
      const runtimeDoc = await loadSocialContentJobRuntime(jobId);
      const projection = loadSocialContentWorkspaceRecord(jobId)?.dashboard_list_projection;
      // Same FRESHNESS GUARD as the campaign-list path: serve the projection O(1)
      // only when its baked sourceUpdatedAt matches the current runtimeDoc.updated_at.
      // A stale projection (doc mutated since — reaper/orchestrator) or an absent
      // one falls through to the rebuild so this endpoint never serves a stale row.
      if (projection && runtimeDoc && projection.sourceUpdatedAt === runtimeDoc.updated_at) {
        return {
          post: projection.post,
          posts: projection.listRow.dashboard.posts,
          assets: projection.listRow.dashboard.assets,
          publishItems: projection.listRow.dashboard.publishItems,
          calendarEvents: projection.listRow.dashboard.calendarEvents,
          statuses: projection.listRow.dashboard.statuses,
        };
      }
      // Rebuild (correct value). Then self-heal-persist so this job is O(1) next
      // time even if it's only ever loaded through this endpoint. Dynamic import
      // of the recompute helper avoids a static workspace-views<->runtime-views
      // cycle; persistence is best-effort and never blocks the response. Read the
      // projection back so the served shape is identical to the fast path.
      if (runtimeDoc) {
        try {
          const { recomputeAndPersistPendingApprovalCount } = await import('./runtime-views');
          await recomputeAndPersistPendingApprovalCount(jobId, { runtimeDoc });
          const healed = loadSocialContentWorkspaceRecord(jobId)?.dashboard_list_projection;
          if (healed && healed.sourceUpdatedAt === runtimeDoc.updated_at) {
            return {
              post: healed.post,
              posts: healed.listRow.dashboard.posts,
              assets: healed.listRow.dashboard.assets,
              publishItems: healed.listRow.dashboard.publishItems,
              calendarEvents: healed.listRow.dashboard.calendarEvents,
              statuses: healed.listRow.dashboard.statuses,
            };
          }
        } catch {
          // fall through to a direct build below
        }
      }
      return (await buildSocialContentWorkspaceView(jobId, { runtimeDoc })).dashboard;
    },
    4,
  );

  const items: MarketingDashboardSocialContentJobContent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < jobIds.length; i++) {
    const item = built[i];
    const key = postIdentity(item.post, jobIds[i]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(item);
  }

  const merged = mergeDashboardContent(items);
  // qa-defect #599 re-fix: this endpoint serves the PERSISTED
  // dashboard_list_projection assets O(1) (fast path above) — blobs baked weeks
  // ago when the Hermes-cache files still existed. The build-time wrap in
  // `createAssets` can never reach those stale rows, so basename-addressed
  // previews whose files the cache has since evicted are emitted here as dead
  // `<img>` URLs that 404. Null them at read time so the UI placeholder fires;
  // live/non-hermes/id-addressed previews pass through byte-identical.
  return {
    ...merged,
    assets: sanitizeAssetPreviewsForMissingMedia(merged.assets),
  };
}
