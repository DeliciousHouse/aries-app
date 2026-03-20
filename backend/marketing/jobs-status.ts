import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodePath } from '@/lib/runtime-paths';

import {
  asRecord,
  asString,
  asStringArray,
  assertMarketingRuntimeSchemas,
  ensureRuntimeOpenClaw,
  loadMarketingJobRuntime,
  marketingRunIdFromRuntime,
} from './runtime-state';

type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';
type TimelineTone = 'info' | 'success' | 'warning' | 'danger';

type MarketingRuntimeData = {
  runId: string | null;
  researchCompile: Record<string, unknown> | null;
  researchExtract: Record<string, unknown> | null;
  websiteBrandAnalysis: Record<string, unknown> | null;
  campaignPlanner: Record<string, unknown> | null;
  headOfMarketing: Record<string, unknown> | null;
  productionReview: Record<string, unknown> | null;
  creativeDirectorFinalize: Record<string, unknown> | null;
  videoGenerator: Record<string, unknown> | null;
  performancePreflight: Record<string, unknown> | null;
  launchReview: Record<string, unknown> | null;
  performanceSummary: Record<string, unknown> | null;
  publisherPayloads: Array<Record<string, unknown>>;
  launchPreviewText: string | null;
  productionPreviewText: string | null;
};

export type MarketingStageCard = {
  stage: MarketingStage;
  label: string;
  status: string;
  summary: string;
  highlight?: string;
};

export type MarketingArtifactCard = {
  id: string;
  stage: MarketingStage;
  title: string;
  category: string;
  status: string;
  summary: string;
  details: string[];
  preview?: string;
  actionLabel?: string;
  actionHref?: string;
};

export type MarketingTimelineEntry = {
  id: string;
  at: string | null;
  tone: TimelineTone;
  label: string;
  description: string;
};

export type MarketingApprovalSummary = {
  required: boolean;
  status: string;
  title: string;
  message: string;
  actionLabel?: string;
  actionHref?: string;
};

export type MarketingSummary = {
  headline: string;
  subheadline: string;
};

export type MarketingJobStatusResponse = {
  jobId: string;
  tenantId: string | null;
  state: string;
  status: string;
  currentStage: string | null;
  stageStatus: Record<string, string>;
  updatedAt: string | null;
  approvalRequired: boolean;
  needsAttention: boolean;
  summary: MarketingSummary;
  stageCards: MarketingStageCard[];
  artifacts: MarketingArtifactCard[];
  timeline: MarketingTimelineEntry[];
  approval: MarketingApprovalSummary | null;
  nextStep: string;
  repairStatus: string;
};

const STAGE_LABELS: Record<MarketingStage, string> = {
  research: 'Research',
  strategy: 'Strategy',
  production: 'Production',
  publish: 'Publish',
};

const PUBLISHER_STEPS = [
  'meta_ads_publisher',
  'instagram_publisher',
  'x_publisher',
  'tiktok_publisher',
  'youtube_publisher',
  'linkedin_publisher',
  'reddit_publisher',
] as const;

function cacheRoot(envKey: string, fallbackFolder: string): string {
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallbackFolder);
}

function stageLogRoot(stage: 1 | 2 | 3 | 4): string {
  const stageFolder =
    stage === 1
      ? 'stage-1-research'
      : stage === 2
        ? 'stage-2-strategy'
        : stage === 3
          ? 'stage-3-production'
          : 'stage-4-publish-optimize';
  return resolveCodePath('lobster', 'output', 'logs', '{runId}', stageFolder);
}

