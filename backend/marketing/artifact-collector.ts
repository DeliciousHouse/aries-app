import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  asRecord,
  asString,
  asStringArray,
  type MarketingStage,
  type MarketingStageArtifact,
  type MarketingStageSummary,
} from './runtime-state';

type StageCapture = {
  runId: string | null;
  summary: MarketingStageSummary | null;
  outputs: Record<string, unknown>;
  artifacts: MarketingStageArtifact[];
};

function cacheRoot(envKey: string, fallbackFolder: string): string {
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallbackFolder);
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
  return path.join(root, runId, `${stepName}.json`);
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

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function artifact(input: Omit<MarketingStageArtifact, 'details'> & { details?: string[] }): MarketingStageArtifact {
  return {
    ...input,
    details: input.details ?? [],
  };
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function detailLines(label: string, values: Array<string | null | undefined>, maxItems = 3): string[] {
  const cleaned = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, maxItems);
  return cleaned.length > 0 ? [`${label}: ${cleaned.join(' • ')}`] : [];
}

function resolveRunId(primaryOutput: Record<string, unknown> | null): string | null {
  return asString(primaryOutput?.run_id);
}

export function collectResearchStageArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const compilePath = runId ? stepPayloadPath(1, runId, 'ads_analyst_compile') : '';
  const extractorPath = runId ? stepPayloadPath(1, runId, 'meta_ads_extractor') : '';
  const compile = compilePath ? readJsonIfExists(compilePath) : null;
  const extractor = extractorPath ? readJsonIfExists(extractorPath) : null;
  const executive = asRecord(compile?.executive_summary) ?? {};
  const competitor = stringValue(compile?.competitor || extractor?.competitor, 'Competitor');
  const summary: MarketingStageSummary | null = {
    summary:
      stringValue(executive.market_positioning) ||
      'Competitive research completed and the highest-signal campaign angles were captured.',
    highlight: stringValue(executive.campaign_takeaway) || null,
  };

  return {
    runId,
    summary,
    outputs: {
      compile_path: compilePath || null,
      extractor_path: extractorPath || null,
      compile,
      extractor,
    },
    artifacts: [
      artifact({
        id: 'research-summary',
        stage: 'research',
        title: 'Competitor research summary',
        category: 'analysis',
        status: 'completed',
        summary: summary.summary,
        details: [
          `Competitor: ${competitor}`,
          `Ads reviewed: ${stringValue(asRecord(compile?.inputs)?.ads_seen, '0')}`,
          stringValue(executive.creative_takeaway),
        ].filter(Boolean),
        path: compilePath || null,
        preview_path: null,
      }),
    ],
  };
}

export function collectStrategyReviewArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const websitePath = runId ? stepPayloadPath(2, runId, 'website_brand_analysis') : '';
  const plannerPath = runId ? stepPayloadPath(2, runId, 'campaign_planner') : '';
  const reviewPath = runId ? stepPayloadPath(2, runId, 'strategy_review_preview') : '';
  const website = websitePath ? readJsonIfExists(websitePath) : null;
  const planner = plannerPath ? readJsonIfExists(plannerPath) : null;
  const review = reviewPath ? readJsonIfExists(reviewPath) : null;
  const brandAnalysis = asRecord(website?.brand_analysis) ?? {};
  const plan = asRecord(planner?.campaign_plan) ?? {};
  const reviewPacket = asRecord(review?.review_packet) ?? {};
  const summary: MarketingStageSummary | null = {
    summary:
      stringValue(plan.core_message) ||
      stringValue(brandAnalysis.brand_promise) ||
      'Campaign strategy and channel plans are ready for human review.',
    highlight:
      stringValue(plan.primary_cta) ||
      stringValue(reviewPacket.objective) ||
      null,
  };

  return {
    runId,
    summary,
    outputs: {
      website_brand_analysis_path: websitePath || null,
      campaign_planner_path: plannerPath || null,
      strategy_review_path: reviewPath || null,
      website,
      planner,
      review,
    },
    artifacts: [
      artifact({
        id: 'strategy-plan',
        stage: 'strategy',
        title: 'Campaign strategy',
        category: 'brief',
        status: 'awaiting_approval',
        summary: summary.summary,
        details: [
          stringValue(brandAnalysis.audience_summary),
          `Offer: ${stringValue(brandAnalysis.offer_summary || plan.offer, 'n/a')}`,
          `Primary CTA: ${stringValue(plan.primary_cta, 'Learn More')}`,
        ].filter(Boolean),
        path: plannerPath || null,
      }),
      artifact({
        id: 'strategy-review',
        stage: 'strategy',
        title: 'Strategy approval checkpoint',
        category: 'approval',
        status: 'awaiting_approval',
        summary: 'Strategy review is waiting on explicit approval before production can begin.',
        details: asStringArray(reviewPacket.channels_in_scope).length > 0
          ? [`Channels in scope: ${asStringArray(reviewPacket.channels_in_scope).join(', ')}`]
          : [],
        path: reviewPath || null,
      }),
    ],
  };
}

