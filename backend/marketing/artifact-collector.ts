import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  asRecord,
  asString,
  asStringArray,
  type MarketingStage,
  type MarketingStageArtifact,
  type MarketingVideoStageArtifact,
  type MarketingStageSummary,
} from './runtime-state';
import { resolvePublishReviewBundle } from './publish-review';
import {
  ARTIFACT_UNAVAILABLE_TEXT,
  normalizeArtifactText,
  readLandingPageArtifactDetails,
  readScriptArtifactDetails,
} from './real-artifacts';
import { inferMarketingStageRunId, readMarketingStageStepPayload } from './stage-artifact-resolution';
import type { MarketingJobRuntimeDocument } from './runtime-state';
import { loadValidatedMarketingProfileDocs } from './validated-profile-store';
import { recordMatchesCurrentSource, sourceFingerprintFromRecord } from './brand-identity';

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

function currentSourceUrl(runtimeDoc: MarketingJobRuntimeDocument | null | undefined): string | null {
  if (!runtimeDoc) {
    return null;
  }

  return (
    asString(asRecord(runtimeDoc.inputs.request)?.websiteUrl) ||
    asString(asRecord(runtimeDoc.inputs.request)?.brandUrl) ||
    asString(runtimeDoc.inputs.brand_url) ||
    null
  );
}

function sourceMatchedRecord(
  value: Record<string, unknown> | null,
  sourceUrl: string | null,
): Record<string, unknown> | null {
  return recordMatchesCurrentSource(value, sourceUrl) ? value : null;
}

function strategyPayloadMatchesCurrentSource(
  value: Record<string, unknown> | null,
  sourceUrl: string | null,
  runSourceEvidence: Record<string, unknown> | null,
  hasRunSourceCandidate: boolean,
): boolean {
  if (!value) {
    return false;
  }
  if (!recordMatchesCurrentSource(value, sourceUrl)) {
    return false;
  }
  if (!sourceUrl) {
    return true;
  }
  if (sourceFingerprintFromRecord(value) || runSourceEvidence) {
    return true;
  }
  return !hasRunSourceCandidate;
}

function artifact(input: Omit<MarketingStageArtifact, 'details'> & { details?: string[] }): MarketingStageArtifact {
  return {
    ...input,
    details: input.details ?? [],
  };
}

