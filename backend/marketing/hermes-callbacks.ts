import type { HermesRunCallbackPayload } from '@/backend/execution/hermes-callbacks';
import type { ExecutionRunRecord } from '@/backend/execution/run-store';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '@/backend/social-content/defaults';
import {
  approvalStepFromWorkflowStepId,
  isSocialContentPublishApprovalRequired,
  markSocialContentStageAwaitingApproval,
  markSocialContentStageCompleted,
  markSocialContentStageFailed,
  markSocialContentStageRunning,
  reconcileSocialContentIntermediateStages,
  socialContentStageFromCallbackStage,
} from '@/backend/social-content/runtime-state';
import { ingestSocialContentVideoRenderOutput } from '@/backend/social-content/media-ingest';
import type { SocialContentApprovalStep, SocialContentArtifact, SocialContentStage } from '@/backend/social-content/types';

import {
  createMarketingApprovalRecord,
  saveMarketingApprovalRecord,
} from './approval-store';
import {
  clearApprovalCheckpoint,
  loadMarketingJobRuntime,
  markStageAwaitingApproval,
  markStageCompleted,
  recordStageFailure,
  saveMarketingJobRuntime,
  type MarketingJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';
import { scheduleHermesPublishPerformanceHonchoWrite } from '@/backend/memory/write-events';

const STAGE_ORDER: MarketingStage[] = ['research', 'strategy', 'production', 'publish'];

// Resolve APP_BASE_URL the same way the Hermes port does — prefer explicit
// env, fall back to the auth URL fallbacks, strip trailing slashes.
function resolveAppBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    'https://aries.sugarandleather.com'
  ).replace(/\/+$/, '');
}

type HermesCreativeAsset = {
  assetId: string;
  type: string;
  status?: string;
  path?: string;
  placement?: string;
  prompt?: string;
  [key: string]: unknown;
};

type HermesGeneratedImage = {
  index?: number;
  status?: string;
  filePath?: string;
  path?: string;
  prompt?: string;
  intendedUse?: string;
  [key: string]: unknown;
};

type HermesImageCreativeLike = {
  id?: string;
  title?: string;
  prompt?: string;
  status?: string;
  artifact_url?: string;
  path?: string;
  filePath?: string;
  intendedUse?: string;
  placement?: string;
  [key: string]: unknown;
};

function imageBasenameFromValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/([^/?#]+\.(?:png|jpe?g|webp|gif))(?:[?#].*)?$/i);
  return match?.[1] ?? '';
}

function renderedImageBasenameFromRecord(record: Record<string, unknown>): string {
  for (const value of Object.values(record)) {
    const basename = imageBasenameFromValue(value);
    if (basename) return basename;
  }
  return '';
}

function mediaArtifactUrl(appBaseUrl: string, basename: string): string {
  return basename ? `${appBaseUrl}/api/internal/hermes/media/${basename}` : '';
}

function normalizeRenderedStatus(_status: unknown): string {
  return 'completed';
}

function canonicalImageCreativeFromCreativeAsset(
  asset: HermesCreativeAsset,
  index: number,
  appBaseUrl: string,
  aspectRatio: string,
): Record<string, unknown> | null {
  if (asset.type !== 'generated_image') return null;

  const basename = renderedImageBasenameFromRecord(asset);
  if (!basename) return null;

  const assetId = typeof asset.assetId === 'string' && asset.assetId.trim().length > 0
    ? asset.assetId.trim()
    : String(index);
  const prompt = typeof asset.prompt === 'string' ? asset.prompt : '';
  const placement = typeof asset.placement === 'string' ? asset.placement : '';

  return {
    id: `img_${assetId}`,
    title: placement,
    ...(placement ? { placement, intendedUse: placement } : {}),
    prompt,
    status: normalizeRenderedStatus(asset.status),
    artifact_url: mediaArtifactUrl(appBaseUrl, basename),
    aspect_ratio: aspectRatio,
  };
}

function canonicalImageCreativeFromGeneratedImage(
  image: HermesGeneratedImage,
  index: number,
  appBaseUrl: string,
  aspectRatio: string,
): Record<string, unknown> | null {
  const basename = renderedImageBasenameFromRecord(image);
  if (!basename) return null;

  const imageIndex = typeof image.index === 'number' ? image.index : index;
  const prompt = typeof image.prompt === 'string' ? image.prompt : '';
  const intendedUse = typeof image.intendedUse === 'string' ? image.intendedUse : '';

  return {
    id: `img_${String(imageIndex)}`,
    title: intendedUse,
    ...(intendedUse ? { intendedUse } : {}),
    prompt,
    status: normalizeRenderedStatus(image.status),
    artifact_url: mediaArtifactUrl(appBaseUrl, basename),
    aspect_ratio: aspectRatio,
  };
}

function canonicalImageCreativeFromExisting(
  creative: HermesImageCreativeLike,
  index: number,
  appBaseUrl: string,
  aspectRatio: string,
): Record<string, unknown> | null {
  const basename = renderedImageBasenameFromRecord(creative);
  if (!basename) return null;

  const idSource = typeof creative.id === 'string' && creative.id.trim().length > 0
    ? creative.id.trim().replace(/^img_/, '')
    : String(index);
  const prompt = typeof creative.prompt === 'string' ? creative.prompt : '';
  const intendedUse = typeof creative.intendedUse === 'string'
    ? creative.intendedUse
    : typeof creative.title === 'string'
      ? creative.title
      : typeof creative.placement === 'string'
        ? creative.placement
        : '';

  return {
    id: `img_${idSource}`,
    title: intendedUse,
    ...(intendedUse ? { intendedUse } : {}),
    ...(typeof creative.placement === 'string' && creative.placement.trim().length > 0
      ? { placement: creative.placement }
      : {}),
    prompt,
    status: normalizeRenderedStatus(creative.status),
    artifact_url: mediaArtifactUrl(appBaseUrl, basename),
    aspect_ratio: aspectRatio,
  };
}

/**
 * Bridges Hermes `creative_assets` (at `result[0].artifacts.creative_assets`)
 * into the `weekly_content_plan.image_creatives` shape that
 * `parseSocialContentWorkflowOutput` and the dashboard projection expect.
 *
 * - Only `type: "generated_image"` assets are mapped.
 * - Host-absolute `path` values are rewritten to internal media-serve URLs so
 *   the browser can load them via the authenticated /api/internal/hermes/media
 *   route without needing direct host filesystem access.
 * - Missing/empty `creative_assets` is a no-op; the function never throws.
 */
export function bridgeHermesCreativeAssets(
  outputRecord: Record<string, unknown>,
): Record<string, unknown> {
  const appBaseUrl = resolveAppBaseUrl();
  const artifacts = outputRecord.artifacts;
  const artifactRecord = artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)
    ? artifacts as Record<string, unknown>
    : null;
  const aspectRatio = typeof artifactRecord?.aspectRatio === 'string' ? artifactRecord.aspectRatio : '';

  // Merge into weekly_content_plan, creating the key if absent. Do not
  // overwrite existing image_creatives that the workflow itself emitted unless
  // they need canonicalization into the projection shape.
  const existingPlan =
    outputRecord.weekly_content_plan !== undefined &&
    outputRecord.weekly_content_plan !== null &&
    typeof outputRecord.weekly_content_plan === 'object' &&
    !Array.isArray(outputRecord.weekly_content_plan)
      ? (outputRecord.weekly_content_plan as Record<string, unknown>)
      : {};

  const existingCreatives = Array.isArray(existingPlan.image_creatives)
    ? existingPlan.image_creatives
    : null;

  const canonicalExistingCreatives = existingCreatives
    ?.map((creative, index) => (
      creative !== null && typeof creative === 'object' && !Array.isArray(creative)
        ? canonicalImageCreativeFromExisting(
          creative as HermesImageCreativeLike,
          index,
          appBaseUrl,
          aspectRatio,
        )
        : null
    ))
    .filter((creative): creative is Record<string, unknown> => creative !== null) ?? [];

  if (canonicalExistingCreatives.length > 0) {
    return {
      ...outputRecord,
      weekly_content_plan: {
        ...existingPlan,
        image_creatives: canonicalExistingCreatives,
      },
    };
  }

  const creativeAssets = Array.isArray(artifactRecord?.creative_assets)
    ? artifactRecord.creative_assets
    : [];
  const imageCreativesFromCreativeAssets = creativeAssets
    .map((asset, index) => (
      asset !== null && typeof asset === 'object' && !Array.isArray(asset)
        ? canonicalImageCreativeFromCreativeAsset(
          asset as HermesCreativeAsset,
          index,
          appBaseUrl,
          aspectRatio,
        )
        : null
    ))
    .filter((creative): creative is Record<string, unknown> => creative !== null);

  const images = Array.isArray(artifactRecord?.images)
    ? artifactRecord.images
    : [];
  const imageCreativesFromImages = images
    .map((image, index) => (
      image !== null && typeof image === 'object' && !Array.isArray(image)
        ? canonicalImageCreativeFromGeneratedImage(
          image as HermesGeneratedImage,
          index,
          appBaseUrl,
          aspectRatio,
        )
        : null
    ))
    .filter((creative): creative is Record<string, unknown> => creative !== null);

  const imageCreatives = imageCreativesFromCreativeAssets.length > 0
    ? imageCreativesFromCreativeAssets
    : imageCreativesFromImages;

  if (imageCreatives.length === 0) {
    return outputRecord;
  }

  return {
    ...outputRecord,
    weekly_content_plan: {
      ...existingPlan,
      image_creatives: imageCreatives,
    },
  };
}