export function collectStrategyFinalizeArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const handoff = asRecord(primaryOutput?.strategy_handoff) ?? {};
  return {
    runId,
    summary: {
      summary:
        stringValue(handoff.core_message) ||
        'Strategy handoff was finalized for production.',
      highlight: stringValue(handoff.primary_cta) || null,
    },
    outputs: {
      strategy_handoff: handoff,
    },
    artifacts: [],
  };
}

export function collectProductionReviewArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const reviewPath = runId ? stepPayloadPath(3, runId, 'production_review_preview') : '';
  const finalizePath = runId ? stepPayloadPath(3, runId, 'creative_director_finalize') : '';
  const videoPath = runId ? stepPayloadPath(3, runId, 'veo_video_generator') : '';
  const review = reviewPath ? readJsonIfExists(reviewPath) : null;
  const video = videoPath ? readJsonIfExists(videoPath) : null;
  const packet = asRecord(review?.review_packet) ?? {};
  const summaryBlock = asRecord(packet.summary) ?? {};
  const previews = asRecord(packet.asset_previews) ?? {};
  const videoAssets = asRecord(video?.video_assets) ?? {};
  const summary: MarketingStageSummary | null = {
    summary:
      stringValue(summaryBlock.core_message) ||
      'Production assets and contracts are ready for review.',
    highlight: stringValue(previews.landing_page_headline) || null,
  };

  return {
    runId,
    summary,
    outputs: {
      production_review_path: reviewPath || null,
      production_finalize_path: finalizePath || null,
      video_generator_path: videoPath || null,
      review,
      video,
    },
    artifacts: [
      artifact({
        id: 'production-review',
        stage: 'production',
        title: 'Production review packet',
        category: 'review',
        status: 'awaiting_approval',
        summary: summary.summary,
        details: [
          `Landing page headline: ${stringValue(previews.landing_page_headline, 'n/a')}`,
          `Ad hook: ${stringValue(previews.meta_ad_hook, 'n/a')}`,
          `Video opening line: ${stringValue(previews.video_opening_line, 'n/a')}`,
        ],
        path: reviewPath || null,
        preview_path: asString(asRecord(review?.artifacts)?.preview_path),
      }),
      artifact({
        id: 'video-contracts',
        stage: 'production',
        title: 'Video contract handoff',
        category: 'contracts',
        status: 'completed',
        summary: `${Array.isArray(videoAssets.platform_contracts) ? videoAssets.platform_contracts.length : 0} video platform contract(s) prepared.`,
        details: Array.isArray(videoAssets.platform_contracts)
          ? (videoAssets.platform_contracts as Array<Record<string, unknown>>)
              .slice(0, 4)
              .map((entry) => stringValue(entry.platform, 'Platform'))
          : [],
        path: videoPath || null,
      }),
    ],
  };
}

export function collectProductionFinalizeArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const handoff = asRecord(primaryOutput?.production_handoff) ?? {};
  const contractHandoffs = asRecord(handoff.contract_handoffs) ?? {};
  const staticHandoff = asRecord(contractHandoffs.static) ?? {};
  const videoHandoff = asRecord(contractHandoffs.video) ?? {};
  return {
    runId,
    summary: {
      summary:
        stringValue(asRecord(handoff.production_brief)?.core_message) ||
        'Production handoff was finalized for publishing.',
      highlight: `Static contracts: ${stringValue(staticHandoff.platform_index_path ? (asStringArray(staticHandoff.platform_contract_paths).length || 0) : 0)}, Video contracts: ${stringValue(asStringArray(videoHandoff.platform_contract_paths).length || 0)}`,
    },
    outputs: {
      production_handoff: handoff,
    },
    artifacts: [],
  };
}

