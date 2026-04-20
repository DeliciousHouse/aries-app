import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  MarketingCampaignBrief,
  MarketingCampaignStatusHistoryEntry,
  MarketingCreativeAssetReviewPayload,
  MarketingCreativeReviewPayload,
  MarketingDashboardCampaign,
  MarketingDashboardCampaignCompatibilityStatus,
  MarketingDashboardCampaignContent,
  MarketingDashboardContent,
  MarketingDashboardItemStatus,
  MarketingReviewAttachment,
  MarketingReviewSection,
  MarketingStageReviewPayload,
} from '@/lib/api/marketing';

import { buildMarketingAssetLinks, findMarketingAsset } from './asset-library';
import {
  collectProductionReviewArtifacts,
  collectStrategyReviewArtifacts,
} from './artifact-collector';
import { recordMatchesCurrentSource, sourceFingerprintFromRecord } from './brand-identity';
import { sanitizeBrandKitSummaryText } from './brand-kit';
import { getMarketingDashboardCampaignContent } from './dashboard-content';
import { loadMarketingJobRuntime, listMarketingJobIdsForTenant, type MarketingJobRuntimeDocument } from './runtime-state';
import {
  ARTIFACT_INCOMPLETE_TEXT,
  ARTIFACT_UNAVAILABLE_TEXT,
  normalizeArtifactText,
  readLandingPageArtifactDetails,
  readScriptArtifactDetails,
} from './real-artifacts';
import { readMarketingStageStepPayload } from './stage-artifact-resolution';
import {
  ensureCampaignWorkspaceRecord,
  marketingWorkspaceAssetUrl,
  saveCampaignWorkspaceRecord,
  syncCampaignWorkflowState,
  type CampaignStatusHistoryEntry,
  type CampaignStageReviewEvidenceKind,
  type CampaignWorkspaceRecord,
  type MarketingCampaignWorkflowState,
  type MarketingReviewStageKey,
  type MarketingReviewStatus,
} from './workspace-store';
import { loadValidatedMarketingProfileDocs, loadValidatedMarketingProfileSnapshot } from './validated-profile-store';

export type CampaignWorkspaceView = {
  jobId: string;
  tenantId: string | null;
  campaignBrief: MarketingCampaignBrief | null;
  workflowState: MarketingCampaignWorkflowState;
  statusHistory: MarketingCampaignStatusHistoryEntry[];
  brandReview: MarketingStageReviewPayload | null;
  strategyReview: MarketingStageReviewPayload | null;
  creativeReview: MarketingCreativeReviewPayload | null;
  publishBlockedReason: string | null;
  dashboard: MarketingDashboardCampaignContent;
};