function stepPayloadPath(stage: 1 | 2 | 3 | 4, runId: string, stepName: string): string {
  const root =
    stage === 1
      ? cacheRoot('LOBSTER_STAGE1_CACHE_DIR', 'lobster-stage1-cache')
      : stage === 2
        ? cacheRoot('LOBSTER_STAGE2_CACHE_DIR', 'lobster-stage2-cache')
        : stage === 3
          ? cacheRoot('LOBSTER_STAGE3_CACHE_DIR', 'lobster-stage3-cache')
          : cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache');
  const primary = path.join(root, runId, `${stepName}.json`);
  if (existsSync(primary)) {
    return primary;
  }
<<<<<<< HEAD
  return path.join(stageLogRoot(stage).replace('{runId}', runId), `${stepName}.json`);
=======
  return stageLogRoot(stage).replace('{runId}', runId) + `/${stepName}.json`;
>>>>>>> eac9628 (Persist canonical marketing pipeline artifacts)
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readTextPreview(filePath: string | null, maxChars = 420): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const text = readFileSync(filePath, 'utf8').trim();
    if (!text) {
      return null;
    }
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function generatedAt(payload: Record<string, unknown> | null): string | null {
  return asString(payload?.generated_at);
}

function approvalRequiredFromRuntime(
  runtimeDoc: Record<string, unknown>,
  launchReview: Record<string, unknown> | null
): boolean {
  const openclaw = ensureRuntimeOpenClaw(runtimeDoc);
  if (asString(openclaw.resume_token)) {
    return true;
  }

  const approvalPreview = asRecord(launchReview?.approval_preview) ?? asRecord(asRecord(openclaw.primary_output)?.approval_preview);
  return /pending|approval|review/i.test(stringValue(approvalPreview?.status));
}

function normalizeFallbackStageStatus(stage: MarketingStage, value: string | null): string | null {
  if (!value) return null;
  if (value === 'submitted' && stage !== 'publish') return 'completed';
  if (value === 'pending_human_review') return 'awaiting_approval';
  if (value === 'pass') return 'completed';
  if (value === 'fail') return 'failed';
  return value;
}

function deriveStageStatus(
  stage: MarketingStage,
  runtimeDoc: Record<string, unknown>,
  runtimeData: MarketingRuntimeData
): string {
  const outputs = asRecord(runtimeDoc.outputs);
  const fallback = normalizeFallbackStageStatus(
    stage,
    stringValue(asRecord(outputs?.stage_status)?.[stage], '')
  );

  switch (stage) {
    case 'research':
      return runtimeData.researchCompile ? 'completed' : runtimeData.researchExtract ? 'in_progress' : (fallback || 'accepted');
    case 'strategy':
      return runtimeData.headOfMarketing
        ? 'completed'
        : runtimeData.campaignPlanner || runtimeData.websiteBrandAnalysis
          ? 'in_progress'
          : (fallback || 'ready');
    case 'production':
      return runtimeData.creativeDirectorFinalize
        ? 'completed'
        : runtimeData.productionReview || runtimeData.videoGenerator
          ? 'in_progress'
          : (fallback || 'ready');
    case 'publish':
      if (runtimeData.performanceSummary || runtimeData.publisherPayloads.length > 0) {
        return 'completed';
      }
      if (approvalRequiredFromRuntime(runtimeDoc, runtimeData.launchReview)) {
        return 'awaiting_approval';
      }
      if (runtimeData.performancePreflight || runtimeData.launchReview) {
        return 'in_progress';
      }
      return fallback || 'ready';
    default:
      return fallback || 'accepted';
  }
}

function deriveState(
  runtimeDoc: Record<string, unknown>,
  stageStatus: Record<string, string>,
  approvalRequired: boolean
): { state: string; status: string; currentStage: string | null; nextStep: string; repairStatus: string; needsAttention: boolean } {
  const runtimeStatus = stringValue(runtimeDoc.status);
  const runtimeState = stringValue(runtimeDoc.state);
  const publishStatus = stageStatus.publish;

  if (runtimeState === 'not_found') {
    return {
      state: 'not_found',
      status: 'error',
      currentStage: null,
      nextStep: 'none',
      repairStatus: 'not_required',
      needsAttention: false,
    };
  }

  if (publishStatus === 'completed' || runtimeStatus === 'completed') {
    return {
      state: 'completed',
      status: 'completed',
      currentStage: 'publish',
      nextStep: 'none',
      repairStatus: 'not_required',
      needsAttention: false,
    };
  }

  if (approvalRequired) {
    return {
      state: 'approval_required',
      status: 'awaiting_approval',
      currentStage: 'publish',
      nextStep: 'submit_approval',
      repairStatus: 'not_required',
      needsAttention: true,
    };
  }

  if (
    ['error', 'failed', 'needs_repair', 'blocked', 'hard_failure', 'rejected'].includes(runtimeStatus) ||
    ['error', 'failed', 'needs_repair', 'blocked'].includes(runtimeState)
  ) {
    return {
      state: runtimeState || 'failed',
      status: runtimeStatus || 'failed',
      currentStage: stageStatus.production === 'completed' ? 'publish' : stageStatus.strategy === 'completed' ? 'production' : 'strategy',
      nextStep: 'invoke_marketing_repair',
      repairStatus: 'required',
      needsAttention: true,
    };
  }

  return {
    state: runtimeState || 'running',
    status: runtimeStatus || 'in_progress',
    currentStage: stageStatus.production === 'completed' ? 'publish' : stageStatus.strategy === 'completed' ? 'production' : stageStatus.research === 'completed' ? 'strategy' : 'research',
    nextStep: 'wait_for_completion',
    repairStatus: 'not_required',
    needsAttention: false,
  };
}

function buildSummary(
  state: ReturnType<typeof deriveState>
): MarketingSummary {
  if (state.status === 'completed') {
    return {
      headline: 'Campaign outputs are ready',
      subheadline: 'Launch packages, review artifacts, and delivery summaries are available for the current campaign.',
    };
  }

  if (state.status === 'awaiting_approval') {
    return {
      headline: 'Campaign is ready for launch approval',
      subheadline: 'Research, strategy, and production completed successfully. Review the launch package to continue.',
    };
  }

  if (state.needsAttention) {
    return {
      headline: 'Campaign needs operator attention',
      subheadline: 'The pipeline reported a failure or blocked state. Review the latest artifacts and next action before retrying.',
    };
  }

  return {
    headline: 'Campaign is in progress',
    subheadline: 'Aries is still collecting workflow signals from the marketing pipeline. Refresh to see the latest stage progress.',
  };
}

function buildStageCards(
  runtimeData: MarketingRuntimeData,
  stageStatus: Record<string, string>
): MarketingStageCard[] {
  const researchSummary = asRecord(runtimeData.researchCompile?.executive_summary);
  const strategyPlan = asRecord(runtimeData.campaignPlanner?.campaign_plan);
  const productionReviewPacket = asRecord(runtimeData.productionReview?.review_packet);
  const publishPlan = asRecord(runtimeData.performancePreflight?.publish_plan);

  return (['research', 'strategy', 'production', 'publish'] as MarketingStage[]).map((stage) => {
    switch (stage) {
      case 'research':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary:
            stringValue(researchSummary?.creative_takeaway) ||
            'Competitive research completed and ad-angle insights were compiled.',
          highlight: stringValue(researchSummary?.campaign_takeaway),
        };
      case 'strategy':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary:
            stringValue(strategyPlan?.core_message) ||
            'Campaign strategy and channel plans were assembled from the brand profile.',
          highlight: stringValue(strategyPlan?.primary_cta),
        };
      case 'production':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary:
            stringValue(asRecord(productionReviewPacket?.summary)?.core_message) ||
            'Production assets and review packet were prepared for launch.',
          highlight: stringValue(asRecord(productionReviewPacket?.asset_previews)?.landing_page_headline),
        };
      case 'publish':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary:
            stringValue(asRecord(runtimeData.launchReview?.approval_preview)?.message) ||
            stringValue(asRecord(runtimeData.performanceSummary?.summary)?.message) ||
            'Launch review and publish package generation are handled in the final stage.',
          highlight:
            runtimeData.performanceSummary || runtimeData.publisherPayloads.length > 0
              ? `${runtimeData.publisherPayloads.length || 1} publish package(s) generated`
              : `Static contracts: ${stringValue(publishPlan?.static_contract_count, '0')}, Video contracts: ${stringValue(publishPlan?.video_contract_count, '0')}`,
        };
    }
  });
}