function normalizeCallbackStage(stage: HermesRunCallbackPayload['stage']): MarketingStage | null {
  if (stage === 'research') return 'research';
  if (stage === 'planning' || stage === 'strategy') return 'strategy';
  if (stage === 'production') return 'production';
  if (stage === 'publish' || stage === 'approval') return 'publish';
  return null;
}

function normalizeApprovalStage(
  stage: NonNullable<HermesRunCallbackPayload['approval']>['stage'],
): Extract<MarketingStage, 'strategy' | 'production' | 'publish'> {
  if (stage === 'plan' || stage === 'strategy') return 'strategy';
  if (stage === 'creative' || stage === 'video' || stage === 'production') return 'production';
  return 'publish';
}

function isSocialContentRun(run: ExecutionRunRecord): boolean {
  return run.workflow_key === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY;
}

function socialStageForMarketingStage(stage: MarketingStage): SocialContentStage {
  if (stage === 'research') return 'research';
  if (stage === 'strategy') return 'planning';
  if (stage === 'production') return 'copy_production';
  return 'publish_review';
}

function marketingStageForSocialApprovalStep(
  step: SocialContentApprovalStep,
): Extract<MarketingStage, 'strategy' | 'production' | 'publish'> {
  if (step === 'approve_weekly_plan') return 'strategy';
  if (step === 'approve_publish') return 'publish';
  return 'production';
}

function normalizeSocialApprovalStep(payload: HermesRunCallbackPayload): SocialContentApprovalStep | null {
  const approval = payload.approval;
  if (!approval) {
    return null;
  }
  if (
    approval.approval_step === 'approve_weekly_plan'
    || approval.approval_step === 'approve_post_copy'
    || approval.approval_step === 'approve_image_creatives'
    || approval.approval_step === 'approve_video_script'
    || approval.approval_step === 'approve_video_render'
    || approval.approval_step === 'approve_publish'
  ) {
    return approval.approval_step;
  }
  return approvalStepFromWorkflowStepId(approval.workflow_step_id);
}

function stageRank(stage: MarketingStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function marketingStageFromOutputStage(value: unknown): MarketingStage | null {
  if (typeof value !== 'string') return null;
  if (value === 'research') return 'research';
  if (value === 'strategy' || value === 'planning' || value === 'plan_review') return 'strategy';
  if (
    value === 'production'
    || value === 'copy_production'
    || value === 'image_briefing'
    || value === 'image_creatives'
    || value === 'image_generation'
    || value === 'creative_review'
    || value === 'video_script'
    || value === 'video_review'
    || value === 'video_render'
  ) return 'production';
  if (value === 'publish' || value === 'publish_review') return 'publish';
  return null;
}

type StageOutputBundle = {
  runId: string | null;
  summary: { summary: string } | null;
  primaryOutput: Record<string, unknown> | null;
};

function bundleFromStageRecord(
  record: Record<string, unknown>,
  fallbackRunId: string | null,
): StageOutputBundle {
  const summary = typeof record.summary === 'string' && record.summary.trim().length > 0
    ? record.summary.trim()
    : '';
  const runId = typeof record.run_id === 'string' && record.run_id.trim().length > 0
    ? record.run_id.trim()
    : fallbackRunId;
  return {
    runId,
    summary: summary ? { summary } : null,
    primaryOutput: record,
  };
}

// Detect a one-shot Hermes completion that carries per-stage outputs for
// multiple marketing stages in a single callback. Supports two shapes:
//   output: [{ stage: 'research', ... }, { stage: 'strategy', ... }, ...]
//   output: [{ stages: { research: {...}, strategy: {...}, ... } }]
// Returns null if fewer than two distinct stages are present, so single-stage
// callbacks continue down the existing path unchanged.
function extractMultiStageOutputs(
  payload: HermesRunCallbackPayload,
): Map<MarketingStage, StageOutputBundle> | null {
  const fallbackRunId = payload.hermes_run_id ?? null;
  const map = new Map<MarketingStage, StageOutputBundle>();

  const considerEntry = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    const stage = marketingStageFromOutputStage(record.stage);
    if (stage && !map.has(stage)) {
      map.set(stage, bundleFromStageRecord(record, fallbackRunId));
    }
  };

  if (Array.isArray(payload.output)) {
    for (const entry of payload.output) considerEntry(entry);
  }

  const first = firstOutputRecord(payload);
  const stagesField = first?.stages;
  if (Array.isArray(stagesField)) {
    for (const entry of stagesField) considerEntry(entry);
  } else if (stagesField && typeof stagesField === 'object') {
    for (const [key, value] of Object.entries(stagesField as Record<string, unknown>)) {
      const stage = marketingStageFromOutputStage(key);
      if (stage && !map.has(stage) && value && typeof value === 'object' && !Array.isArray(value)) {
        map.set(stage, bundleFromStageRecord(value as Record<string, unknown>, fallbackRunId));
      }
    }
  }

  return map.size >= 2 ? map : null;
}

