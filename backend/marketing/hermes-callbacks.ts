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
  loadSocialContentJobRuntime,
  markStageAwaitingApproval,
  markStageCompleted,
  recordStageFailure,
  saveSocialContentJobRuntime,
  appendHistory,
  type SocialContentJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';
import { getMarketingExecutionPort, type MarketingExecutionPort } from './execution-port';
import { scheduleHermesPublishPerformanceHonchoWrite } from '@/backend/memory/write-events';
import { approveSocialContentJob } from './orchestrator';
import type { ApproveSocialContentJobRequest, ApproveSocialContentJobResponse } from './orchestrator';
import { ingestProductionCreativeAssetsToDb, isVariantBoardJobAwaitingPick } from './ingest-production-assets';
import { recomputeAndPersistPendingApprovalCount } from './runtime-views';
import { synthesizePublishPostsFromContentPackage } from './synthesize-publish-posts';
import { composeStoryAssetForBaseCreative, resolveStoryCtaText } from './story-composer';
import { autoSchedulePosts, type AutoScheduleInputRow } from './auto-schedule';
import { getBusinessProfile } from '@/backend/tenant/business-profile';
import { pool } from '@/lib/db';

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

// Image extensions recognized as renderable file references.
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

// ---------------------------------------------------------------------------
// Schema-agnostic PNG path harvester (production stage only)
//
// Hermes is a pure LLM agent with no enforced output contract. Rather than
// enumerating every possible field name, we walk the entire callback payload
// and collect any string that looks like a path into the Hermes image cache
// directory. This is the fallback of last resort — the three named-shape
// harvesters (creative_assets, images, image_creatives) run first; this only
// fires when they all return zero AND the callback is from the production stage.
//
// Scoped to production callbacks only to prevent side effects on research /
// strategy callbacks that may contain competitor screenshot URLs or other
// image-like strings that would incorrectly be harvested as generated images.
// This was the regression vector in PR #341 (reverted as v0.1.3.11).
//
// Match criteria (scoped to Hermes cache structure to avoid false-positives):
//   1. The path contains the cache/images segment (host) OR hermes-media
//      (container mount), OR the filename matches the Hermes codex naming
//      convention: openai_codex_* / gpt-image-* / openai_gpt_*
//   2. AND the file ends with a recognized image extension.
//
// Implemented with explicit string operations (no runtime regex over
// arbitrary user input) to prevent ReDoS. Input capped at 1024 chars.
// ---------------------------------------------------------------------------

/** Segment strings that identify the Hermes image cache directory. */
const HERMES_CACHE_SEGMENTS = ['cache/images', 'cache\\images', 'hermes-media'] as const;

/** Filename prefixes Hermes uses when writing generated images. */
const HERMES_FILENAME_PREFIXES = ['openai_codex_', 'openai_gpt_', 'gpt-image-', 'veo_render_'] as const;

/**
 * Returns true when the string value looks like a Hermes-generated image path
 * that lives in the cache directory or has a Hermes-style filename prefix.
 *
 * Only operates on strings ≤ 1024 chars with a recognized image extension.
 * Uses explicit indexOf / startsWith — no runtime regex.
 */
function isHermesCacheImagePath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().slice(0, 1024);
  if (!trimmed) return false;

  // Strip query/fragment before extension check.
  const qIdx = trimmed.indexOf('?');
  const hIdx = trimmed.indexOf('#');
  let pathPart = trimmed;
  if (qIdx !== -1 || hIdx !== -1) {
    const cutAt = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
    pathPart = trimmed.slice(0, cutAt);
  }

  // Must end with a recognized image extension.
  const lastSlash = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  const basename = lastSlash === -1 ? pathPart : pathPart.slice(lastSlash + 1);
  if (!basename) return false;

  const dot = basename.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = basename.slice(dot + 1).toLowerCase();
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return false;

  // Check path contains a Hermes cache segment.
  const lowerPath = pathPart.toLowerCase();
  for (const seg of HERMES_CACHE_SEGMENTS) {
    if (lowerPath.includes(seg)) return true;
  }

  // Check basename has a Hermes-style filename prefix.
  const lowerBasename = basename.toLowerCase();
  for (const prefix of HERMES_FILENAME_PREFIXES) {
    if (lowerBasename.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Recursively walks `node` (any JSON-like value) and collects all string
 * values that pass `isHermesCacheImagePath`. The map is keyed by the path
 * string itself so duplicate occurrences across different schema locations
 * collapse to one entry. Each value carries sibling fields from the same
 * containing object as a best-effort context bundle.
 *
 * Depth is capped at 12 to bound recursion on deeply nested payloads.
 */
function harvestPngPathsRecursively(
  node: unknown,
  found: Map<string, { prompt: string; intendedUse: string; placement: string }>,
  depth: number = 0,
): void {
  if (depth > 12) return;
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    if (isHermesCacheImagePath(node) && !found.has(node)) {
      found.set(node, { prompt: '', intendedUse: '', placement: '' });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      harvestPngPathsRecursively(item, found, depth + 1);
    }
    return;
  }

  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;

    // Before recursing, scan THIS object's string values for cache image paths
    // so we can capture their siblings as context.
    for (const val of Object.values(record)) {
      if (typeof val === 'string' && isHermesCacheImagePath(val) && !found.has(val)) {
        const prompt = typeof record.prompt === 'string' ? record.prompt : '';
        const intendedUse =
          typeof record.intendedUse === 'string'
            ? record.intendedUse
            : typeof record.intended_use === 'string'
              ? record.intended_use
              : typeof record.title === 'string'
                ? record.title
                : '';
        const placement = typeof record.placement === 'string' ? record.placement : '';
        found.set(val, { prompt, intendedUse, placement });
      }
    }

    // Recurse into non-string child values.
    for (const childVal of Object.values(record)) {
      if (typeof childVal !== 'string') {
        harvestPngPathsRecursively(childVal, found, depth + 1);
      }
    }
  }
}