function videoArtifact(input: MarketingVideoStageArtifact): MarketingVideoStageArtifact {
  return input;
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

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function familyTitle(value: string): string {
  if (/^family[-_\s]/i.test(value)) {
    return value
      .split(/[-_\s]+/g)
      .map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ');
  }

  return `Family ${value.length === 1 ? value.toUpperCase() : titleCaseSlug(value)}`;
}

function collectRenderedVideoArtifacts(params: {
  jobId: string | null;
  videoPayload: Record<string, unknown> | null;
}): MarketingVideoStageArtifact[] {
  const { jobId, videoPayload } = params;
  if (!jobId || !videoPayload) {
    return [];
  }

  const videoAssets = asRecord(videoPayload.video_assets) ?? {};
  return asRecordArray(videoAssets.platform_contracts).flatMap((contract) => {
    const platformSlug =
      stringValue(contract.platform_slug) ||
      stringValue(contract.canonical_platform_slug);
    if (!platformSlug) {
      return [];
    }

    const platformTitle =
      stringValue(contract.platform) ||
      stringValue(contract.platform_name) ||
      titleCaseSlug(platformSlug);
    const platformRequirements = asRecord(contract.platform_requirements) ?? {};

    return asRecordArray(contract.rendered_video_variants).flatMap((variant) => {
      const familyId = stringValue(variant.family_id);
      if (!familyId) {
        return [];
      }

      const artifactId = `video-${platformSlug}-${familyId}`;
      const durationSeconds =
        numberValue(variant.duration_seconds) ??
        numberValue(platformRequirements.target_duration_seconds) ??
        0;
      const aspectRatio =
        stringValue(variant.aspect_ratio) ||
        stringValue(contract.aspect_ratio) ||
        stringValue(platformRequirements.aspect_ratio) ||
        'unknown';
      const familyDisplay =
        stringValue(variant.family_name) ||
        stringValue(contract.family_name) ||
        familyTitle(familyId);

      return [
        videoArtifact({
          id: artifactId,
          stage: 'production',
          type: 'video',
          title: `${platformTitle} — ${familyDisplay}`,
          category: 'video',
          status: 'completed',
          summary: `${platformTitle} render for ${familyDisplay} (${aspectRatio}, ${durationSeconds}s).`,
          details: [],
          contentType: 'video/mp4',
          url: `/api/marketing/jobs/${jobId}/assets/${artifactId}`,
          posterUrl: `/api/marketing/jobs/${jobId}/assets/${artifactId}-poster`,
          platformSlug,
          familyId,
          durationSeconds,
          aspectRatio,
        }),
      ];
    });
  });
}

function resolveRunId(
  primaryOutput: Record<string, unknown> | null,
  runtimeDoc?: MarketingJobRuntimeDocument | null,
  stage?: 1 | 2 | 3 | 4,
): string | null {
  return asString(primaryOutput?.run_id) || (runtimeDoc && stage ? inferMarketingStageRunId(runtimeDoc, stage) : null);
}

export function collectResearchStageArtifacts(primaryOutput: Record<string, unknown> | null): StageCapture {
  const runId = resolveRunId(primaryOutput);
  const compilePath = runId ? stepPayloadPath(1, runId, 'ads_analyst_compile') : '';
  const extractorPath = runId ? stepPayloadPath(1, runId, 'meta_ads_extractor') : '';
  const compile = compilePath ? readJsonIfExists(compilePath) : null;
  const extractor = extractorPath ? readJsonIfExists(extractorPath) : null;
  const executive = asRecord(compile?.executive_summary) ?? {};
  // Only treat the competitor as real if the upstream produced a non-generic value.
  // ads-analyst defaults to the literal string "competitor" when no brand was set,
  // which previously surfaced as "Competitor: Competitor" in the UI.
  const competitorRaw = stringValue(compile?.competitor || extractor?.competitor);
  const hasRealCompetitor = !!competitorRaw && competitorRaw.toLowerCase() !== 'competitor';
  const adsSeenRaw = stringValue(asRecord(compile?.inputs)?.ads_seen);
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
        title: hasRealCompetitor ? `${competitorRaw} research summary` : 'Competitor research summary',
        category: 'analysis',
        status: 'completed',
        summary: summary.summary,
        details: [
          hasRealCompetitor ? `Competitor: ${competitorRaw}` : null,
          adsSeenRaw && adsSeenRaw !== '0' ? `Ads reviewed: ${adsSeenRaw}` : null,
          stringValue(executive.creative_takeaway),
        ].filter((entry): entry is string => !!entry),
        path: compilePath || null,
        preview_path: null,
      }),
    ],
  };
}