function buildApproval(
  jobId: string,
  approvalRequired: boolean,
  runtimeData: MarketingRuntimeData
): MarketingApprovalSummary | null {
  if (!approvalRequired) {
    return null;
  }

  const approvalPreview = asRecord(runtimeData.launchReview?.approval_preview);
  return {
    required: true,
    status: stringValue(approvalPreview?.status, 'pending_human_review'),
    title: 'Launch approval required',
    message:
      stringValue(approvalPreview?.message) ||
      'The real Lobster pipeline paused at launch review. Approve to generate publish-ready assets.',
    actionLabel: 'Open approval dashboard',
    actionHref: `/marketing/job-approve?jobId=${encodeURIComponent(jobId)}`,
  };
}

function withDetails(...details: Array<string | null | undefined>): string[] {
  return details.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0);
}

function buildArtifacts(
  jobId: string,
  runtimeData: MarketingRuntimeData,
  approval: MarketingApprovalSummary | null
): MarketingArtifactCard[] {
  const cards: MarketingArtifactCard[] = [];
  const researchSummary = asRecord(runtimeData.researchCompile?.executive_summary);
  const researchInputs = asRecord(runtimeData.researchCompile?.inputs);
  const brandAnalysis = asRecord(runtimeData.websiteBrandAnalysis?.brand_analysis);
  const campaignPlan = asRecord(runtimeData.campaignPlanner?.campaign_plan);
  const reviewPacket = asRecord(runtimeData.productionReview?.review_packet);
  const videoAssets = asRecord(runtimeData.videoGenerator?.video_assets);
  const publishPlan = asRecord(runtimeData.performancePreflight?.publish_plan);

  if (runtimeData.researchCompile || runtimeData.researchExtract) {
    cards.push({
      id: 'research-summary',
      stage: 'research',
      title: 'Competitor research summary',
      category: 'analysis',
      status: 'completed',
      summary:
        stringValue(researchSummary?.market_positioning) ||
        'The pipeline compiled competitor positioning, creative takeaways, and recommended actions.',
      details: withDetails(
        `Competitor: ${stringValue(runtimeData.researchCompile?.competitor || runtimeData.researchExtract?.competitor, 'Unknown')}`,
        `Ads reviewed: ${stringValue(researchInputs?.ads_seen, '0')}`,
        stringValue(researchSummary?.campaign_takeaway),
      ),
      preview: asStringArray(runtimeData.researchExtract?.competitor_research_summary).join('\n') || undefined,
    });
  }

  if (runtimeData.websiteBrandAnalysis || runtimeData.campaignPlanner) {
    cards.push({
      id: 'strategy-plan',
      stage: 'strategy',
      title: 'Campaign strategy',
      category: 'brief',
      status: 'completed',
      summary:
        stringValue(brandAnalysis?.brand_promise) ||
        stringValue(campaignPlan?.core_message) ||
        'Brand analysis and cross-channel campaign planning are ready.',
      details: withDetails(
        stringValue(brandAnalysis?.audience_summary),
        `Offer: ${stringValue(brandAnalysis?.offer_summary || campaignPlan?.offer, 'n/a')}`,
        `Primary CTA: ${stringValue(campaignPlan?.primary_cta, 'Learn More')}`,
      ),
      preview: asStringArray(brandAnalysis?.proof_points).join('\n') || undefined,
    });
  }

  if (runtimeData.productionReview || runtimeData.creativeDirectorFinalize) {
    cards.push({
      id: 'production-review',
      stage: 'production',
      title: 'Production review packet',
      category: 'review',
      status: 'completed',
      summary:
        stringValue(asRecord(reviewPacket?.summary)?.core_message) ||
        'Landing page, ad, script, and video deliverables were prepared for launch.',
      details: withDetails(
        `Landing page headline: ${stringValue(asRecord(reviewPacket?.asset_previews)?.landing_page_headline, 'n/a')}`,
        `Ad hook: ${stringValue(asRecord(reviewPacket?.asset_previews)?.meta_ad_hook, 'n/a')}`,
        `Video opening line: ${stringValue(asRecord(reviewPacket?.asset_previews)?.video_opening_line, 'n/a')}`,
      ),
      preview: runtimeData.productionPreviewText || undefined,
    });
  }

  if (runtimeData.videoGenerator) {
    const platformContracts = Array.isArray(videoAssets?.platform_contracts)
      ? videoAssets.platform_contracts as Array<Record<string, unknown>>
      : [];
    cards.push({
      id: 'video-contracts',
      stage: 'production',
      title: 'Video contract handoff',
      category: 'contracts',
      status: 'completed',
      summary: `${platformContracts.length} video platform contract(s) were prepared for downstream rendering.`,
      details: platformContracts.slice(0, 4).map((contract) => {
        const platform = stringValue(contract.platform, 'Platform');
        const platformSlug = stringValue(contract.platform_slug);
        return platformSlug ? `${platform} (${platformSlug})` : platform;
      }),
    });
  }

  if (runtimeData.launchReview) {
    cards.push({
      id: 'launch-review',
      stage: 'publish',
      title: 'Launch review package',
      category: 'approval',
      status: approval?.required ? 'awaiting_approval' : 'completed',
      summary:
        stringValue(asRecord(runtimeData.launchReview.approval_preview)?.message) ||
        'The final publish step prepared a launch review package for operator approval.',
      details: withDetails(
        `Static contracts: ${stringValue(publishPlan?.static_contract_count, '0')}`,
        `Video contracts: ${stringValue(publishPlan?.video_contract_count, '0')}`,
      ),
      preview: runtimeData.launchPreviewText || undefined,
      actionLabel: approval?.actionLabel,
      actionHref: approval?.actionHref,
    });
  }

  if (runtimeData.performanceSummary || runtimeData.publisherPayloads.length > 0) {
    cards.push({
      id: 'publish-summary',
      stage: 'publish',
      title: 'Publish packages',
      category: 'delivery',
      status: 'completed',
      summary:
        stringValue(asRecord(runtimeData.performanceSummary?.summary)?.message) ||
        'Publish-ready channel packages were generated for the campaign.',
      details: runtimeData.publisherPayloads.map((payload) => {
        const platform = stringValue(payload.platform, 'Platform');
        const liveDraft = stringValue(asRecord(payload.live_draft_publish)?.status, 'not_configured');
        const reviewSubmission = stringValue(asRecord(payload.aries_review_submission)?.status, 'not_configured');
        return `${platform}: draft publish ${liveDraft}, Aries review ${reviewSubmission}`;
      }),
    });
  }

  return cards;
}