export function collectPublishReviewArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const preflightPath = runId ? stepPayloadPath(4, runId, 'performance_marketer_preflight') : '';
  const reviewPath = runId ? stepPayloadPath(4, runId, 'launch_review_preview') : '';
  const preflight = preflightPath ? readJsonIfExists(preflightPath) : null;
  const review = reviewPath ? readJsonIfExists(reviewPath) : null;
  const publishPlan = asRecord(preflight?.publish_plan) ?? {};
  const approvalPreview = asRecord(review?.approval_preview) ?? asRecord(primaryOutput?.approval_preview) ?? {};
  const reviewBundle = asRecord(review?.review_bundle) ?? asRecord(primaryOutput?.review_bundle) ?? {};
  const reviewSummary = asRecord(reviewBundle.summary) ?? {};
  const landingPagePreview = asRecord(reviewBundle.landing_page_preview) ?? {};
  const scriptPreview = asRecord(reviewBundle.script_preview) ?? {};
  const platformPreviews = asRecordArray(reviewBundle.platform_previews);
  const message =
    stringValue(approvalPreview.message) ||
    'Launch approval is required before publish-ready assets are generated.';
  const reviewArtifacts: MarketingStageArtifact[] = [];

  if (Object.keys(landingPagePreview).length > 0) {
    reviewArtifacts.push(
      artifact({
        id: 'launch-review-landing-page',
        stage: 'publish',
        title: 'Landing page preview',
        category: 'review',
        status: 'awaiting_approval',
        summary:
          stringValue(landingPagePreview.headline) ||
          'Landing page copy and CTA are available for launch review.',
        details: [
          `CTA: ${stringValue(landingPagePreview.cta, 'n/a')}`,
          `Slug: ${stringValue(landingPagePreview.slug, 'n/a')}`,
          ...detailLines('Sections', Array.isArray(landingPagePreview.sections) ? landingPagePreview.sections.map((entry) => stringValue(entry)) : []),
          ...detailLines(
            'Message match checks',
            Array.isArray(landingPagePreview.message_match_checks) ? landingPagePreview.message_match_checks.map((entry) => stringValue(entry)) : [],
            2
          ),
        ],
        path: stringValue(landingPagePreview.landing_page_path) || null,
        preview_path: stringValue(landingPagePreview.preview_path) || null,
      })
    );
  }

  if (Object.keys(scriptPreview).length > 0) {
    reviewArtifacts.push(
      artifact({
        id: 'launch-review-scripts',
        stage: 'publish',
        title: 'Draft copy and scripts',
        category: 'review',
        status: 'awaiting_approval',
        summary:
          stringValue(scriptPreview.meta_ad_hook) ||
          stringValue(scriptPreview.short_video_opening_line) ||
          'Platform copy drafts are available for review.',
        details: [
          `Meta hook: ${stringValue(scriptPreview.meta_ad_hook, 'n/a')}`,
          ...detailLines(
            'Meta body',
            Array.isArray(scriptPreview.meta_ad_body) ? scriptPreview.meta_ad_body.map((entry) => stringValue(entry)) : []
          ),
          `Video opening line: ${stringValue(scriptPreview.short_video_opening_line, 'n/a')}`,
          ...detailLines(
            'Video beats',
            Array.isArray(scriptPreview.short_video_beats) ? scriptPreview.short_video_beats.map((entry) => stringValue(entry)) : [],
            2
          ),
        ],
        path: stringValue(scriptPreview.meta_script_path) || stringValue(scriptPreview.short_video_script_path) || null,
        preview_path: stringValue(scriptPreview.preview_path) || null,
      })
    );
  }

  for (const platform of platformPreviews) {
    const assetPaths = asRecord(platform.asset_paths) ?? {};
    const mediaPaths = Array.isArray(platform.media_paths) ? platform.media_paths.map((entry) => stringValue(entry)).filter(Boolean) : [];
    const channelType = stringValue(platform.channel_type, 'draft');
    reviewArtifacts.push(
      artifact({
        id: `launch-review-platform-${stringValue(platform.platform_slug, `platform-${reviewArtifacts.length}`)}`,
        stage: 'publish',
        title: stringValue(platform.platform_name, stringValue(platform.platform_slug, 'Platform preview')),
        category: `${channelType} preview`,
        status: 'awaiting_approval',
        summary:
          stringValue(platform.summary) ||
          stringValue(platform.headline) ||
          'A platform-specific launch draft is ready for review.',
        details: [
          `Hook: ${stringValue(platform.hook, 'n/a')}`,
          `Headline: ${stringValue(platform.headline, 'n/a')}`,
          `CTA: ${stringValue(platform.cta, 'n/a')}`,
          ...detailLines(
            channelType === 'video' ? 'Story beats' : 'Draft copy',
            channelType === 'video'
              ? (Array.isArray(platform.proof_points) ? platform.proof_points.map((entry) => stringValue(entry)) : [])
              : [stringValue(platform.caption_text)],
            3
          ),
          ...detailLines('Media paths', mediaPaths, 2),
        ],
        path: stringValue(assetPaths.contract_path) || stringValue(assetPaths.brief_path) || null,
      })
    );
  }
  return {
    runId,
    summary: {
      summary: message,
      highlight:
        stringValue(reviewSummary.core_message) ||
        `Static contracts: ${stringValue(publishPlan.static_contract_count, '0')}, Video contracts: ${stringValue(publishPlan.video_contract_count, '0')}`,
    },
    outputs: {
      performance_marketer_preflight_path: preflightPath || null,
      launch_review_preview_path: reviewPath || null,
      preflight,
      review,
    },
    artifacts: [
      artifact({
        id: 'launch-review',
        stage: 'publish',
        title: 'Launch review package',
        category: 'approval',
        status: 'awaiting_approval',
        summary: message,
        details: [
          `Static contracts: ${stringValue(publishPlan.static_contract_count, '0')}`,
          `Video contracts: ${stringValue(publishPlan.video_contract_count, '0')}`,
          `Platform previews: ${platformPreviews.length}`,
        ],
        path: reviewPath || null,
        preview_path: asString(asRecord(review?.artifacts)?.preview_path),
      }),
      ...reviewArtifacts,
    ],
  };
}