/**
 * Builds canonical `image_creatives` entries from the PNG paths collected by
 * `harvestPngPathsRecursively`. Deduplication is guaranteed because the map
 * is keyed by path string.
 */
function buildCreativesFromPngFallback(
  found: Map<string, { prompt: string; intendedUse: string; placement: string }>,
  appBaseUrl: string,
  aspectRatio: string,
): Array<Record<string, unknown>> {
  const creatives: Array<Record<string, unknown>> = [];
  let index = 0;
  for (const [imagePath, ctx] of found) {
    const basename = imageBasenameFromValue(imagePath);
    if (!basename) continue;

    // Derive a stable assetId from the basename stem's last segment (e.g. hash).
    const dot = basename.lastIndexOf('.');
    const stem = dot === -1 ? basename : basename.slice(0, dot);
    const segments = stem.split('_');
    const hashFragment = segments[segments.length - 1] ?? stem;
    const assetId = `fallback_${hashFragment}_${index}`;

    const creative: Record<string, unknown> = {
      id: `img_${assetId}`,
      title: ctx.intendedUse || ctx.placement || '',
      prompt: ctx.prompt,
      status: 'completed',
      artifact_url: mediaArtifactUrl(appBaseUrl, basename),
      aspect_ratio: aspectRatio,
    };
    if (ctx.intendedUse) creative.intendedUse = ctx.intendedUse;
    if (ctx.placement) creative.placement = ctx.placement;

    creatives.push(creative);
    index++;
  }
  return creatives;
}

/**
 * Extracts the image basename from a string value (file path, URL, etc.).
 *
 * Uses explicit string operations rather than a runtime regex over user-
 * supplied input to avoid polynomial backtracking (ReDoS). Input is capped
 * at 1024 characters as defense-in-depth before any processing.
 */
function imageBasenameFromValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Cap input length: defense-in-depth against pathological inputs.
  const trimmed = value.trim().slice(0, 1024);
  if (!trimmed) return '';

  // Strip a query string or fragment so we operate on the clean path segment.
  const qIdx = trimmed.indexOf('?');
  const hIdx = trimmed.indexOf('#');
  let pathPart = trimmed;
  if (qIdx !== -1 || hIdx !== -1) {
    const cutAt = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
    pathPart = trimmed.slice(0, cutAt);
  }

  // Extract the last path segment (basename).
  const lastSlash = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  const basename = lastSlash === -1 ? pathPart : pathPart.slice(lastSlash + 1);
  if (!basename) return '';

  // Verify it ends with a recognised image extension (case-insensitive).
  const dot = basename.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = basename.slice(dot + 1).toLowerCase();
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return '';

  return basename;
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
 *
 * @param stage - The marketing stage this callback is for. The schema-agnostic
 *   PNG fallback walker ONLY fires for 'production' callbacks. Research, strategy,
 *   and publish callbacks bypass the fallback entirely so competitor screenshots
 *   or other image-like strings in those payloads cannot be misidentified as
 *   generated creatives (regression vector from PR #341).
 */
export function bridgeHermesCreativeAssets(
  outputRecord: Record<string, unknown>,
  stage: MarketingStage = 'production',
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

  if (imageCreatives.length > 0) {
    return {
      ...outputRecord,
      weekly_content_plan: {
        ...existingPlan,
        image_creatives: imageCreatives,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Schema-agnostic fallback: walk the entire output record for any string
  // that looks like a Hermes cache image path. ONLY fires for production
  // callbacks — research/strategy/publish bypass this entirely to prevent
  // competitor screenshot URLs or other image-like strings in those payloads
  // from being misidentified as generated creatives (regression from PR #341).
  // -------------------------------------------------------------------------
  if (stage === 'production') {
    const pngFound = new Map<string, { prompt: string; intendedUse: string; placement: string }>();
    harvestPngPathsRecursively(outputRecord, pngFound);

    if (pngFound.size > 0) {
      const fallbackCreatives = buildCreativesFromPngFallback(pngFound, appBaseUrl, aspectRatio);
      if (fallbackCreatives.length > 0) {
        console.warn('[hermes-image-bridge] schema_variance_recovered', {
          count: fallbackCreatives.length,
          paths: Array.from(pngFound.keys()).map((p) => {
            const lastSlash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
            return lastSlash === -1 ? p : p.slice(lastSlash + 1);
          }),
        });
        return {
          ...outputRecord,
          weekly_content_plan: {
            ...existingPlan,
            image_creatives: fallbackCreatives,
          },
        };
      }
    }
  }

  return outputRecord;
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
 * prompt entry without a path is NOT recognized. Returns the total count
 * across named shapes plus the schema-agnostic fallback walker (Shape 4).
 *
 * NOTE: This function is only called from `productionCallbackImageGenerationUnrecognized`
 * which is itself gated to production-stage callbacks. Shape 4 therefore only
 * fires in production context — consistent with the stage-gated bridge.
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
      const fromCreatives = creatives.filter((c) => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
        const cr = c as Record<string, unknown>;
        return (
          typeof cr.artifact_url === 'string' &&
          (cr.artifact_url as string).trim().length > 0
        );
      }).length;
      if (fromCreatives > 0) return fromCreatives;
    }
  }

  // Shape 4: schema-agnostic fallback — walk the entire record for Hermes cache paths.
  // Safe here because callers of this function are already gated to production stage.
  const pngFound = new Map<string, { prompt: string; intendedUse: string; placement: string }>();
  harvestPngPathsRecursively(outputRecord, pngFound);
  return pngFound.size;
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
  doc: SocialContentJobRuntimeDocument,
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
    ? 'Approve social content strategy'
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

/**
 * After a non-publish stage completes cleanly (no approval emitted), submit
 * the next stage to Hermes automatically. Guards cover R1, R2, R4, R5 from the
 * auto-advance plan. Port is injectable for testability; callers pass
 * getMarketingExecutionPort() in production.
 *
 * Exported for unit tests; not part of the public module API.
 */
export async function maybeAutoAdvanceNextStage(
  doc: SocialContentJobRuntimeDocument,
  completedStage: MarketingStage,
  payload: HermesRunCallbackPayload,
  port: MarketingExecutionPort,
): Promise<void> {
  // R4: publish is terminal — never auto-advance past it.
  if (completedStage === 'publish') return;
  // If doc already reached a terminal state, do nothing.
  if (doc.state === 'completed' || doc.state === 'failed') return;
  // R1: never fire when Hermes emitted an approval checkpoint.
  if (payload.approval) return;

  const idx = STAGE_ORDER.indexOf(completedStage);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return;
  const nextStage = STAGE_ORDER[idx + 1];
  if (!nextStage) return;
  const nextRecord = doc.stages[nextStage];
  if (!nextRecord) return;

  // R5: idempotency — only advance if next stage is untouched.
  if (nextRecord.status !== 'not_started') return;

  // M1: tenantId is required to route the new run correctly.
  if (!doc.tenant_id) {
    recordStageFailure(doc, nextStage, {
      code: 'auto_advance_missing_tenant',
      message: 'auto-advance aborted: doc.tenant_id missing',
      retryable: false,
    });
    return;
  }

  // R5: mark next stage running BEFORE submit + save doc so any racing
  // callback or retry sees a non-not_started status.
  nextRecord.status = 'in_progress';
  nextRecord.started_at = new Date().toISOString();
  doc.current_stage = nextStage;
  doc.state = 'running';
  doc.status = 'running';
  appendHistory(doc, `auto-advancing to ${nextStage} (Hermes returned completed without approval)`, {
    stage: nextStage,
  });
  saveSocialContentJobRuntime(doc.job_id, doc);

  // M4: explicit try/catch — write failure to doc before returning.
  try {
    const result = await port.submitNextStage({
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      doc,
      stage: nextStage,
    });
    if (result.kind === 'completed' && result.output.ok === false) {
      throw new Error(result.output.error?.message ?? 'auto_advance_submission_rejected');
    }
    appendHistory(doc, `auto-advance submitted ${nextStage} to Hermes`, { stage: nextStage });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordStageFailure(doc, nextStage, {
      code: 'auto_advance_submit_failed',
      message,
      retryable: true,
    });
    console.error('[hermes-callbacks] auto_advance_submit_failed', {
      job_id: doc.job_id,
      from_stage: completedStage,
      to_stage: nextStage,
      error: message,
    });
  }
}

/**
 * Returns true when `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` is set to a truthy
 * value. Default OFF preserves production human-in-the-loop semantics.
 *
 * Exported for unit tests; not part of the public module API.
 */
export function autoApproveMarketingPipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

type AutoApproveFn = (
  input: ApproveSocialContentJobRequest,
  doc: SocialContentJobRuntimeDocument,
) => Promise<ApproveSocialContentJobResponse>;

type PublishGuardrailReason =
  | { kind: 'preflight_failed'; status: string }
  | { kind: 'preflight_check_failed'; check: string }
  | { kind: 'publishing_status_invalid'; status: string }
  | { kind: 'review_rejected' }
  | { kind: 'publish_not_ready' };

/**
 * Inspect a publish-stage callback payload for signals that the run is NOT
 * safe to auto-approve. Returns the first matching signal, or null if the
 * payload looks safe.
 *
 * Recognized refusal signals (anywhere in the output records):
 *   - Any of the preflight boolean checks is `false` — content-quality gate
 *     explicitly failed (new 3-profile Hermes shape, per mkt_b83fc598 fixture).
 *   - `publishing_status` exists and is not 'completed' or 'in_progress'.
 *   - `published_review_status === 'rejected'` — human reviewer rejected.
 *   - `publish_ready === false` — legacy fallback (no-op when null).
 *   - `preflight_check.status === 'failed'` — legacy fallback (old monolith shape).
 *
 * Why: auto-approve bypasses human review by design; without this gate a
 * "completed" pipeline with failed preflight checks would be promoted to the
 * launch state with no content (see mkt_bb1c146c-* incident).
 */
function findPublishAutoApproveRefusalSignal(
  payload: HermesRunCallbackPayload | undefined,
): PublishGuardrailReason | null {
  if (!payload) return null;
  const records: Record<string, unknown>[] = Array.isArray(payload.output)
    ? payload.output.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)
      ? [payload.output as Record<string, unknown>]
      : [];

  const PREFLIGHT_BOOLEAN_CHECKS = [
    'all_posts_have_assets',
    'all_assets_completed',
    'all_posts_have_platforms',
    'all_posts_have_cta',
    'all_posts_have_hashtags',
    'approval_safe_language',
    'human_review_positioning_preserved',
  ] as const;

  for (const record of records) {
    // Legacy fallback: explicit publish_ready=false signal
    if (record.publish_ready === false) {
      return { kind: 'publish_not_ready' };
    }

    const preflight = record.preflight_check;
    if (preflight && typeof preflight === 'object' && !Array.isArray(preflight)) {
      const preflightRecord = preflight as Record<string, unknown>;

      // New shape: boolean content-quality checks
      for (const check of PREFLIGHT_BOOLEAN_CHECKS) {
        if (preflightRecord[check] === false) {
          return { kind: 'preflight_check_failed', check };
        }
      }

      // Legacy fallback: old monolith preflight_check.status field
      const status = preflightRecord.status;
      if (typeof status === 'string' && status.trim().toLowerCase() === 'failed') {
        return { kind: 'preflight_failed', status: status.trim() };
      }
    }

    // publishing_status exists and is not a safe terminal/in-flight value
    if (typeof record.publishing_status === 'string') {
      const ps = record.publishing_status.trim();
      if (ps !== 'completed' && ps !== 'in_progress') {
        return { kind: 'publishing_status_invalid', status: ps };
      }
    }

    // published_review_status === 'rejected' means a human vetoed
    if (record.published_review_status === 'rejected') {
      return { kind: 'review_rejected' };
    }
  }
  return null;
}

/**
 * After a `requires_approval` callback writes an approval checkpoint to the doc,
 * call `approveSocialContentJob` with `approvedBy: 'ai-orchestrator'` so the pipeline
 * advances without a human click. Default OFF; opt in per-process via
 * `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1`.
 *
 * The injectable `approve` parameter exists for unit tests; production callers
 * default to the real `approveSocialContentJob`. Same pattern as
 * `maybeAutoAdvanceNextStage`'s injectable port.
 *
 * Exported for unit tests; not part of the public module API.
 */
export async function maybeAutoApproveMarketingCheckpoint(
  doc: SocialContentJobRuntimeDocument,
  approve: AutoApproveFn = approveSocialContentJob,
  env: NodeJS.ProcessEnv = process.env,
  payload?: HermesRunCallbackPayload,
): Promise<void> {
  // Onboarding variant-board jobs must auto-advance through strategy/production
  // on their own — the board + the user's pick IS the approval — even when the
  // global ARIES_AUTO_APPROVE_MARKETING_PIPELINE flag is OFF; otherwise the 3
  // variants would stall at strategy approval and never generate. Their PUBLISH
  // stage is still held until the pick releases the chosen job (handled below).
  const globalAutoApprove = autoApproveMarketingPipelineEnabled(env);
  const variantAwaitingPick = isVariantBoardJobAwaitingPick(doc);
  if (!globalAutoApprove && !variantAwaitingPick) return;

  const checkpoint = doc.approvals.current;
  if (!checkpoint) return;
  if (!checkpoint.approval_id) return;
  // Publish-skip branch terminates the doc before this is reached; defensive guard.
  if (doc.state === 'completed' || doc.state === 'failed') return;
  // approveSocialContentJob requires tenantId (orchestrator.ts:1716).
  if (!doc.tenant_id) return;

  // Only strategy/production/publish have approval gates. Research has no gate;
  // a checkpoint here would be a misroute and should not be auto-approved.
  const stage = checkpoint.stage;
  if (stage !== 'strategy' && stage !== 'production' && stage !== 'publish') return;

  // A variant-board job that hasn't been picked yet holds at publish: the board
  // shows the production image, and only the pick (variant_pick_finalized) lets
  // the chosen job publish. The unchosen variants never publish.
  if (variantAwaitingPick && stage === 'publish') {
    appendHistory(doc, 'variant-board job: holding publish checkpoint until pick', { stage });
    saveSocialContentJobRuntime(doc.job_id, doc);
    return;
  }

  // Publish-stage guardrail: refuse to auto-approve when the callback payload
  // explicitly signals the run is not ready. Without this, a "completed"
  // pipeline with preflight_check.status='failed' or publish_ready=false can be
  // silently promoted with no content (see mkt_bb1c146c-* QA incident).
  if (stage === 'publish') {
    const refusal = findPublishAutoApproveRefusalSignal(payload);
    if (refusal) {
      const reason =
        refusal.kind === 'preflight_check_failed'
          ? `preflight_check.${refusal.check}=false`
          : refusal.kind === 'preflight_failed'
            ? `preflight_check.status=${refusal.status}`
            : refusal.kind === 'publishing_status_invalid'
              ? `publishing_status=${refusal.status}`
              : refusal.kind === 'review_rejected'
                ? 'published_review_status=rejected'
                : 'publish_ready=false';
      appendHistory(
        doc,
        `auto-approve refused for publish: ${reason}; leaving checkpoint for human review`,
        { stage },
      );
      recordStageFailure(doc, 'publish', {
        code: 'publish_auto_approve_refused',
        message: `Auto-approve refused: ${reason}. Run is not safe to promote without human review.`,
        retryable: false,
      });
      saveSocialContentJobRuntime(doc.job_id, doc);
      console.error('[hermes-callbacks] publish_auto_approve_refused', {
        job_id: doc.job_id,
        reason: refusal,
      });
      return;
    }
  }

  appendHistory(
    doc,
    `auto-approving ${stage} checkpoint${variantAwaitingPick ? ' (variant-board auto-advance to production)' : ' (ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1)'}`,
    { stage },
  );
  saveSocialContentJobRuntime(doc.job_id, doc);

  try {
    const response = await approve(
      {
        jobId: doc.job_id,
        tenantId: doc.tenant_id,
        approvedBy: 'ai-orchestrator',
        approvalId: checkpoint.approval_id,
        approvedStages: [stage],
        publishConfig: stage === 'publish'
          ? (checkpoint.publish_config ?? undefined)
          : undefined,
      },
      doc,
    );

    // Idempotency: parallel resolution from another caller is benign.
    if (response.status === 'error' && response.reason === 'approval_not_available') {
      appendHistory(doc, `auto-approve no-op: ${stage} checkpoint already resolved`, { stage });
      saveSocialContentJobRuntime(doc.job_id, doc);
      return;
    }
    if (response.status === 'error' && response.reason === 'approval_resolution_in_progress') {
      appendHistory(doc, `auto-approve no-op: ${stage} checkpoint resolution in flight`, { stage });
      saveSocialContentJobRuntime(doc.job_id, doc);
      return;
    }
    if (response.status === 'error') {
      // Don't recordStageFailure — that would conflict with the checkpoint
      // restored by resolveMarketingApproval's catch. Just log; reaper recovers.
      appendHistory(doc, `auto-approve failed for ${stage}: ${response.reason ?? 'unknown'}`, { stage });
      saveSocialContentJobRuntime(doc.job_id, doc);
      console.error('[hermes-callbacks] auto_approve_failed', {
        job_id: doc.job_id,
        stage,
        reason: response.reason,
      });
      return;
    }
    appendHistory(
      doc,
      `auto-approved ${stage}; resumed_stage=${response.resumedStage ?? 'none'} completed=${response.completed}`,
      { stage },
    );
    saveSocialContentJobRuntime(doc.job_id, doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendHistory(doc, `auto-approve threw for ${stage}: ${message}`, { stage });
    saveSocialContentJobRuntime(doc.job_id, doc);
    console.error('[hermes-callbacks] auto_approve_threw', {
      job_id: doc.job_id,
      stage,
      error: message,
    });
  }
}

function markJobCompleted(doc: SocialContentJobRuntimeDocument, stage: MarketingStage, payload: HermesRunCallbackPayload): void {
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

/**
 * On publish-stage completion, turn the Hermes pipeline output into real
 * `posts` rows. The Hermes-native pipeline never emits the legacy
 * `publish_package`, so without this a completed pipeline leaves the operator
 * with zero launch items. `synthesizePublishPostsFromContentPackage` builds
 * draft posts from the `content_package` copy + ingested `creative_assets`, and
 * no-ops when a real `publish_package` is present. Non-fatal: a synthesis
 * failure must not break the callback's completion bookkeeping — the run is
 * already done; the worst case is an empty launch view, recoverable on replay.
 */
async function synthesizePublishPostsOnCompletion(
  doc: SocialContentJobRuntimeDocument,
  publishRunId: string | null,
): Promise<void> {
  try {
    const tenantNum = Number(doc.tenant_id);
    if (!Number.isFinite(tenantNum) || tenantNum <= 0) return;
    const brandPrimaryHex = doc.brand_kit?.colors?.primary ?? null;
    await synthesizePublishPostsFromContentPackage({
      jobId: doc.job_id,
      tenantId: tenantNum,
      doc,
      publishRunId,
      pool,
      // Back promoted story posts with a composed 9:16 image (headline + brand
      // CTA baked in) — Meta story publishing renders only pixels. Returns null
      // on failure so the story falls back to the raw creative.
      composeStoryAsset: ({ tenantId, jobId, baseAssetId, headline }) =>
        composeStoryAssetForBaseCreative({
          db: pool,
          tenantId,
          jobId,
          baseAssetId,
          headline,
          ctaText: resolveStoryCtaText(),
          brandPrimaryHex,
        }),
    });
  } catch (err) {
    console.warn('[hermes-callbacks] synthesizePublishPostsFromContentPackage failed — continuing', {
      jobId: doc.job_id,
      error: (err as Error)?.message ?? String(err),
    });
  }

  // Autonomous mode (ARIES_AUTO_APPROVE_MARKETING_PIPELINE) auto-fires every
  // approval gate in the pipeline. Without an auto-schedule step here, the
  // operator is left with N approved-but-unscheduled posts and a manual
  // drag-to-Calendar step — inconsistent with the rest of autonomous mode and
  // exactly where slice-A QA paused. Gated behind the same flag so
  // human-approval tenants keep the legacy "approve, then place on Calendar"
  // flow. Best-effort — a schedule failure must NOT undo synthesis.
  if (autoApproveMarketingPipelineEnabled()) {
    try {
      await autoScheduleApprovedPostsForJob(doc);
    } catch (err) {
      console.warn('[hermes-callbacks] autoSchedulePosts failed — continuing', {
        jobId: doc.job_id,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
}

/**
 * Join the synthesized `posts` rows for this job against the publish-stage
 * `weekly_schedule[]` to pull the strategist's per-post `recommended_day`,
 * then hand off to `autoSchedulePosts` for slot computation + DB upsert.
 * Returns nothing on success; logs a one-line audit summary so the dispatcher
 * can correlate ingest with the scheduled-posts-worker pickup.
 *
 * Join key: `posts.idempotency_key` of the form `${jobId}:${postNumber}:${platform}`
 * (built by `synthesize-publish-posts.ts:353`). Parsing the post_number out of
 * the key is the only way to deterministically match a post row back to its
 * `weekly_schedule[]` entry — using SELECT row order would silently break for
 * any package with uneven platform fan-out (e.g. post 1 = [IG, FB], post 2 =
 * [IG only] would mis-ordinal the third row).
 */
async function autoScheduleApprovedPostsForJob(doc: SocialContentJobRuntimeDocument): Promise<void> {
  // Onboarding variant-board candidates must NOT auto-publish before the user
  // picks — a held variant is a board option, not a final post. The pick endpoint
  // releases the chosen job (variant_pick_finalized). Non-variant jobs are
  // unaffected (no variant_batch_id → false).
  if (isVariantBoardJobAwaitingPick(doc)) {
    console.info('[hermes-callbacks] autoSchedulePosts skipped — variant-board job awaiting pick', { jobId: doc.job_id });
    return;
  }

  const tenantNum = Number(doc.tenant_id);
  if (!Number.isFinite(tenantNum) || tenantNum <= 0) return;

  const weeklySchedule = readWeeklySchedule(doc);
  if (weeklySchedule.length === 0) {
    console.info('[hermes-callbacks] autoSchedulePosts skipped — no weekly_schedule', { jobId: doc.job_id });
    return;
  }

  const postWindow = readCampaignWindow(doc);
  if (!postWindow) {
    console.info('[hermes-callbacks] autoSchedulePosts skipped — no post window', { jobId: doc.job_id });
    return;
  }

  // Include idempotency_key so we can recover the strategist-assigned
  // post_number regardless of insert order, and surface/media_type so an
  // auto-promoted image story is scheduled on its OWN surface (synthesize wrote
  // surface='story', which the strategist weekly_schedule never emits) rather
  // than collapsing onto its feed sibling's slot. ORDER BY id is added for
  // stable logging output even though the ordinal mapping does not depend on it.
  const postRows = await pool.query<AutoSchedulePostRow>(
    `SELECT id, platform, idempotency_key, surface, media_type
       FROM posts
      WHERE job_id = $1 AND tenant_id = $2
      ORDER BY id`,
    [doc.job_id, tenantNum],
  );
  if (postRows.rowCount === 0) {
    console.info('[hermes-callbacks] autoSchedulePosts skipped — no posts yet', { jobId: doc.job_id });
    return;
  }

  const tenantTimezone = await readTenantTimezone(tenantNum);

  const rows = buildAutoScheduleRows(postRows.rows, weeklySchedule, doc.job_id);

  const result = await autoSchedulePosts({
    jobId: doc.job_id,
    tenantId: tenantNum,
    tenantTimezone,
    campaignStart: postWindow.start,
    campaignEnd: postWindow.end,
    rows,
    queryable: pool,
  });

  console.info('[hermes-callbacks] autoSchedulePosts completed', {
    jobId: doc.job_id,
    scheduled: result.scheduled,
    skipped: result.skipped,
    errors: result.errors.length,
  });
}

/** Shape of the `posts` columns auto-scheduling reads. */
export interface AutoSchedulePostRow {
  id: number;
  platform: string;
  idempotency_key: string | null;
  surface: string | null;
  media_type: string | null;
}

/**
 * Map synthesized `posts` rows to auto-schedule input rows. The strategist's
 * `weekly_schedule[]` supplies the recommended DAY per (ordinal, platform), but
 * the publish SURFACE and MEDIA TYPE are taken from the post's OWN columns:
 * synthesize already resolved the strategist placement into `posts.surface` for
 * feed posts and wrote `surface='story'` for auto-promoted image stories, which
 * the strategist schedule never emits. Deriving surface from the schedule here
 * (as the code once did) silently re-routed every promoted story back onto its
 * feed sibling's slot — the composed 9:16 image then published to the feed
 * instead of as a story. Exported for direct unit testing of that contract.
 */
export function buildAutoScheduleRows(
  postRows: ReadonlyArray<AutoSchedulePostRow>,
  weeklySchedule: ReadonlyArray<WeeklyScheduleEntry>,
  jobId: string,
): AutoScheduleInputRow[] {
  // Map post_number → (platform → recommendedDay) using the strategist's
  // weekly_schedule output. Falls back to (idx + 1) when the strategist omitted
  // an explicit post_number, matching how synthesize-publish-posts assigns
  // ordinals when the field is missing. Only the recommended DAY is consumed.
  const targetByPlatformByOrdinal = new Map<number, Map<string, PlatformScheduleTarget>>();
  weeklySchedule.forEach((entry, idx) => {
    const ordinal = typeof entry.post_number === 'number' ? entry.post_number : idx + 1;
    const platformMap = new Map<string, PlatformScheduleTarget>();
    const day = entry.recommended_day ?? null;
    const entrySurface = normalizeScheduleSurface(entry.placement);
    const entryMediaType = normalizeScheduleMediaType(entry.media_type);
    // Accept `platforms` (flat string[], current Hermes wire shape) or `platform_targets` (legacy).
    if (Array.isArray(entry.platforms) && entry.platforms.length > 0) {
      for (const p of entry.platforms) {
        const platformKey = String(p || '').trim().toLowerCase();
        if (platformKey) {
          platformMap.set(platformKey, { recommendedDay: day, surface: entrySurface, mediaType: entryMediaType });
        }
      }
    } else {
      for (const target of entry.platform_targets ?? []) {
        const platformKey = String(target.platform || '').trim().toLowerCase();
        if (platformKey) {
          platformMap.set(platformKey, {
            recommendedDay: day,
            surface: normalizeScheduleSurface(target.placement ?? entry.placement),
            mediaType: normalizeScheduleMediaType(target.media_type ?? entry.media_type),
          });
        }
      }
    }
    targetByPlatformByOrdinal.set(ordinal, platformMap);
  });

  return postRows
    .map((row): AutoScheduleInputRow | null => {
      const ordinal = parsePostNumberFromIdempotencyKey(row.idempotency_key, jobId);
      if (ordinal === null) {
        console.warn('[hermes-callbacks] autoSchedulePosts skipping row with unparseable idempotency_key', {
          jobId,
          postId: row.id,
          idempotencyKey: row.idempotency_key,
        });
        return null;
      }
      // Recommended DAY comes from the strategist schedule; SURFACE + MEDIA TYPE
      // come from the post's own authoritative columns (see doc-comment above).
      const target = targetByPlatformByOrdinal.get(ordinal)?.get(row.platform.toLowerCase());
      return {
        postId: row.id,
        platform: row.platform,
        recommendedDay: target?.recommendedDay ?? null,
        surface: normalizeScheduleSurface(row.surface),
        mediaType: normalizeScheduleMediaType(row.media_type),
      };
    })
    .filter((r): r is AutoScheduleInputRow => r !== null);
}

export type MetaScheduleSurface = 'feed' | 'story' | 'reel';
export type MetaScheduleMediaType = 'image' | 'video';

export interface WeeklyScheduleEntry {
  post_number?: number;
  recommended_day?: string | null;
  platforms?: string[];
  /**
   * Per-entry surface + media_type the strategist emits for the whole post.
   * `platform_targets[]` may override these per platform.
   */
  placement?: MetaScheduleSurface;
  media_type?: MetaScheduleMediaType;
  platform_targets?: Array<{ platform?: string; placement?: MetaScheduleSurface; media_type?: MetaScheduleMediaType }>;
}

/** A platform's resolved (surface, media_type) for one schedule ordinal. */
export interface PlatformScheduleTarget {
  recommendedDay: string | null;
  surface: MetaScheduleSurface;
  mediaType: MetaScheduleMediaType;
}

function normalizeScheduleSurface(value: unknown): MetaScheduleSurface {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'story' || v === 'reel' ? v : 'feed';
}

function normalizeScheduleMediaType(value: unknown): MetaScheduleMediaType {
  return typeof value === 'string' && value.trim().toLowerCase() === 'video' ? 'video' : 'image';
}

export function readWeeklySchedule(doc: SocialContentJobRuntimeDocument): WeeklyScheduleEntry[] {
  const primary = doc.stages?.publish?.primary_output;
  if (!primary || typeof primary !== 'object') return [];
  // Hermes emits `schedule` (current wire shape); fall back to `weekly_schedule` for compat.
  const ws = 'schedule' in primary
    ? (primary as { schedule?: unknown }).schedule
    : 'weekly_schedule' in primary
      ? (primary as { weekly_schedule?: unknown }).weekly_schedule
      : null;
  return Array.isArray(ws) ? (ws as WeeklyScheduleEntry[]) : [];
}

function readCampaignWindow(doc: SocialContentJobRuntimeDocument): { start: Date; end: Date } | null {
  // Start: the marketing job's created_at. End: the one_off campaignEndDate
  // when present, else fall back to start + 14 days (matches the
  // legacy weekly window). Returns null if neither can be parsed.
  const start = doc.created_at ? new Date(doc.created_at) : null;
  if (!start || !Number.isFinite(start.getTime())) return null;
  const request = doc.inputs?.request as { oneOff?: { campaignEndDate?: string } } | undefined;
  const endRaw = request?.oneOff?.campaignEndDate;
  if (endRaw) {
    const end = new Date(endRaw);
    if (Number.isFinite(end.getTime()) && end > start) {
      return { start, end };
    }
  }
  return { start, end: new Date(start.getTime() + 14 * 24 * 3600 * 1000) };
}

/**
 * Recover the strategist's `post_number` from a synthesized `posts.idempotency_key`
 * built as `${jobId}:${postNumber}:${platform}` by `synthesize-publish-posts.ts:353`.
 * Returns null on null/malformed input — the caller logs a warning and skips
 * that row rather than mis-mapping its `recommended_day`.
 */
function parsePostNumberFromIdempotencyKey(key: string | null, jobId: string): number | null {
  if (!key) return null;
  const prefix = `${jobId}:`;
  if (!key.startsWith(prefix)) return null;
  const tail = key.slice(prefix.length);
  const colonIdx = tail.indexOf(':');
  if (colonIdx < 1) return null;
  const numberPart = tail.slice(0, colonIdx);
  const parsed = Number(numberPart);
  if (!Number.isFinite(parsed) || parsed <= 0 || Math.floor(parsed) !== parsed) return null;
  return parsed;
}

async function readTenantTimezone(tenantId: number): Promise<string | null> {
  try {
    const client = await pool.connect();
    try {
      const profile = await getBusinessProfile(client, String(tenantId));
      return profile.timezone || null;
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('[hermes-callbacks] readTenantTimezone failed — using default', {
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }
}

/**
 * Ingest the production stage's creative_assets into the DB.
 *
 * MUST run AFTER markStageCompleted/markJobCompleted has written the production
 * stage's `primary_output` onto the doc: `ingestProductionCreativeAssetsToDb`
 * reads `doc.stages.production.primary_output`, and the callback loads a fresh
 * doc whose production stage is still `in_progress` (primary_output === null)
 * until the completion writer runs. Calling it earlier silently ingests zero
 * rows. Non-fatal — an ingest failure must not break completion bookkeeping.
 */
async function ingestProductionCreativeAssetsOnCompletion(
  doc: SocialContentJobRuntimeDocument,
): Promise<void> {
  try {
    const tenantNum = Number(doc.tenant_id);
    if (!Number.isFinite(tenantNum) || tenantNum <= 0) return;
    await ingestProductionCreativeAssetsToDb({
      jobId: doc.job_id,
      tenantId: tenantNum,
      doc,
      pool,
    });
  } catch (err) {
    console.warn('[hermes-callbacks] ingestProductionCreativeAssetsToDb failed — continuing', {
      jobId: doc.job_id,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

function createApprovalCheckpoint(
  doc: SocialContentJobRuntimeDocument,
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
  await applyHermesMarketingCallbackInner(run, payload);

  // WRITE SITES #2 + #3 (Hermes stage advances + production creative_assets
  // ingestion): this callback is the single entry point for every Hermes-driven
  // mutation -- stage transitions (markStageCompleted / markJobCompleted /
  // maybeAutoAdvanceNextStage), approval checkpoints, and the production
  // creative_assets DB ingestion (ingestProductionCreativeAssetsOnCompletion)
  // that writes creative_assets WITHOUT building a workspace view. All of those
  // can change the pending-approval count, and saveSocialContentJobRuntime
  // itself is sync/no-DB-context (so it cannot recompute). Recompute + persist
  // the denormalized badge count here, once, off the settled doc -- covering the
  // full advance + ingestion surface in one place with tenant/DB context.
  // Non-fatal: a recompute failure must never break callback idempotency.
  if (run.marketing_job_id) {
    try {
      await recomputeAndPersistPendingApprovalCount(run.marketing_job_id);
    } catch (err) {
      console.warn('[hermes-callbacks] pending-approval count recompute failed -- continuing', {
        jobId: run.marketing_job_id,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
}

async function applyHermesMarketingCallbackInner(
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): Promise<void> {
  if (!run.marketing_job_id || !run.stage) {
    return;
  }

  const doc = await loadSocialContentJobRuntime(run.marketing_job_id);
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
      // Pass run.stage so the schema-agnostic PNG fallback walker only fires
      // for production callbacks — research/strategy/publish bypass it entirely.
      payload.output[0] = bridgeHermesCreativeAssets(firstOut as Record<string, unknown>, run.stage);
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
      saveSocialContentJobRuntime(doc.job_id, doc);
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
    saveSocialContentJobRuntime(doc.job_id, doc);
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
    saveSocialContentJobRuntime(doc.job_id, doc);
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
      saveSocialContentJobRuntime(doc.job_id, doc);
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
      saveSocialContentJobRuntime(doc.job_id, doc);
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
      // Mark publish stage completed with a timestamp so downstream consumers
      // (audit-trail UI, retro tooling, the goal-loop hook) see a fully-populated
      // stage record. Without this, publish.completed_at stays null on every
      // publish-skip run, which makes "all 4 stages completed_at non-null"
      // criteria impossible to satisfy without connecting Meta.
      const publishStage = doc.stages.publish;
      if (publishStage && publishStage.status !== 'completed') {
        publishStage.status = 'completed';
        publishStage.completed_at = new Date().toISOString();
        if (!publishStage.started_at) {
          publishStage.started_at = publishStage.completed_at;
        }
        if (!publishStage.summary) {
          publishStage.summary = { summary: 'Publish skipped: publishing not requested.' };
        }
      }
      clearApprovalCheckpoint(doc, 'publish approval skipped because publishing is disabled');
      // Ingest production creative_assets on THIS terminal path too. The
      // `payload.status === 'completed'` branch below ingests on completion, but
      // when publishing is not required the job completes directly from the
      // production `requires_approval` (approve_publish) callback and previously
      // returned here WITHOUT ingesting — leaving rendered images out of
      // creative_assets, so the dashboard showed "No launch items" despite a real
      // render. doc.stages.production.primary_output is already populated by the
      // markStageCompleted call above, so this reads the rendered image paths.
      await ingestProductionCreativeAssetsOnCompletion(doc);
      saveSocialContentJobRuntime(doc.job_id, doc);
      return;
    }
    createApprovalCheckpoint(doc, run, payload, socialApprovalStep, completedSocialStage);
    saveSocialContentJobRuntime(doc.job_id, doc);
    await maybeAutoApproveMarketingCheckpoint(doc, undefined, undefined, payload);
    return;
  }

  if (payload.status === 'completed') {
    // NOTE: production creative_assets ingestion runs LATER — after the
    // completion writer (markStageCompleted / markJobCompleted) has populated
    // doc.stages.production.primary_output. Ingesting here would read a still-
    // null primary_output and silently insert zero rows.
    const isProductionCompletion = payload.stage === 'production' || targetStage === 'production';
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
      // Ingest production creative_assets now that the markStageCompleted loop
      // above has written doc.stages.production.primary_output. Must precede
      // synthesizePublishPostsOnCompletion so the synthesized posts can link
      // their creative_asset_ids.
      if (multiStage.has('production')) {
        await ingestProductionCreativeAssetsOnCompletion(doc);
      }
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
        await synthesizePublishPostsOnCompletion(
          doc,
          multiStage.get('publish')?.runId ?? payload.hermes_run_id ?? null,
        );
      }
      saveSocialContentJobRuntime(doc.job_id, doc);
      return;
    }

    markJobCompleted(doc, targetStage, payload);
    // Ingest production creative_assets now that markJobCompleted has written
    // doc.stages.production.primary_output (see ingestProductionCreativeAssets-
    // OnCompletion — it reads from the doc, which was null until this point).
    if (isProductionCompletion) {
      await ingestProductionCreativeAssetsOnCompletion(doc);
    }
    if (targetStage === 'publish') {
      scheduleHermesPublishPerformanceHonchoWrite({
        doc,
        payloadRecord: firstOutputRecord(payload),
      });
      await synthesizePublishPostsOnCompletion(
        doc,
        outputRunId(payload, payload.hermes_run_id ?? null),
      );
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
    // Auto-advance: submit next stage when Hermes completed without approval.
    // Ordering: (i) markJobCompleted, (ii) honcho schedule, (iii) social-content
    // markers, (iv) maybeAutoAdvanceNextStage (does its own intermediate save),
    // (v) final save below.
    await maybeAutoAdvanceNextStage(doc, targetStage, payload, getMarketingExecutionPort());
    saveSocialContentJobRuntime(doc.job_id, doc);
  }
}