function buildTimeline(
  runtimeDoc: Record<string, unknown>,
  runtimeData: MarketingRuntimeData,
  state: ReturnType<typeof deriveState>
): MarketingTimelineEntry[] {
  const timeline: MarketingTimelineEntry[] = [];

  if (asString(runtimeDoc.created_at)) {
    timeline.push({
      id: 'accepted',
      at: asString(runtimeDoc.created_at),
      tone: 'info',
      label: 'Campaign accepted',
      description: 'Aries launched the real Lobster marketing pipeline for this campaign.',
    });
  }

  if (runtimeData.researchCompile) {
    timeline.push({
      id: 'research',
      at: generatedAt(runtimeData.researchCompile),
      tone: 'success',
      label: 'Research completed',
      description: 'Competitor ads, positioning, and recommended actions were compiled.',
    });
  }

  if (runtimeData.headOfMarketing) {
    timeline.push({
      id: 'strategy',
      at: generatedAt(runtimeData.headOfMarketing),
      tone: 'success',
      label: 'Strategy completed',
      description: 'Campaign messaging, audience, and CTA strategy were finalized.',
    });
  }

  if (runtimeData.creativeDirectorFinalize || runtimeData.productionReview) {
    timeline.push({
      id: 'production',
      at: generatedAt(runtimeData.creativeDirectorFinalize) || generatedAt(runtimeData.productionReview),
      tone: 'success',
      label: 'Production package ready',
      description: 'Landing page, ad, script, and video contract deliverables were assembled.',
    });
  }

  if (runtimeData.launchReview && state.status === 'awaiting_approval') {
    timeline.push({
      id: 'approval',
      at: generatedAt(runtimeData.launchReview),
      tone: 'warning',
      label: 'Launch approval requested',
      description: 'The pipeline paused for human launch review before publishing assets.',
    });
  }

  if (runtimeData.performanceSummary || runtimeData.publisherPayloads.length > 0) {
    timeline.push({
      id: 'publish',
      at: generatedAt(runtimeData.performanceSummary) || generatedAt(runtimeData.publisherPayloads[0] ?? null),
      tone: 'success',
      label: 'Publish packages generated',
      description: 'Channel-ready publish packages and review outputs were generated.',
    });
  }

  if (state.needsAttention && state.status !== 'awaiting_approval' && asString(runtimeDoc.updated_at)) {
    timeline.push({
      id: 'attention',
      at: asString(runtimeDoc.updated_at),
      tone: 'danger',
      label: 'Operator attention required',
      description: 'A failure or blocked state was recorded in the local marketing runtime.',
    });
  }

  return timeline.sort((left, right) => {
    if (!left.at && !right.at) return 0;
    if (!left.at) return 1;
    if (!right.at) return -1;
    return left.at.localeCompare(right.at);
  });
}