type StagePayloadBundle = {
  websiteAnalysis: Record<string, unknown> | null;
  brandProfile: Record<string, unknown> | null;
  campaignPlanner: Record<string, unknown> | null;
  strategyPreview: Record<string, unknown> | null;
  productionPreview: Record<string, unknown> | null;
  brandBibleText: string | null;
  designSystemCss: string | null;
  proposalMarkdown: string | null;
  sources: {
    websiteAnalysis: 'runtime' | 'artifact_fallback' | 'none';
    brandProfile: 'runtime' | 'artifact_fallback' | 'none';
    campaignPlanner: 'runtime' | 'artifact_fallback' | 'none';
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

function readJsonIfExists(filePath: string | null | undefined): Record<string, unknown> | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    return recordValue(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

function readTextIfExists(filePath: string | null | undefined): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const text = readFileSync(filePath, 'utf8').trim();
    return text || null;
  } catch {
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

function currentSourceUrl(runtimeDoc: MarketingJobRuntimeDocument): string | null {
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

function campaignStatusHistoryEntry(entry: CampaignStatusHistoryEntry): MarketingCampaignStatusHistoryEntry {
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

function strategyChannelBlock(channel: Record<string, unknown>): string {
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
    return '';
  }

  return [channelName, ...detailBlocks].join('\n\n');
}

function workflowCampaignStatus(workflowState: MarketingCampaignWorkflowState): MarketingDashboardItemStatus {
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
  workflowState: MarketingCampaignWorkflowState,
  campaignStatus: MarketingDashboardItemStatus,
): MarketingDashboardCampaignCompatibilityStatus {
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
      return campaignStatus === 'scheduled' ? 'scheduled' : campaignStatus === 'live' ? 'live' : 'approved';
    default:
      return 'draft';
  }
}

function gatedItemStatus(
  status: MarketingDashboardItemStatus,
  workflowState: MarketingCampaignWorkflowState,
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
  dashboard: MarketingDashboardCampaignContent,
  workflowState: MarketingCampaignWorkflowState,
): MarketingDashboardCampaignContent {
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

  const campaign = dashboard.campaign
    ? ({
        ...dashboard.campaign,
        approvalRequired:
          workflowState === 'revisions_requested'
            ? false
            : dashboard.campaign.approvalRequired,
        approvalActionHref:
          workflowState === 'revisions_requested'
            ? undefined
            : dashboard.campaign.approvalActionHref,
        status:
          workflowState === 'published'
            ? gatedItemStatus(dashboard.campaign.status, workflowState)
            : workflowCampaignStatus(workflowState),
        compatibilityStatus: workflowCompatibilityStatus(
          workflowState,
          workflowState === 'published'
            ? gatedItemStatus(dashboard.campaign.status, workflowState)
            : workflowCampaignStatus(workflowState),
        ),
        counts: {
          ...dashboard.campaign.counts,
          ready: [...posts, ...publishItems].filter((item) => item.status === 'ready').length,
          readyToPublish: [...posts, ...publishItems].filter((item) => item.status === 'ready_to_publish').length,
          pausedMetaAds: [...posts, ...publishItems].filter((item) => item.status === 'published_to_meta_paused').length,
          scheduled: [...posts, ...publishItems].filter((item) => item.status === 'scheduled').length,
          live: [...posts, ...publishItems].filter((item) => item.status === 'live').length,
        },
      } satisfies MarketingDashboardCampaign)
    : null;

  return {
    campaign,
    posts,
    assets,
    publishItems,
    calendarEvents,
    statuses,
  };
}

function buildCampaignBrief(record: CampaignWorkspaceRecord): MarketingCampaignBrief {
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

function loadStagePayloadBundle(runtimeDoc: MarketingJobRuntimeDocument): StagePayloadBundle {
  const sourceUrl = currentSourceUrl(runtimeDoc);
  const validatedDocs = loadValidatedMarketingProfileDocs(runtimeDoc.tenant_id, {
    currentSourceUrl: sourceUrl,
  });
  const strategyOutputs = recordValue(runtimeDoc.stages.strategy.outputs) || {};
  const productionOutputs = recordValue(runtimeDoc.stages.production.outputs) || {};
  const strategyFallback = collectStrategyReviewArtifacts(
    runtimeDoc.stages.strategy.primary_output || { run_id: runtimeDoc.stages.strategy.run_id },
    runtimeDoc,
  );
  const productionFallback = collectProductionReviewArtifacts(
    runtimeDoc.stages.production.primary_output || { run_id: runtimeDoc.stages.production.run_id },
    runtimeDoc,
  );

  const runtimeWebsiteAnalysisPath = stringValue(strategyOutputs.validated_website_analysis_path) || stringValue(strategyOutputs.website_brand_analysis_path);
  const runtimeBrandProfilePath =
    stringValue(strategyOutputs.validated_brand_profile_path) ||
    stringValue(strategyOutputs.brand_profile_path);
  const runtimeCampaignPlannerPath = stringValue(strategyOutputs.campaign_planner_path);
  const runtimeStrategyPreviewPath = stringValue(strategyOutputs.strategy_review_path);
  const runtimeProductionPreviewPath = stringValue(productionOutputs.production_review_path);

  const fallbackWebsiteAnalysisPath = stringValue(strategyFallback.outputs.website_brand_analysis_path);
  const fallbackBrandProfilePath = stringValue(strategyFallback.outputs.validated_brand_profile_path);
  const fallbackCampaignPlannerPath = stringValue(strategyFallback.outputs.campaign_planner_path);
  const fallbackStrategyPreviewPath = stringValue(strategyFallback.outputs.strategy_review_path);
  const fallbackProductionPreviewPath = stringValue(productionFallback.outputs.production_review_path);

  const rawRuntimeRunWebsiteAnalysis =
    recordValue(strategyOutputs.website) ||
    readJsonIfExists(runtimeWebsiteAnalysisPath);
  const runtimeRunWebsiteAnalysis =
    (recordMatchesCurrentSource(recordValue(strategyOutputs.website), sourceUrl) ? recordValue(strategyOutputs.website) : null) ||
    (recordMatchesCurrentSource(readJsonIfExists(runtimeWebsiteAnalysisPath), sourceUrl)
      ? readJsonIfExists(runtimeWebsiteAnalysisPath)
      : null);
  const runtimeWebsiteAnalysis =
    runtimeRunWebsiteAnalysis ||
    validatedDocs.websiteAnalysis;
  const runtimeBrandProfile =
    (recordMatchesCurrentSource(recordValue(strategyOutputs.brand_profile), sourceUrl)
      ? recordValue(strategyOutputs.brand_profile)
      : null) ||
    (recordMatchesCurrentSource(readJsonIfExists(runtimeBrandProfilePath), sourceUrl)
      ? readJsonIfExists(runtimeBrandProfilePath)
      : null);
  const runtimeCampaignPlanner = sourceMatchedStrategyPayload(
    recordValue(strategyOutputs.planner) || readJsonIfExists(runtimeCampaignPlannerPath),
    sourceUrl,
    runtimeRunWebsiteAnalysis,
    !!rawRuntimeRunWebsiteAnalysis,
  );
  const runtimeStrategyPreview = sourceMatchedStrategyPayload(
    recordValue(strategyOutputs.review) || readJsonIfExists(runtimeStrategyPreviewPath),
    sourceUrl,
    runtimeRunWebsiteAnalysis,
    !!rawRuntimeRunWebsiteAnalysis,
  );
  const runtimeProductionPreview = recordValue(productionOutputs.review) ||
    readJsonIfExists(runtimeProductionPreviewPath);

  const rawFallbackRunWebsiteAnalysis =
    readJsonIfExists(fallbackWebsiteAnalysisPath) ||
    recordValue(strategyFallback.outputs.website);
  const fallbackRunWebsiteAnalysis =
    (recordMatchesCurrentSource(readJsonIfExists(fallbackWebsiteAnalysisPath), sourceUrl)
      ? readJsonIfExists(fallbackWebsiteAnalysisPath)
      : null) ||
    (recordMatchesCurrentSource(recordValue(strategyFallback.outputs.website), sourceUrl)
      ? recordValue(strategyFallback.outputs.website)
      : null);
  const websiteAnalysis = runtimeWebsiteAnalysis || fallbackRunWebsiteAnalysis;
  const brandProfile = runtimeBrandProfile ||
    validatedDocs.brandProfile ||
    (recordMatchesCurrentSource(readJsonIfExists(fallbackBrandProfilePath), sourceUrl)
      ? readJsonIfExists(fallbackBrandProfilePath)
      : null) ||
    (recordMatchesCurrentSource(recordValue(strategyFallback.outputs.brand_profile), sourceUrl)
      ? recordValue(strategyFallback.outputs.brand_profile)
      : null);
  const campaignPlanner = runtimeCampaignPlanner ||
    sourceMatchedStrategyPayload(
      readJsonIfExists(fallbackCampaignPlannerPath) || recordValue(strategyFallback.outputs.planner),
      sourceUrl,
      fallbackRunWebsiteAnalysis,
      !!rawFallbackRunWebsiteAnalysis,
    );
  const strategyPreview = runtimeStrategyPreview ||
    sourceMatchedStrategyPayload(
      readJsonIfExists(fallbackStrategyPreviewPath) || recordValue(strategyFallback.outputs.review),
      sourceUrl,
      fallbackRunWebsiteAnalysis,
      !!rawFallbackRunWebsiteAnalysis,
    );
  const productionPreview = runtimeProductionPreview ||
    readJsonIfExists(fallbackProductionPreviewPath) ||
    recordValue(productionFallback.outputs.review);

  const hasCurrentSourceBrandArtifacts = !!(websiteAnalysis || brandProfile);
  const hasCurrentSourceStrategyArtifacts = !!(campaignPlanner || strategyPreview || hasCurrentSourceBrandArtifacts);

  const brandBibleAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'brand-bible-markdown');
  const designSystemAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'brand-design-system');
  const proposalMarkdownAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'strategy-proposal-markdown');

  return {
    websiteAnalysis,
    brandProfile,
    campaignPlanner,
    strategyPreview,
    productionPreview,
    brandBibleText: hasCurrentSourceBrandArtifacts
      ? readTextIfExists(
          brandBibleAsset?.filePath || stringValue(recordValue(websiteAnalysis?.artifacts)?.brand_bible_markdown_path),
        )
      : null,
    designSystemCss: hasCurrentSourceBrandArtifacts
      ? readTextIfExists(
          designSystemAsset?.filePath || stringValue(recordValue(websiteAnalysis?.artifacts)?.design_system_css_path),
        )
      : null,
    proposalMarkdown: hasCurrentSourceStrategyArtifacts ? readTextIfExists(proposalMarkdownAsset?.filePath) : null,
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
      campaignPlanner: runtimeCampaignPlanner
        ? 'runtime'
        : campaignPlanner
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

function uploadedBrandAssets(record: CampaignWorkspaceRecord): boolean {
  return record.brief.brandAssets.length > 0;
}

function syncBrandReviewEvidenceState(
  record: CampaignWorkspaceRecord,
  input: {
    brandReviewRenderable: boolean;
    hasRealBrandArtifacts: boolean;
  },
): { changed: boolean; resetToPending: boolean } {
  if (!input.brandReviewRenderable) {
    return { changed: false, resetToPending: false };
  }

  const current = record.stage_reviews.brand;
  const nextEvidenceKind: CampaignStageReviewEvidenceKind = input.hasRealBrandArtifacts
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
  history: CampaignStatusHistoryEntry[],
  stage: MarketingReviewStageKey,
  assetId?: string,
): MarketingCampaignStatusHistoryEntry[] {
  return history
    .filter((entry) => {
      if (assetId) {
        return entry.assetId === assetId || entry.type === 'state_changed';
      }
      return entry.stage === stage || entry.type === 'state_changed';
    })
    .map(campaignStatusHistoryEntry);
}

function buildBrandReview(
  runtimeDoc: MarketingJobRuntimeDocument,
  record: CampaignWorkspaceRecord,
  payloads: StagePayloadBundle,
): MarketingStageReviewPayload | null {
  const hasGeneratedBrandArtifacts = hasRealBrandArtifacts(payloads);
  const hasUploadedBrandAssets = uploadedBrandAssets(record);
  if (!hasGeneratedBrandArtifacts && !hasUploadedBrandAssets) {
    return null;
  }

  const validatedProfile = loadValidatedMarketingProfileSnapshot(runtimeDoc.tenant_id, {
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
  const assetLinks = new Map(buildMarketingAssetLinks(runtimeDoc.job_id, runtimeDoc).map((asset) => [asset.id, asset] as const));

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

function buildStrategyReview(
  runtimeDoc: MarketingJobRuntimeDocument,
  record: CampaignWorkspaceRecord,
  payloads: StagePayloadBundle,
): MarketingStageReviewPayload | null {
  const campaignPlan = recordValue(payloads.campaignPlanner?.campaign_plan);
  const reviewPacket = recordValue(payloads.strategyPreview?.review_packet);
  const productionBrief = recordValue(recordValue(payloads.productionPreview?.production_handoff)?.production_brief);
  if (!campaignPlan && !reviewPacket && !productionBrief && !payloads.proposalMarkdown) {
    return null;
  }
  const attachments: MarketingReviewAttachment[] = [];
  const assetLinks = new Map(buildMarketingAssetLinks(runtimeDoc.job_id, runtimeDoc).map((asset) => [asset.id, asset] as const));

  for (const assetId of ['strategy-campaign-planner', 'strategy-review-preview', 'strategy-proposal-markdown', 'strategy-proposal-html'] as const) {
    const asset = assetLinks.get(assetId);
    if (asset) {
      attachments.push(marketingAttachment(asset.id, asset.label, asset.url, asset.contentType, assetId.includes('html') ? 'preview' : 'document'));
    }
  }

  const channelPlans = (
    recordArray(campaignPlan?.channel_plans).length > 0
      ? recordArray(campaignPlan?.channel_plans)
      : recordArray(productionBrief?.channel_priorities)
  )
    .map(strategyChannelBlock)
    .filter(Boolean);
  const scopedChannels = stringArray(reviewPacket?.channels_in_scope);
  const sections: MarketingReviewSection[] = [
    {
      id: 'campaign-summary',
      title: 'Campaign proposal',
      body: labeledBlock([
        ['Campaign name', stringValue(campaignPlan?.campaign_name, stringValue(reviewPacket?.campaign_name))],
        ['Objective', stringValue(campaignPlan?.objective, stringValue(reviewPacket?.objective))],
        ['Core message', stringValue(campaignPlan?.core_message, stringValue(reviewPacket?.core_message))],
        ['Audience', stringValue(campaignPlan?.audience)],
        ['Offer', stringValue(campaignPlan?.offer)],
        ['Primary CTA', stringValue(campaignPlan?.primary_cta)],
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
    summary:
      stringValue(campaignPlan?.core_message, stringValue(reviewPacket?.objective)) ||
      'Review the campaign proposal before creative production is treated as approved.',
    notePlaceholder: 'Call out strategic changes, channel shifts, or proposal edits.',
    sections: sections.filter((section) => section.body.trim().length > 0),
    attachments,
    history: stageHistory(record.status_history, 'strategy'),
    latestNote: record.stage_reviews.strategy.latestNote,
  };
}

function buildCreativeAssets(
  runtimeDoc: MarketingJobRuntimeDocument,
  record: CampaignWorkspaceRecord,
  dashboard: MarketingDashboardCampaignContent,
  productionPreview: Record<string, unknown> | null,
): MarketingCreativeAssetReviewPayload[] {
  const creativeAssets = dashboard.assets.filter(
    (asset) =>
      ['landing_page', 'image_ad', 'script', 'copy'].includes(asset.type) &&
      (asset.relatedPublishItemIds.length === 0 || asset.provenance.sourceKind === 'creative_output'),
  );
  const reviewPacket = recordValue(productionPreview?.review_packet);
  const assetPreviews = recordValue(reviewPacket?.asset_previews);
  const fallbackLanding = readLandingPageArtifactDetails({ runtimeDoc });
  const fallbackScripts = readScriptArtifactDetails({ runtimeDoc });

  let metaAdScriptsByFamily:
    | Record<string, unknown>
    | null
    | undefined;

  function getMetaAdScriptsByFamily(): Record<string, unknown> | null {
    if (metaAdScriptsByFamily !== undefined) {
      return metaAdScriptsByFamily;
    }
    const scriptwriterPayload = readMarketingStageStepPayload(runtimeDoc, 3, 'scriptwriter').payload;
    metaAdScriptsByFamily = recordValue(
      recordValue(scriptwriterPayload?.script_assets)?.meta_ad_scripts_by_family,
    );
    return metaAdScriptsByFamily;
  }

  function perFamilyHook(filePath: string | null): string | null {
    const familyId = familyIdFromImagePath(filePath);
    if (!familyId) {
      return null;
    }
    const scriptsByFamily = getMetaAdScriptsByFamily();
    if (!scriptsByFamily) {
      return null;
    }
    const entry = recordValue(scriptsByFamily[familyId]);
    return stringValue(entry?.hook) || null;
  }

  return creativeAssets.map((asset) => {
    const reviewState = record.creative_asset_reviews[asset.id];
    const resolvedAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, asset.id);
    const fileName = resolvedAsset?.filePath ? path.basename(resolvedAsset.filePath) : null;
    const isVideoScript = asset.platform === 'video' || /video|short/i.test(`${asset.id} ${asset.title}`);
    const scriptDetails = isVideoScript
      ? readScriptArtifactDetails({ shortVideoScriptPath: resolvedAsset?.filePath || null, runtimeDoc })
      : readScriptArtifactDetails({ metaScriptPath: resolvedAsset?.filePath || null, runtimeDoc });
    const landingDetails = asset.type === 'landing_page'
      ? readLandingPageArtifactDetails({ path: resolvedAsset?.filePath || null, runtimeDoc })
      : fallbackLanding;
    const detailLines: string[] = [];
    const assetSummary =
      asset.type === 'landing_page'
        ? normalizeArtifactText(landingDetails.headline) ||
          normalizeArtifactText(landingDetails.subheadline) ||
          normalizeArtifactText(stringValue(assetPreviews?.landing_page_headline))
        : asset.type === 'image_ad'
          ? normalizeArtifactText(perFamilyHook(resolvedAsset?.filePath || null)) ||
            normalizeArtifactText(scriptDetails.metaAdHook) ||
            normalizeArtifactText(fallbackScripts.metaAdHook) ||
            normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook))
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
      detailLines.push(`Ad hook: ${perFamilyHook(resolvedAsset?.filePath || null) || scriptDetails.metaAdHook || fallbackScripts.metaAdHook || normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook)) || ARTIFACT_UNAVAILABLE_TEXT}`);
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
  });
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

function buildCreativeReview(
  runtimeDoc: MarketingJobRuntimeDocument,
  record: CampaignWorkspaceRecord,
  dashboard: MarketingDashboardCampaignContent,
  productionPreview: Record<string, unknown> | null,
  publishBlockedReason: string | null,
  counts: { approved: number; pending: number; rejected: number },
): MarketingCreativeReviewPayload | null {
  const assets = buildCreativeAssets(runtimeDoc, record, dashboard, productionPreview);
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

function ensureReviewReadyState(record: CampaignWorkspaceRecord, stage: MarketingReviewStageKey): boolean {
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

function ensureCreativeAssetReadyState(record: CampaignWorkspaceRecord, assetIds: string[]): boolean {
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
  record: CampaignWorkspaceRecord,
  runtimeDoc: MarketingJobRuntimeDocument,
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

export function buildCampaignWorkspaceView(jobId: string): CampaignWorkspaceView {
  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return {
      jobId,
      tenantId: null,
      campaignBrief: null,
      workflowState: 'draft',
      statusHistory: [],
      brandReview: null,
      strategyReview: null,
      creativeReview: null,
      publishBlockedReason: null,
      dashboard: {
        campaign: null,
        posts: [],
        assets: [],
        publishItems: [],
        calendarEvents: [],
        statuses: emptyStatusSummary(),
      },
    };
  }

  const record = ensureCampaignWorkspaceRecord({
    jobId,
    tenantId: runtimeDoc.tenant_id,
    payload: recordValue(runtimeDoc.inputs.request) || {},
  });
  const rawDashboard = getMarketingDashboardCampaignContent(jobId);
  const payloads = loadStagePayloadBundle(runtimeDoc);
  const realBrandArtifactsReady = hasRealBrandArtifacts(payloads);
  const hasUploadedBrandAssets = uploadedBrandAssets(record);
  const brandReviewRenderable = realBrandArtifactsReady || hasUploadedBrandAssets;
  const brandWorkflowReady = realBrandArtifactsReady;
  const strategyReady =
    !!payloads.campaignPlanner ||
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
    saveCampaignWorkspaceRecord(record);
  }

  const workflowResolution = syncCampaignWorkflowState(record, {
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
  });

  const dashboard = withGatedDashboardStatus(rawDashboard, workflowResolution.workflowState);
  const brandReview = brandReviewRenderable ? buildBrandReview(runtimeDoc, record, payloads) : null;
  const strategyReview = strategyReady ? buildStrategyReview(runtimeDoc, record, payloads) : null;
  const creativeReview = buildCreativeReview(
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
  );

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
        : payloads.sources.campaignPlanner !== 'none'
          ? payloads.sources.campaignPlanner
          : payloads.sources.proposalMarkdown
      : 'none',
    strategyReviewReason: strategyReview ? 'hydrated' : 'no_real_strategy_artifacts',
    creativeReviewSource: creativeReview ? 'dashboard_creative_assets' : 'none',
    creativeReviewReason: creativeReview ? 'hydrated' : 'no_real_creative_assets',
    dashboardCountsSource:
      rawDashboard.posts.length > 0 || rawDashboard.assets.length > 0 || rawDashboard.publishItems.length > 0
        ? 'runtime_dashboard_content'
        : 'none',
    dashboardCounts: dashboard.campaign?.counts || null,
  });

  return {
    jobId,
    tenantId: runtimeDoc.tenant_id,
    campaignBrief: buildCampaignBrief(record),
    workflowState: workflowResolution.workflowState,
    statusHistory: record.status_history.map(campaignStatusHistoryEntry),
    brandReview,
    strategyReview,
    creativeReview,
    publishBlockedReason: workflowResolution.publishBlockedReason,
    dashboard,
  };
}

function mergeDashboardContent(items: MarketingDashboardCampaignContent[]): MarketingDashboardContent {
  const statuses = emptyStatusSummary();
  const merged: MarketingDashboardContent = {
    campaigns: [],
    posts: [],
    assets: [],
    publishItems: [],
    calendarEvents: [],
    statuses,
  };

  for (const item of items) {
    if (item.campaign) {
      merged.campaigns.push(item.campaign);
    }
    merged.posts.push(...item.posts);
    merged.assets.push(...item.assets);
    merged.publishItems.push(...item.publishItems);
    merged.calendarEvents.push(...item.calendarEvents);
    for (const status of Object.keys(statuses.countsByStatus) as MarketingDashboardItemStatus[]) {
      statuses.countsByStatus[status] += item.statuses.countsByStatus[status];
    }
  }

  merged.campaigns.sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || '');
    const rightUpdated = Date.parse(right.updatedAt || '');
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0);
  });
  merged.calendarEvents.sort((left, right) => left.startsAt.localeCompare(right.startsAt));

  return merged;
}

function campaignIdentity(campaign: MarketingDashboardCampaign | null, jobId: string): string {
  if (!campaign) {
    return `job::${jobId}`;
  }
  return campaign.externalCampaignId || campaign.name || `job::${jobId}`;
}

export function getWorkflowAwareDashboardContentForTenant(tenantId: string): MarketingDashboardContent {
  const items: MarketingDashboardCampaignContent[] = [];
  const seen = new Set<string>();

  for (const jobId of listMarketingJobIdsForTenant(tenantId)) {
    const view = buildCampaignWorkspaceView(jobId);
    const key = campaignIdentity(view.dashboard.campaign, jobId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(view.dashboard);
  }

  return mergeDashboardContent(items);
}
