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
import { getMarketingDashboardCampaignContent } from './dashboard-content';
import { loadMarketingJobRuntime, listMarketingJobIdsForTenant, type MarketingJobRuntimeDocument } from './runtime-state';
import {
  ARTIFACT_INCOMPLETE_TEXT,
  ARTIFACT_UNAVAILABLE_TEXT,
  normalizeArtifactText,
  readLandingPageArtifactDetails,
  readScriptArtifactDetails,
} from './real-artifacts';
import {
  ensureCampaignWorkspaceRecord,
  marketingWorkspaceAssetUrl,
  saveCampaignWorkspaceRecord,
  syncCampaignWorkflowState,
  type CampaignStatusHistoryEntry,
  type CampaignWorkspaceRecord,
  type MarketingCampaignWorkflowState,
  type MarketingReviewStageKey,
  type MarketingReviewStatus,
} from './workspace-store';

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
  campaignPlanner: Record<string, unknown> | null;
  strategyPreview: Record<string, unknown> | null;
  productionPreview: Record<string, unknown> | null;
  brandBibleText: string | null;
  designSystemCss: string | null;
  proposalMarkdown: string | null;
  sources: {
    websiteAnalysis: 'runtime' | 'artifact_fallback' | 'none';
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

  const runtimeWebsiteAnalysisPath = stringValue(strategyOutputs.website_brand_analysis_path);
  const runtimeCampaignPlannerPath = stringValue(strategyOutputs.campaign_planner_path);
  const runtimeStrategyPreviewPath = stringValue(strategyOutputs.strategy_review_path);
  const runtimeProductionPreviewPath = stringValue(productionOutputs.production_review_path);

  const fallbackWebsiteAnalysisPath = stringValue(strategyFallback.outputs.website_brand_analysis_path);
  const fallbackCampaignPlannerPath = stringValue(strategyFallback.outputs.campaign_planner_path);
  const fallbackStrategyPreviewPath = stringValue(strategyFallback.outputs.strategy_review_path);
  const fallbackProductionPreviewPath = stringValue(productionFallback.outputs.production_review_path);

  const runtimeWebsiteAnalysis = recordValue(strategyOutputs.website) ||
    readJsonIfExists(runtimeWebsiteAnalysisPath);
  const runtimeCampaignPlanner = recordValue(strategyOutputs.planner) ||
    readJsonIfExists(runtimeCampaignPlannerPath);
  const runtimeStrategyPreview = recordValue(strategyOutputs.review) ||
    readJsonIfExists(runtimeStrategyPreviewPath);
  const runtimeProductionPreview = recordValue(productionOutputs.review) ||
    readJsonIfExists(runtimeProductionPreviewPath);

  const websiteAnalysis = runtimeWebsiteAnalysis ||
    readJsonIfExists(fallbackWebsiteAnalysisPath) ||
    recordValue(strategyFallback.outputs.website);
  const campaignPlanner = runtimeCampaignPlanner ||
    readJsonIfExists(fallbackCampaignPlannerPath) ||
    recordValue(strategyFallback.outputs.planner);
  const strategyPreview = runtimeStrategyPreview ||
    readJsonIfExists(fallbackStrategyPreviewPath) ||
    recordValue(strategyFallback.outputs.review);
  const productionPreview = runtimeProductionPreview ||
    readJsonIfExists(fallbackProductionPreviewPath) ||
    recordValue(productionFallback.outputs.review);

  const brandBibleAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'brand-bible-markdown');
  const designSystemAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'brand-design-system');
  const proposalMarkdownAsset = findMarketingAsset(runtimeDoc.job_id, runtimeDoc, 'strategy-proposal-markdown');

  return {
    websiteAnalysis,
    campaignPlanner,
    strategyPreview,
    productionPreview,
    brandBibleText: readTextIfExists(
      brandBibleAsset?.filePath || stringValue(recordValue(websiteAnalysis?.artifacts)?.brand_bible_markdown_path),
    ),
    designSystemCss: readTextIfExists(
      designSystemAsset?.filePath || stringValue(recordValue(websiteAnalysis?.artifacts)?.design_system_css_path),
    ),
    proposalMarkdown: readTextIfExists(proposalMarkdownAsset?.filePath),
    sources: {
      websiteAnalysis: runtimeWebsiteAnalysis
        ? 'runtime'
        : websiteAnalysis
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
  const brandAnalysis = recordValue(payloads.websiteAnalysis?.brand_analysis);
  const artifacts = recordValue(payloads.websiteAnalysis?.artifacts);
  const runtimeBrandKit = runtimeDoc.brand_kit;
  const runtimeBrandName = stringValue(runtimeBrandKit?.brand_name);
  const runtimeCanonicalUrl = stringValue(runtimeBrandKit?.canonical_url);
  const runtimeOfferSummary = stringValue(runtimeBrandKit?.offer_summary);
  const runtimeVoiceSummary = stringValue(runtimeBrandKit?.brand_voice_summary);
  const runtimeLogoUrls = runtimeBrandKit?.logo_urls ?? [];
  const runtimePalette = runtimeBrandKit?.colors.palette ?? [];
  const runtimeFonts = runtimeBrandKit?.font_families ?? [];
  const runtimeExternalLinks = runtimeBrandKit?.external_links ?? [];
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

  if (websiteAnalysis) {
    attachments.push(marketingAttachment(websiteAnalysis.id, websiteAnalysis.label, websiteAnalysis.url, websiteAnalysis.contentType, 'document'));
  }
  if (brandBible) {
    attachments.push(marketingAttachment(brandBible.id, brandBible.label, brandBible.url, brandBible.contentType, 'document'));
  }
  if (designSystem) {
    attachments.push(marketingAttachment(designSystem.id, designSystem.label, designSystem.url, designSystem.contentType, 'artifact'));
  }

  const sections: MarketingReviewSection[] = [
    {
      id: 'brand-overview',
      title: 'Brand overview',
      body: labeledBlock([
        ['Brand', stringValue(brandAnalysis?.brand_name, runtimeBrandName)],
        ['Website', stringValue(brandAnalysis?.website_url, record.brief.websiteUrl || runtimeDoc.inputs.brand_url)],
        ['Canonical URL', runtimeCanonicalUrl],
        ['Brand promise', stringValue(brandAnalysis?.brand_promise)],
        ['Audience summary', stringValue(brandAnalysis?.audience_summary)],
        ['Positioning summary', stringValue(brandAnalysis?.positioning_summary)],
        ['Offer summary', stringValue(brandAnalysis?.offer_summary, runtimeOfferSummary)],
      ]),
    },
    {
      id: 'voice-guardrails',
      title: 'Voice and guardrails',
      body: labeledBlock([
        ['Brand voice', formatList(stringArray(brandAnalysis?.brand_voice))],
        ['Derived voice summary', runtimeVoiceSummary],
        ['CTA preferences', formatList(stringArray(brandAnalysis?.cta_preferences))],
        ['Proof points', formatList(stringArray(brandAnalysis?.proof_points))],
        ['Must-use copy', record.brief.mustUseCopy || 'None provided.'],
        ['Must-avoid aesthetics', record.brief.mustAvoidAesthetics || 'None provided.'],
      ]),
    },
    {
      id: 'brand-kit',
      title: 'Extracted brand kit',
      body: labeledBlock([
        ['Logo / wordmark candidates', formatList(runtimeLogoUrls)],
        ['Palette', formatList(runtimePalette)],
        ['Fonts', formatList(runtimeFonts)],
        ['External links', formatList(runtimeExternalLinks.map((link) => `${link.platform}: ${link.url}`))],
      ]),
    },
  ];

  if (payloads.brandBibleText) {
    sections.push({
      id: 'brand-bible',
      title: 'Brand bible',
      body: payloads.brandBibleText,
    });
  }

  if (payloads.designSystemCss) {
    sections.push({
      id: 'design-system',
      title: 'Design system',
      body: payloads.designSystemCss,
    });
  }

  if (sections.every((section) => !section.body.trim()) && attachments.length === 0) {
    return null;
  }

  return {
    reviewId: `${runtimeDoc.job_id}::brand-review`,
    reviewType: 'brand',
    status: record.stage_reviews.brand.status,
    title: 'Brand Review',
    summary: stringValue(brandAnalysis?.brand_promise, runtimeVoiceSummary),
    notePlaceholder: 'Add brand-direction notes, copy edits, or visual guardrails.',
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
          ? normalizeArtifactText(scriptDetails.metaAdHook) ||
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
      detailLines.push(`Ad hook: ${scriptDetails.metaAdHook || fallbackScripts.metaAdHook || normalizeArtifactText(stringValue(assetPreviews?.meta_ad_hook)) || ARTIFACT_UNAVAILABLE_TEXT}`);
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

  maybeApproveStage('brand', brandProgressed);
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
  const brandReady =
    !!runtimeDoc.brand_kit ||
    !!payloads.websiteAnalysis ||
    !!payloads.brandBibleText ||
    !!payloads.designSystemCss ||
    record.brief.brandAssets.length > 0;
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
  if (brandReady) {
    changed = ensureReviewReadyState(record, 'brand') || changed;
  }
  if (strategyReady) {
    changed = ensureReviewReadyState(record, 'strategy') || changed;
  }
  if (creativeAssetIds.length > 0) {
    changed = ensureReviewReadyState(record, 'creative') || changed;
    changed = ensureCreativeAssetReadyState(record, creativeAssetIds) || changed;
  }
  changed = syncWorkspaceReviewsFromRuntime(record, runtimeDoc, creativeAssetIds) || changed;
  if (changed) {
    saveCampaignWorkspaceRecord(record);
  }

  const workflowResolution = syncCampaignWorkflowState(record, {
    brandReviewReady: brandReady,
    strategyReviewReady: strategyReady,
    creativeReviewReady: creativeAssetIds.length > 0,
    creativeAssetIds,
    publishReadySignal:
      rawDashboard.statuses.countsByStatus.ready_to_publish > 0 ||
      rawDashboard.statuses.countsByStatus.published_to_meta_paused > 0 ||
      rawDashboard.statuses.countsByStatus.scheduled > 0 ||
      rawDashboard.statuses.countsByStatus.live > 0,
    publishedSignal:
      rawDashboard.statuses.countsByStatus.published_to_meta_paused > 0 ||
      rawDashboard.statuses.countsByStatus.scheduled > 0 ||
      rawDashboard.statuses.countsByStatus.live > 0,
  });

  const dashboard = withGatedDashboardStatus(rawDashboard, workflowResolution.workflowState);
  const brandReview = brandReady ? buildBrandReview(runtimeDoc, record, payloads) : null;
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
        ? payloads.sources.websiteAnalysis
        : runtimeDoc.brand_kit
          ? 'runtime_brand_kit'
          : record.brief.brandAssets.length > 0
            ? 'brief_assets'
            : 'asset_library'
      : 'none',
    brandReviewReason: brandReview ? 'hydrated' : 'no_real_brand_artifacts',
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