function loadRuntimeData(runtimeDoc: Record<string, unknown>): MarketingRuntimeData {
  const runId = marketingRunIdFromRuntime(runtimeDoc);

  const researchCompile = runId ? readJsonIfExists(stepPayloadPath(1, runId, 'ads_analyst_compile')) : null;
  const researchExtract = runId ? readJsonIfExists(stepPayloadPath(1, runId, 'meta_ads_extractor')) : null;
  const websiteBrandAnalysis = runId ? readJsonIfExists(stepPayloadPath(2, runId, 'website_brand_analysis')) : null;
  const campaignPlanner = runId ? readJsonIfExists(stepPayloadPath(2, runId, 'campaign_planner')) : null;
  const headOfMarketing = runId ? readJsonIfExists(stepPayloadPath(2, runId, 'head_of_marketing')) : null;
  const productionReview = runId ? readJsonIfExists(stepPayloadPath(3, runId, 'production_review_preview')) : null;
  const creativeDirectorFinalize = runId ? readJsonIfExists(stepPayloadPath(3, runId, 'creative_director_finalize')) : null;
  const videoGenerator = runId ? readJsonIfExists(stepPayloadPath(3, runId, 'veo_video_generator')) : null;
  const performancePreflight = runId ? readJsonIfExists(stepPayloadPath(4, runId, 'performance_marketer_preflight')) : null;
  const launchReview = runId ? readJsonIfExists(stepPayloadPath(4, runId, 'launch_review_preview')) : null;
  const performanceSummary = runId ? readJsonIfExists(stepPayloadPath(4, runId, 'performance_marketer_summary')) : null;
  const publisherPayloads = runId
    ? PUBLISHER_STEPS
        .map((stepName) => readJsonIfExists(stepPayloadPath(4, runId, stepName)))
        .filter((payload): payload is Record<string, unknown> => !!payload)
    : [];

  return {
    runId,
    researchCompile,
    researchExtract,
    websiteBrandAnalysis,
    campaignPlanner,
    headOfMarketing,
    productionReview,
    creativeDirectorFinalize,
    videoGenerator,
    performancePreflight,
    launchReview,
    performanceSummary,
    publisherPayloads,
    launchPreviewText: readTextPreview(asString(asRecord(launchReview?.artifacts)?.preview_path)),
    productionPreviewText: readTextPreview(asString(asRecord(productionReview?.artifacts)?.preview_path)),
  };
}