function firstOutputRecord(payload: HermesRunCallbackPayload): Record<string, unknown> | null {
  if (Array.isArray(payload.output)) {
    const first = payload.output[0];
    return first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : null;
  }
  return payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)
    ? payload.output
    : null;
}

function outputSummary(payload: HermesRunCallbackPayload): { summary: string } | null {
  const output = firstOutputRecord(payload);
  const summary = typeof output?.summary === 'string' && output.summary.trim().length > 0
    ? output.summary.trim()
    : '';
  return summary ? { summary } : null;
}

function outputRunId(payload: HermesRunCallbackPayload, fallback: string | null): string | null {
  const output = firstOutputRecord(payload);
  return typeof output?.run_id === 'string' && output.run_id.trim().length > 0
    ? output.run_id.trim()
    : fallback;
}

/**
 * Returns true when a production-stage callback has image_creatives with at
 * least one entry (i.e. Hermes built the prompts) but none carry an
 * `artifact_url` (i.e. image_generate was never called and no file was
 * rendered). Used by the fail-loud verification gate.
 */
function productionCallbackHasUnrenderedImageCreatives(
  outputRecord: Record<string, unknown> | null,
): boolean {
  if (!outputRecord) return false;
  const plan = outputRecord.weekly_content_plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  const creatives = (plan as Record<string, unknown>).image_creatives;
  if (!Array.isArray(creatives) || creatives.length === 0) return false;
  // At least one entry present — check whether any have a real artifact_url.
  return !creatives.some(
    (c) =>
      c !== null &&
      typeof c === 'object' &&
      !Array.isArray(c) &&
      typeof (c as Record<string, unknown>).artifact_url === 'string' &&
      ((c as Record<string, unknown>).artifact_url as string).trim().length > 0,
  );
}

function summarizeVideoIngestSkips(
  skipped: Array<{ path: string; reason: 'not_allowed' | 'missing' | 'invalid' }>,
): { count: number; reasons: Partial<Record<'not_allowed' | 'missing' | 'invalid', number>> } {
  const reasons: Partial<Record<'not_allowed' | 'missing' | 'invalid', number>> = {};
  for (const entry of skipped) {
    reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
  }
  return {
    count: skipped.length,
    reasons,
  };
}

function ingestSocialContentStageMedia(
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): void {
  if (!isSocialContentRun(run) || !run.marketing_job_id || payload.stage !== 'video_render') {
    return;
  }

  const result = ingestSocialContentVideoRenderOutput(run.marketing_job_id, payload.output);
  if (result.skipped.length > 0) {
    console.warn('[social-content-video-ingest] skipped media during Hermes callback ingest', {
      jobId: run.marketing_job_id,
      skipped: summarizeVideoIngestSkips(result.skipped),
    });
  }
}

/**
 * Counts recognized images across ALL known Hermes output shapes:
 *   1. `artifacts.creative_assets[]` with type="generated_image" and a path/filePath
 *   2. `artifacts.images[]` with a filePath or path value
 *   3. `weekly_content_plan.image_creatives[]` with a non-empty artifact_url
 *
 * A "recognized image" means there is a renderable file reference — a bare
 * prompt entry without a path is NOT recognized. Returns the total count.
 */