export function collectPublishFinalizeArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const summaryPath = runId ? stepPayloadPath(4, runId, 'performance_marketer_summary') : '';
  const summaryPayload = summaryPath ? readJsonIfExists(summaryPath) : null;
  const publisherSteps = [
    'meta_ads_publisher',
    'instagram_publisher',
    'x_publisher',
    'tiktok_publisher',
    'youtube_publisher',
    'linkedin_publisher',
    'reddit_publisher',
  ] as const;
  const publisherPayloads = runId
    ? publisherSteps
        .map((stepName) => {
          const payloadPath = stepPayloadPath(4, runId, stepName);
          const payload = readJsonIfExists(payloadPath);
          return payload ? { stepName, payloadPath, payload } : null;
        })
        .filter((entry): entry is { stepName: typeof publisherSteps[number]; payloadPath: string; payload: Record<string, unknown> } => !!entry)
    : [];

  return {
    runId,
    summary: {
      summary:
        stringValue(asRecord(summaryPayload?.summary)?.message) ||
        'Publish-ready channel packages were generated for the selected platforms.',
      highlight: `${publisherPayloads.length} publish package(s) generated`,
    },
    outputs: {
      performance_marketer_summary_path: summaryPath || null,
      summary: summaryPayload,
      publishers: publisherPayloads.map((entry) => ({
        step: entry.stepName,
        path: entry.payloadPath,
        payload: entry.payload,
      })),
    },
    artifacts: [
      artifact({
        id: 'publish-summary',
        stage: 'publish',
        title: 'Publish packages',
        category: 'delivery',
        status: 'completed',
        summary:
          stringValue(asRecord(summaryPayload?.summary)?.message) ||
          'Selected platform packages were generated.',
        details: publisherPayloads.map((entry) => {
          const platform = stringValue(entry.payload.platform, entry.stepName);
          const packageInfo = asRecord(entry.payload.publish_package) ?? {};
          const status = stringValue(entry.payload.mode, 'generated');
          return `${platform}: ${status}${packageInfo.review_package_path ? ' (review package ready)' : ''}`;
        }),
        path: summaryPath || null,
      }),
    ],
  };
}