export function getMarketingJobStatus(jobId: string): MarketingJobStatusResponse {
  assertMarketingRuntimeSchemas();

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return {
      jobId,
      tenantId: null,
      state: 'not_found',
      status: 'error',
      currentStage: null,
      stageStatus: {},
      updatedAt: null,
      approvalRequired: false,
      needsAttention: false,
      summary: {
        headline: 'Campaign not found',
        subheadline: 'No local marketing runtime exists for this job yet.',
      },
      stageCards: [],
      artifacts: [],
      timeline: [],
      approval: null,
      nextStep: 'none',
      repairStatus: 'not_required',
    };
  }

  const runtimeData = loadRuntimeData(runtimeDoc);
  const approvalRequired = approvalRequiredFromRuntime(runtimeDoc, runtimeData.launchReview);
  const stageStatus: Record<string, string> = {
    research: deriveStageStatus('research', runtimeDoc, runtimeData),
    strategy: deriveStageStatus('strategy', runtimeDoc, runtimeData),
    production: deriveStageStatus('production', runtimeDoc, runtimeData),
    publish: deriveStageStatus('publish', runtimeDoc, runtimeData),
  };
  const state = deriveState(runtimeDoc, stageStatus, approvalRequired);
  const approval = buildApproval(jobId, approvalRequired, runtimeData);

  return {
    jobId,
    tenantId: asString(runtimeDoc.tenant_id),
    state: state.state,
    status: state.status,
    currentStage: state.currentStage,
    stageStatus,
    updatedAt: asString(runtimeDoc.updated_at),
    approvalRequired,
    needsAttention: state.needsAttention,
    summary: buildSummary(state),
    stageCards: buildStageCards(runtimeData, stageStatus),
    artifacts: buildArtifacts(jobId, runtimeData, approval),
    timeline: buildTimeline(runtimeDoc, runtimeData, state),
    approval,
    nextStep: state.nextStep,
    repairStatus: state.repairStatus,
  };
}