function countRecognizedImagesInOutputRecord(
  outputRecord: Record<string, unknown> | null,
): number {
  if (!outputRecord) return 0;

  // Shape 1: artifacts.creative_assets[]
  const artifacts = outputRecord.artifacts;
  const artifactRecord =
    artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)
      ? (artifacts as Record<string, unknown>)
      : null;

  if (artifactRecord) {
    const creativeAssets = Array.isArray(artifactRecord.creative_assets)
      ? artifactRecord.creative_assets
      : [];
    const fromCreativeAssets = creativeAssets.filter((asset) => {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
      const a = asset as Record<string, unknown>;
      if (a.type !== 'generated_image') return false;
      return !!imageBasenameFromValue(a.path) || !!imageBasenameFromValue(a.filePath);
    }).length;
    if (fromCreativeAssets > 0) return fromCreativeAssets;

    // Shape 2: artifacts.images[]
    const images = Array.isArray(artifactRecord.images) ? artifactRecord.images : [];
    const fromImages = images.filter((img) => {
      if (!img || typeof img !== 'object' || Array.isArray(img)) return false;
      const i = img as Record<string, unknown>;
      return !!imageBasenameFromValue(i.filePath) || !!imageBasenameFromValue(i.path);
    }).length;
    if (fromImages > 0) return fromImages;
  }

  // Shape 3: weekly_content_plan.image_creatives[] with artifact_url
  const plan = outputRecord.weekly_content_plan;
  if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
    const creatives = (plan as Record<string, unknown>).image_creatives;
    if (Array.isArray(creatives)) {
      return creatives.filter((c) => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
        const cr = c as Record<string, unknown>;
        return (
          typeof cr.artifact_url === 'string' &&
          (cr.artifact_url as string).trim().length > 0
        );
      }).length;
    }
  }

  return 0;
}

/**
 * Returns true when the production-stage callback declared N image requests
 * (imageCreativeCount > 0 from the job's original request) but zero recognized
 * images appear across ALL known output shapes (creative_assets, images,
 * image_creatives-with-artifact_url). This closes the blind spot where Hermes
 * silently completes with no images but the prompt-only check in
 * `productionCallbackHasUnrenderedImageCreatives` doesn't fire (e.g. when
 * Hermes omits image_creatives entirely).
 *
 * Failure code: `hermes_image_generation_unrecognized`
 */
function productionCallbackImageGenerationUnrecognized(
  doc: MarketingJobRuntimeDocument,
  outputRecord: Record<string, unknown> | null,
): boolean {
  // Determine requested image count from the original job request.
  const imageCreativeCount =
    typeof doc.inputs?.request?.imageCreativeCount === 'number'
      ? doc.inputs.request.imageCreativeCount
      : 0;
  if (imageCreativeCount <= 0) return false;

  return countRecognizedImagesInOutputRecord(outputRecord) === 0;
}

function isHermesMediaSetupError(payload: HermesRunCallbackPayload): boolean {
  const code = payload.error?.code?.toLowerCase() ?? '';
  const message = payload.error?.message.toLowerCase() ?? '';
  return (
    code === 'hermes_media_setup_required'
    || code === 'media_setup_required'
    || code === 'media_auth_required'
    || message.includes('hermes media setup')
    || message.includes('media configuration needs attention')
  );
}

function socialApprovalTitle(step: SocialContentApprovalStep): string {
  if (step === 'approve_weekly_plan') return 'Approve weekly plan';
  if (step === 'approve_post_copy') return 'Approve post copy';
  if (step === 'approve_image_creatives') return 'Approve image creatives';
  if (step === 'approve_video_script') return 'Approve video script';
  if (step === 'approve_video_render') return 'Approve video render';
  return 'Approve publish';
}

function socialApprovalActionLabel(step: SocialContentApprovalStep): string {
  if (step === 'approve_weekly_plan') return 'Approve weekly plan';
  if (step === 'approve_post_copy') return 'Approve copy';
  if (step === 'approve_image_creatives') return 'Approve creatives';
  if (step === 'approve_video_script') return 'Approve script';
  if (step === 'approve_video_render') return 'Approve render';
  return 'Approve publish';
}

function normalizeArtifacts(value: unknown): SocialContentArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
    return {
      id: typeof record.id === 'string' && record.id.trim().length > 0
        ? record.id.trim()
        : `artifact-${index + 1}`,
      type: typeof record.type === 'string' ? record.type : 'artifact',
      title: typeof record.title === 'string' ? record.title : 'Social content artifact',
      status: typeof record.status === 'string' ? record.status : 'created',
      summary: typeof record.summary === 'string' ? record.summary : null,
      url: typeof record.url === 'string'
        ? record.url
        : typeof record.artifact_url === 'string'
          ? record.artifact_url
          : null,
      metadata: record,
    };
  });
}

function approvalTitle(stage: 'strategy' | 'production' | 'publish'): string {
  return stage === 'strategy'
    ? 'Approve campaign strategy'
    : stage === 'production'
      ? 'Approve production plan'
      : 'Approve publishing plan';
}

function actionLabel(stage: 'strategy' | 'production' | 'publish'): string {
  return stage === 'strategy'
    ? 'Approve strategy'
    : stage === 'production'
      ? 'Approve production'
      : 'Approve publishing';
}