export function collectStrategyReviewArtifacts(
  primaryOutput: Record<string, unknown> | null,
  runtimeDoc?: MarketingJobRuntimeDocument | null,
): StageCapture {
  const sourceUrl = currentSourceUrl(runtimeDoc);
  const validatedDocs = runtimeDoc ? loadValidatedMarketingProfileDocs(runtimeDoc.tenant_id, {
    currentSourceUrl: sourceUrl,
  }) : null;
  const websiteStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 2, 'website_brand_analysis') : null;
  const plannerStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 2, 'campaign_planner') : null;
  const reviewStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 2, 'strategy_review_preview') : null;
  const runId =
    resolveRunId(primaryOutput, runtimeDoc, 2) ||
    websiteStep?.runId ||
    plannerStep?.runId ||
    reviewStep?.runId ||
    null;
  const websitePath =
    stringValue(asRecord(primaryOutput)?.validated_website_analysis_path) ||
    validatedDocs?.paths.websiteAnalysis ||
    websiteStep?.path ||
    (runId ? stepPayloadPath(2, runId, 'website_brand_analysis') : '');
  const brandProfilePath =
    stringValue(asRecord(primaryOutput)?.validated_brand_profile_path) ||
    validatedDocs?.paths.brandProfile ||
    null;
  const plannerPath = plannerStep?.path || (runId ? stepPayloadPath(2, runId, 'campaign_planner') : '');
  const reviewPath = reviewStep?.path || (runId ? stepPayloadPath(2, runId, 'strategy_review_preview') : '');
  const rawRunWebsite = websiteStep?.payload || (websitePath ? readJsonIfExists(websitePath) : null);
  const runWebsite = sourceMatchedRecord(
    rawRunWebsite,
    sourceUrl,
  );
  const website = runWebsite || validatedDocs?.websiteAnalysis || null;
  const brandProfile = sourceMatchedRecord(
    validatedDocs?.brandProfile || (brandProfilePath ? readJsonIfExists(brandProfilePath) : null),
    sourceUrl,
  );
  const plannerCandidate = plannerStep?.payload || (plannerPath ? readJsonIfExists(plannerPath) : null);
  const reviewCandidate = reviewStep?.payload || (reviewPath ? readJsonIfExists(reviewPath) : null);
  const planner = strategyPayloadMatchesCurrentSource(plannerCandidate, sourceUrl, runWebsite, !!rawRunWebsite) ? plannerCandidate : null;
  const review = strategyPayloadMatchesCurrentSource(reviewCandidate, sourceUrl, runWebsite, !!rawRunWebsite) ? reviewCandidate : null;
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
      validated_website_analysis_path: websitePath || null,
      validated_brand_profile_path: brandProfilePath,
      campaign_planner_path: plannerPath || null,
      strategy_review_path: reviewPath || null,
      website,
      brand_profile: brandProfile,
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
          `Offer: ${normalizeArtifactText(stringValue(brandAnalysis.offer_summary || plan.offer)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          `Primary CTA: ${normalizeArtifactText(stringValue(plan.primary_cta)) || ARTIFACT_UNAVAILABLE_TEXT}`,
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

export function collectProductionReviewArtifacts(
  primaryOutput: Record<string, unknown> | null,
  runtimeDoc?: MarketingJobRuntimeDocument | null,
): StageCapture {
  const reviewStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 3, 'production_review_preview') : null;
  const finalizeStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 3, 'creative_director_finalize') : null;
  const videoStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 3, 'veo_video_generator') : null;
  const runId =
    resolveRunId(primaryOutput, runtimeDoc, 3) ||
    reviewStep?.runId ||
    finalizeStep?.runId ||
    videoStep?.runId ||
    null;
  const reviewPath = reviewStep?.path || (runId ? stepPayloadPath(3, runId, 'production_review_preview') : '');
  const finalizePath = finalizeStep?.path || (runId ? stepPayloadPath(3, runId, 'creative_director_finalize') : '');
  const videoPath = videoStep?.path || (runId ? stepPayloadPath(3, runId, 'veo_video_generator') : '');
  const review = reviewStep?.payload || (reviewPath ? readJsonIfExists(reviewPath) : null);
  const video = videoStep?.payload || (videoPath ? readJsonIfExists(videoPath) : null);
  const jobId = runtimeDoc?.job_id || stringValue(primaryOutput?.job_id) || null;
  const packet = asRecord(review?.review_packet) ?? {};
  const summaryBlock = asRecord(packet.summary) ?? {};
  const previews = asRecord(packet.asset_previews) ?? {};
  const landingDetails = readLandingPageArtifactDetails({ runtimeDoc });
  const scriptDetails = readScriptArtifactDetails({ runtimeDoc });
  const videoAssets = asRecord(video?.video_assets) ?? {};
  const renderedVideoArtifacts = collectRenderedVideoArtifacts({ jobId, videoPayload: video });
  const summary: MarketingStageSummary | null = {
    summary:
      stringValue(summaryBlock.core_message) ||
      'Production assets and contracts are ready for review.',
    highlight:
      normalizeArtifactText(landingDetails.headline) ||
      normalizeArtifactText(stringValue(previews.landing_page_headline)) ||
      null,
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
          `Landing page headline: ${landingDetails.headline || normalizeArtifactText(stringValue(previews.landing_page_headline)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          `Ad hook: ${scriptDetails.metaAdHook || normalizeArtifactText(stringValue(previews.meta_ad_hook)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          `Video opening line: ${scriptDetails.shortVideoOpeningLine || normalizeArtifactText(stringValue(previews.video_opening_line)) || ARTIFACT_UNAVAILABLE_TEXT}`,
        ],
        path: reviewPath || null,
        preview_path: asString(asRecord(review?.artifacts)?.preview_path),
      }),
      ...renderedVideoArtifacts,
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

export function collectPublishReviewArtifacts(
  primaryOutput: Record<string, unknown> | null,
  runtimeDoc?: MarketingJobRuntimeDocument | null,
): StageCapture {
  const preflightStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 4, 'performance_marketer_preflight') : null;
  const reviewStep = runtimeDoc ? readMarketingStageStepPayload(runtimeDoc, 4, 'launch_review_preview') : null;
  const runId =
    resolveRunId(primaryOutput, runtimeDoc, 4) ||
    preflightStep?.runId ||
    reviewStep?.runId ||
    null;
  const preflightPath = preflightStep?.path || (runId ? stepPayloadPath(4, runId, 'performance_marketer_preflight') : '');
  const reviewPath = reviewStep?.path || (runId ? stepPayloadPath(4, runId, 'launch_review_preview') : '');
  const preflight = preflightStep?.payload || (preflightPath ? readJsonIfExists(preflightPath) : null);
  const resolvedPublishReview = runtimeDoc ? resolvePublishReviewBundle(runtimeDoc) : { reviewPayload: null, reviewBundle: null };
  // In docker setups, the lobster step cache lives on the gateway host (a different
  // filesystem) so reviewStep/reviewPath both come back null. Fall back to the
  // primaryOutput passed in by the orchestrator — that's the launch_review_preview
  // payload forwarded through the approval bridge as `requiresApproval.items[0]`.
  const review =
    resolvedPublishReview.reviewPayload ||
    reviewStep?.payload ||
    (reviewPath ? readJsonIfExists(reviewPath) : null) ||
    (primaryOutput && stringValue((primaryOutput as Record<string, unknown>).type) === 'launch_review_preview'
      ? (primaryOutput as Record<string, unknown>)
      : null);
  const publishPlan = asRecord(preflight?.publish_plan) ?? {};
  const approvalPreview = asRecord(review?.approval_preview) ?? asRecord(primaryOutput?.approval_preview) ?? {};
  const reviewBundle = resolvedPublishReview.reviewBundle ?? asRecord(review?.review_bundle) ?? asRecord(primaryOutput?.review_bundle) ?? {};
  const reviewSummary = asRecord(reviewBundle.summary) ?? {};
  const landingPagePreview = asRecord(reviewBundle.landing_page_preview) ?? {};
  const scriptPreview = asRecord(reviewBundle.script_preview) ?? {};
  const platformPreviews = asRecordArray(reviewBundle.platform_previews);
  const landingDetails = readLandingPageArtifactDetails({
    path: stringValue(landingPagePreview.landing_page_path) || null,
    runtimeDoc: runtimeDoc || null,
  });
  const scriptDetails = readScriptArtifactDetails({
    metaScriptPath: stringValue(scriptPreview.meta_script_path) || null,
    shortVideoScriptPath: stringValue(scriptPreview.short_video_script_path) || null,
    runtimeDoc: runtimeDoc || null,
  });
  const message =
    stringValue(approvalPreview.message) ||
    ARTIFACT_UNAVAILABLE_TEXT;
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
          landingDetails.headline ||
          normalizeArtifactText(stringValue(landingPagePreview.headline)) ||
          ARTIFACT_UNAVAILABLE_TEXT,
        details: [
          `CTA: ${landingDetails.cta || normalizeArtifactText(stringValue(landingPagePreview.cta)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          `Slug: ${normalizeArtifactText(landingDetails.slug || stringValue(landingPagePreview.slug)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          ...detailLines('Sections', landingDetails.sections.length > 0 ? landingDetails.sections : (Array.isArray(landingPagePreview.sections) ? landingPagePreview.sections.map((entry) => stringValue(entry)) : [])),
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
          scriptDetails.metaAdHook ||
          scriptDetails.shortVideoOpeningLine ||
          normalizeArtifactText(stringValue(scriptPreview.meta_ad_hook)) ||
          normalizeArtifactText(stringValue(scriptPreview.short_video_opening_line)) ||
          ARTIFACT_UNAVAILABLE_TEXT,
        details: [
          `Meta hook: ${scriptDetails.metaAdHook || normalizeArtifactText(stringValue(scriptPreview.meta_ad_hook)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          ...detailLines(
            'Meta body',
            scriptDetails.metaAdBody.length > 0
              ? scriptDetails.metaAdBody
              : (Array.isArray(scriptPreview.meta_ad_body) ? scriptPreview.meta_ad_body.map((entry) => stringValue(entry)) : [])
          ),
          `Video opening line: ${scriptDetails.shortVideoOpeningLine || normalizeArtifactText(stringValue(scriptPreview.short_video_opening_line)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          ...detailLines(
            'Video beats',
            scriptDetails.shortVideoBeats.length > 0
              ? scriptDetails.shortVideoBeats
              : (Array.isArray(scriptPreview.short_video_beats) ? scriptPreview.short_video_beats.map((entry) => stringValue(entry)) : []),
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
          normalizeArtifactText(stringValue(platform.summary)) ||
          normalizeArtifactText(stringValue(platform.headline)) ||
          ARTIFACT_UNAVAILABLE_TEXT,
        details: [
          `Hook: ${normalizeArtifactText(stringValue(platform.hook)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          `Headline: ${normalizeArtifactText(stringValue(platform.headline)) || ARTIFACT_UNAVAILABLE_TEXT}`,
          `CTA: ${normalizeArtifactText(stringValue(platform.cta)) || ARTIFACT_UNAVAILABLE_TEXT}`,
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