function markJobCompleted(doc: MarketingJobRuntimeDocument, stage: MarketingStage, payload: HermesRunCallbackPayload): void {
  markStageCompleted(doc, stage, {
    runId: outputRunId(payload, payload.hermes_run_id ?? null),
    summary: outputSummary(payload),
    primaryOutput: firstOutputRecord(payload),
  });
  clearApprovalCheckpoint(doc, `${stage} completed from Hermes callback`);
  if (stage === 'publish') {
    doc.state = 'completed';
    doc.status = 'completed';
    doc.current_stage = 'publish';
  }
}

function createApprovalCheckpoint(
  doc: MarketingJobRuntimeDocument,
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
  socialApprovalStep: SocialContentApprovalStep | null,
  completedSocialStage: SocialContentStage | null,
): void {
  const approval = payload.approval;
  if (!approval) {
    return;
  }

  const marketingApprovalStage = socialApprovalStep
    ? marketingStageForSocialApprovalStep(socialApprovalStep)
    : normalizeApprovalStage(approval.stage);
  const approvalRecord = createMarketingApprovalRecord({
    tenantId: doc.tenant_id,
    marketingJobId: doc.job_id,
    workflowName: run.workflow_key,
    workflowStepId: approval.workflow_step_id,
    socialContentApprovalStep: socialApprovalStep,
    marketingStage: marketingApprovalStage,
    executionProvider: 'hermes',
    executionResumeToken: approval.resume_token ?? '',
    approvalPrompt: approval.prompt,
    runtimeContext: {
      pipelinePath: run.workflow_key,
      cwd: 'hermes',
      sessionKey: 'marketing',
    },
  });
  saveMarketingApprovalRecord(approvalRecord);

  markStageAwaitingApproval(
    doc,
    marketingApprovalStage,
    {
      approval_id: approvalRecord.approval_id,
      workflow_name: run.workflow_key,
      workflow_step_id: approval.workflow_step_id,
      title: approvalTitle(marketingApprovalStage),
      message: approval.prompt,
      resume_token: approval.resume_token ?? null,
      action_label: actionLabel(marketingApprovalStage),
    },
    {
      runId: outputRunId(payload, payload.hermes_run_id ?? null),
      summary: outputSummary(payload),
      primaryOutput: firstOutputRecord(payload),
    },
  );

  if (socialApprovalStep) {
    markSocialContentStageAwaitingApproval(doc, {
      approvalStep: socialApprovalStep,
      approvalId: approvalRecord.approval_id,
      workflowStepId: approval.workflow_step_id,
      resumeToken: approval.resume_token ?? null,
      summary: outputSummary(payload)?.summary ?? approval.prompt,
      output: firstOutputRecord(payload),
      completedStage: completedSocialStage,
      artifacts: normalizeArtifacts(payload.artifacts),
    });
  }
}

export async function applyHermesMarketingCallback(
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): Promise<void> {
  if (!run.marketing_job_id || !run.stage) {
    return;
  }

  const doc = await loadMarketingJobRuntime(run.marketing_job_id);
  if (!doc) {
    return;
  }

  // For social-content runs, bridge Hermes creative_assets into the
  // image_creatives shape before any output is stored, so every downstream
  // code path (requires_approval, completed, multi-stage) sees URLs it can
  // render. Mutate the first output record in-place; no-op when creative_assets
  // is absent or already has image_creatives populated.
  if (isSocialContentRun(run) && Array.isArray(payload.output) && payload.output.length > 0) {
    const firstOut = payload.output[0];
    if (firstOut && typeof firstOut === 'object' && !Array.isArray(firstOut)) {
      payload.output[0] = bridgeHermesCreativeAssets(firstOut as Record<string, unknown>);
    }
  }

  const callbackStage = normalizeCallbackStage(payload.stage);
  const runStageRank = stageRank(run.stage);
  const callbackStageRank = callbackStage ? stageRank(callbackStage) : runStageRank;
  const targetStage = run.stage;
  const stageRecord = doc.stages[targetStage];
  const isTerminalDoc = doc.state === 'completed' || doc.state === 'failed';
  const isTerminalStage = stageRecord.status === 'completed' || stageRecord.status === 'failed';

  // Ignore callbacks that would regress state (late/duplicate/out-of-order).
  if (
    callbackStageRank < runStageRank
    || isTerminalDoc
    || isTerminalStage
    || (stageRecord.status === 'awaiting_approval' && payload.status === 'running')
  ) {
    return;
  }

  if (payload.status === 'failed' || payload.status === 'cancelled') {
    if (isSocialContentRun(run) && isHermesMediaSetupError(payload)) {
      const error = {
        code: payload.error?.code ?? 'hermes_media_setup_required',
        message: payload.error?.message ?? 'Hermes media configuration needs attention before weekly media generation can continue.',
        stage: targetStage,
        retryable: payload.error?.retryable,
        at: new Date().toISOString(),
        details: { reason: 'hermes_media_setup_required' },
      };
      doc.state = 'needs_connection';
      doc.status = 'needs_connection';
      doc.current_stage = targetStage;
      doc.last_error = error;
      doc.errors.push(error);
      const failedSocialStage =
        socialContentStageFromCallbackStage(payload.stage) ?? socialStageForMarketingStage(targetStage);
      markSocialContentStageFailed(
        doc,
        failedSocialStage,
        error.message,
        firstOutputRecord(payload),
      );
      saveMarketingJobRuntime(doc.job_id, doc);
      return;
    }

    recordStageFailure(doc, targetStage, {
      code: payload.error?.code ?? `hermes_${payload.status}`,
      message: payload.error?.message ?? `Hermes ${payload.status} the ${targetStage} stage.`,
      retryable: payload.error?.retryable,
    });
    if (isSocialContentRun(run)) {
      const failedSocialStage =
        socialContentStageFromCallbackStage(payload.stage) ?? socialStageForMarketingStage(targetStage);
      markSocialContentStageFailed(
        doc,
        failedSocialStage,
        payload.error?.message ?? `Hermes ${payload.status} callback received.`,
        firstOutputRecord(payload),
      );
    }
    saveMarketingJobRuntime(doc.job_id, doc);
    return;
  }

  if (payload.status === 'running') {
    if (stageRecord.status === 'not_started') {
      stageRecord.status = 'in_progress';
      if (!stageRecord.started_at) {
        stageRecord.started_at = new Date().toISOString();
      }
      doc.state = 'running';
      doc.status = 'running';
      doc.current_stage = targetStage;
    }
    if (isSocialContentRun(run)) {
      const runningSocialStage =
        socialContentStageFromCallbackStage(payload.stage) ?? socialStageForMarketingStage(targetStage);
      markSocialContentStageRunning(doc, runningSocialStage, firstOutputRecord(payload));
    }
    saveMarketingJobRuntime(doc.job_id, doc);
    return;
  }

  if (payload.status === 'requires_approval') {
    ingestSocialContentStageMedia(run, payload);
    const socialApprovalStep = isSocialContentRun(run) ? normalizeSocialApprovalStep(payload) : null;
    const completedSocialStage = isSocialContentRun(run)
      ? socialContentStageFromCallbackStage(payload.stage) ?? socialStageForMarketingStage(targetStage)
      : null;

    // Fail loud when Hermes returned an approve_publish checkpoint from the
    // production stage but generated zero actual images (image_creatives have
    // prompts but no artifact_url). This means Hermes skipped the image_generate
    // tool call. Reject as a failed run so the dashboard surfaces a clear error
    // instead of silently completing with 0 images (see mkt_c12eb438).
    if (
      isSocialContentRun(run)
      && targetStage === 'production'
      && socialApprovalStep === 'approve_publish'
      && productionCallbackHasUnrenderedImageCreatives(firstOutputRecord(payload))
    ) {
      const errorMessage =
        'Production stage completed without rendering images: image_generate was not called. ' +
        'Check Hermes logs and retry the production stage.';
      recordStageFailure(doc, targetStage, {
        code: 'hermes_image_generation_skipped',
        message: errorMessage,
        retryable: true,
      });
      markSocialContentStageFailed(
        doc,
        completedSocialStage ?? 'image_generation',
        errorMessage,
        firstOutputRecord(payload),
      );
      saveMarketingJobRuntime(doc.job_id, doc);
      return;
    }

    // Broader fail-loud gate: N images were requested but zero recognized images
    // appear in ANY known output shape (creative_assets, images,
    // image_creatives-with-artifact_url). This closes the blind spot where Hermes
    // silently completes with no image data at all — the prompt-only check above
    // only fires when image_creatives are present but without artifact_url.
    if (
      isSocialContentRun(run)
      && targetStage === 'production'
      && socialApprovalStep === 'approve_publish'
      && productionCallbackImageGenerationUnrecognized(doc, firstOutputRecord(payload))
    ) {
      const errorMessage =
        'Production stage completed with no recognized images in any known output shape ' +
        '(creative_assets, images, image_creatives). ' +
        'Hermes may have returned an unexpected schema. Check Hermes logs and retry.';
      recordStageFailure(doc, targetStage, {
        code: 'hermes_image_generation_unrecognized',
        message: errorMessage,
        retryable: true,
      });
      markSocialContentStageFailed(
        doc,
        completedSocialStage ?? 'image_generation',
        errorMessage,
        firstOutputRecord(payload),
      );
      saveMarketingJobRuntime(doc.job_id, doc);
      return;
    }

    markStageCompleted(doc, targetStage, {
      runId: outputRunId(payload, payload.hermes_run_id ?? null),
      summary: outputSummary(payload),
      primaryOutput: firstOutputRecord(payload),
    });
    if (
      socialApprovalStep === 'approve_publish'
      && isSocialContentRun(run)
      && !isSocialContentPublishApprovalRequired(doc)
    ) {
      // Sweep all intermediate social-content stages up to and including the
      // completedSocialStage to `completed` before going terminal. Without
      // this, stages like copy_production / image_briefing / image_generation
      // can be left in `running` state when the job completes, stranding the
      // run with null output and no images (see mkt_0735c3b1).
      const sweepTarget = completedSocialStage ?? 'publish_review';
      reconcileSocialContentIntermediateStages(
        doc,
        sweepTarget,
        outputSummary(payload)?.summary ?? 'Completed as part of publish-skip.',
      );
      if (completedSocialStage) {
        // Re-apply the callback's own output/artifacts on top of the sweep so
        // the specific stage that triggered this callback has accurate data.
        markSocialContentStageCompleted(doc, completedSocialStage, {
          summary: outputSummary(payload)?.summary ?? 'Publish approval skipped.',
          output: firstOutputRecord(payload),
          artifacts: normalizeArtifacts(payload.artifacts),
        });
      }
      markSocialContentStageCompleted(doc, 'completed', {
        summary: 'Publish approval skipped because publishing is not requested.',
      });
      doc.state = 'completed';
      doc.status = 'completed';
      doc.current_stage = 'publish';
      clearApprovalCheckpoint(doc, 'publish approval skipped because publishing is disabled');
      saveMarketingJobRuntime(doc.job_id, doc);
      return;
    }
    createApprovalCheckpoint(doc, run, payload, socialApprovalStep, completedSocialStage);
    saveMarketingJobRuntime(doc.job_id, doc);
    return;
  }

  if (payload.status === 'completed') {
    ingestSocialContentStageMedia(run, payload);
    const multiStage = extractMultiStageOutputs(payload);
    if (multiStage) {
      for (const stage of STAGE_ORDER) {
        const bundle = multiStage.get(stage);
        if (!bundle) continue;
        const record = doc.stages[stage];
        if (record.status === 'completed' || record.status === 'failed') continue;
        markStageCompleted(doc, stage, {
          runId: bundle.runId,
          summary: bundle.summary,
          primaryOutput: bundle.primaryOutput,
        });
        if (isSocialContentRun(run)) {
          const socialStage = socialStageForMarketingStage(stage);
          markSocialContentStageCompleted(doc, socialStage, {
            summary: bundle.summary?.summary ?? null,
            output: bundle.primaryOutput,
            artifacts: stage === 'publish' ? normalizeArtifacts(payload.artifacts) : undefined,
          });
        }
      }
      clearApprovalCheckpoint(doc, 'multi-stage Hermes completion fan-out');
      if (multiStage.has('publish') && doc.stages.publish.status === 'completed') {
        doc.state = 'completed';
        doc.status = 'completed';
        doc.current_stage = 'publish';
        if (isSocialContentRun(run)) {
          markSocialContentStageCompleted(doc, 'completed', {
            summary: multiStage.get('publish')?.summary?.summary ?? outputSummary(payload)?.summary ?? 'Weekly social content workflow completed.',
          });
        }
        scheduleHermesPublishPerformanceHonchoWrite({
          doc,
          payloadRecord: multiStage.get('publish')?.primaryOutput ?? firstOutputRecord(payload),
        });
      }
      saveMarketingJobRuntime(doc.job_id, doc);
      return;
    }

    markJobCompleted(doc, targetStage, payload);
    if (targetStage === 'publish') {
      scheduleHermesPublishPerformanceHonchoWrite({
        doc,
        payloadRecord: firstOutputRecord(payload),
      });
    }
    if (isSocialContentRun(run)) {
      const completedSocialStage =
        socialContentStageFromCallbackStage(payload.stage) ?? socialStageForMarketingStage(targetStage);
      markSocialContentStageCompleted(doc, completedSocialStage, {
        summary: outputSummary(payload)?.summary ?? null,
        output: firstOutputRecord(payload),
        artifacts: normalizeArtifacts(payload.artifacts),
      });
      if (completedSocialStage === 'publish_review' || targetStage === 'publish') {
        markSocialContentStageCompleted(doc, 'completed', {
          summary: outputSummary(payload)?.summary ?? 'Weekly social content workflow completed.',
        });
      }
    }
    saveMarketingJobRuntime(doc.job_id, doc);
  }
}
