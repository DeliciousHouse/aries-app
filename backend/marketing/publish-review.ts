import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCodePath } from '@/lib/runtime-paths';

import type { MarketingJobRuntimeDocument } from './runtime-state';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

function readJsonIfExists(filePath: string | null | undefined): Record<string, unknown> | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cacheRoot(envKey: string, fallbackFolder: string): string {
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallbackFolder);
}

function lobsterRoots(): string[] {
  return Array.from(
    new Set(
      [
        process.env.OPENCLAW_LOCAL_LOBSTER_CWD?.trim(),
        process.env.OPENCLAW_LOBSTER_CWD?.trim(),
        resolveCodePath('lobster'),
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
}

function lobsterOutputRoots(): string[] {
  return lobsterRoots().map((root) => path.join(root, 'output'));
}

function competitorSlug(runtimeDoc: MarketingJobRuntimeDocument): string | null {
  const raw = stringValue(runtimeDoc.inputs.competitor_url || runtimeDoc.inputs.request?.competitorUrl);
  if (!raw) {
    return null;
  }

  try {
    return slugify(new URL(raw).hostname.replace(/^www\./, ''), 'campaign');
  } catch {
    return slugify(raw, 'campaign');
  }
}

function publishStageTimestamp(runtimeDoc: MarketingJobRuntimeDocument): number {
  const candidates = [
    runtimeDoc.stages.publish.completed_at,
    runtimeDoc.stages.publish.started_at,
    runtimeDoc.updated_at,
    runtimeDoc.created_at,
  ]
    .map((value) => Date.parse(stringValue(value)))
    .filter((value) => Number.isFinite(value));

  return candidates[0] ?? 0;
}

function runtimeBrandSlugCandidates(runtimeDoc: MarketingJobRuntimeDocument): string[] {
  const runtimeInputs = runtimeDoc.inputs as Record<string, unknown>;
  return uniqueStrings([
    stringValue(runtimeInputs.brand_slug || runtimeDoc.inputs.request?.brandSlug),
    stringValue(runtimeDoc.tenant_id),
  ]).map((value) => slugify(value, value));
}

type PublishStepPayloadCandidate = {
  runId: string;
  payload: Record<string, unknown>;
  mtimeMs: number;
};

function readExactPublishStepPayload(runtimeDoc: MarketingJobRuntimeDocument, stepName: string, runId: string): PublishStepPayloadCandidate | null {
  const cachePath = path.join(cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache'), runId, `${stepName}.json`);
  const cached = readJsonIfExists(cachePath);
  if (cached) {
    try {
      return {
        runId,
        payload: cached,
        mtimeMs: statSync(cachePath).mtimeMs,
      };
    } catch {
      return {
        runId,
        payload: cached,
        mtimeMs: 0,
      };
    }
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const logPath = path.join(outputRoot, 'logs', runId, 'stage-4-publish-optimize', `${stepName}.json`);
    const logged = readJsonIfExists(logPath);
    if (logged) {
      try {
        return {
          runId,
          payload: logged,
          mtimeMs: statSync(logPath).mtimeMs,
        };
      } catch {
        return {
          runId,
          payload: logged,
          mtimeMs: 0,
        };
      }
    }
  }

  return null;
}

function scorePublishStepPayloadCandidate(
  runtimeDoc: MarketingJobRuntimeDocument,
  prefix: string,
  candidate: PublishStepPayloadCandidate
): { trust: number; distance: number } {
  const targetTime = publishStageTimestamp(runtimeDoc);
  const runtimeBrandSlugs = runtimeBrandSlugCandidates(runtimeDoc);
  const reviewBundle = recordValue(candidate.payload.review_bundle);
  const approvalPreview = recordValue(candidate.payload.approval_preview);
  const payloadBrandSlug = stringValue(candidate.payload.brand_slug || reviewBundle?.brand_slug);
  const normalizedPayloadBrandSlug = payloadBrandSlug ? slugify(payloadBrandSlug, payloadBrandSlug) : '';
  const platformPreviews = Array.isArray(reviewBundle?.platform_previews) ? reviewBundle.platform_previews : [];
  let trust = 0;

  if (new RegExp(`^${escapeRegExp(prefix)}-[a-f0-9]{8,}$`, 'i').test(candidate.runId)) {
    trust += 25;
  } else if (candidate.runId.startsWith(`${prefix}-`)) {
    trust += 5;
  }

  if (normalizedPayloadBrandSlug && runtimeBrandSlugs.includes(normalizedPayloadBrandSlug)) {
    trust += 80;
  } else if (normalizedPayloadBrandSlug) {
    trust -= 20;
  } else {
    trust += 5;
  }

  if (stringValue(candidate.payload.mode).toLowerCase() === 'compiled') {
    trust += 20;
  }
  if (stringValue(approvalPreview?.message)) {
    trust += 20;
  }
  if (recordValue(reviewBundle?.artifact_paths)) {
    trust += 30;
  }
  if (platformPreviews.length > 0) {
    trust += 10;
  }

  return {
    trust,
    distance: Math.abs(candidate.mtimeMs - targetTime),
  };
}

function collectFallbackPublishStepPayloadCandidates(
  runtimeDoc: MarketingJobRuntimeDocument,
  stepName: string
): PublishStepPayloadCandidate[] {
  const prefix = competitorSlug(runtimeDoc);
  if (!prefix) {
    return [];
  }

  const candidates: PublishStepPayloadCandidate[] = [];
  const seenPaths = new Set<string>();

  const cacheDir = cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache');
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.startsWith(`${prefix}-`)) {
        continue;
      }
      const candidatePath = path.join(cacheDir, entry, `${stepName}.json`);
      if (seenPaths.has(candidatePath)) {
        continue;
      }
      const payload = readJsonIfExists(candidatePath);
      if (!payload) {
        continue;
      }
      seenPaths.add(candidatePath);
      try {
        candidates.push({ runId: entry, payload, mtimeMs: statSync(candidatePath).mtimeMs });
      } catch {
        candidates.push({ runId: entry, payload, mtimeMs: 0 });
      }
    }
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const logsRoot = path.join(outputRoot, 'logs');
    if (!existsSync(logsRoot)) {
      continue;
    }
    for (const entry of readdirSync(logsRoot)) {
      if (!entry.startsWith(`${prefix}-`)) {
        continue;
      }
      const candidatePath = path.join(logsRoot, entry, 'stage-4-publish-optimize', `${stepName}.json`);
      if (seenPaths.has(candidatePath)) {
        continue;
      }
      const payload = readJsonIfExists(candidatePath);
      if (!payload) {
        continue;
      }
      seenPaths.add(candidatePath);
      try {
        candidates.push({ runId: entry, payload, mtimeMs: statSync(candidatePath).mtimeMs });
      } catch {
        candidates.push({ runId: entry, payload, mtimeMs: 0 });
      }
    }
  }

  return candidates.sort((left, right) => {
    const leftScore = scorePublishStepPayloadCandidate(runtimeDoc, prefix, left);
    const rightScore = scorePublishStepPayloadCandidate(runtimeDoc, prefix, right);
    return (
      rightScore.trust - leftScore.trust ||
      leftScore.distance - rightScore.distance ||
      right.mtimeMs - left.mtimeMs
    );
  });
}

function readPublishStepPayload(runtimeDoc: MarketingJobRuntimeDocument, stepName: string): Record<string, unknown> | null {
  const explicitRunId = stringValue(runtimeDoc.stages.publish.run_id);
  if (explicitRunId) {
    const explicit = readExactPublishStepPayload(runtimeDoc, stepName, explicitRunId);
    if (explicit) {
      return explicit.payload;
    }
  }

  for (const candidate of collectFallbackPublishStepPayloadCandidates(runtimeDoc, stepName)) {
    return candidate.payload;
  }

  return null;
}

function publishStageHasRuntimeContext(runtimeDoc: MarketingJobRuntimeDocument): boolean {
  const publishStage = runtimeDoc.stages.publish;
  const publishOutputs = recordValue(publishStage.outputs);
  const approvalStepId = stringValue(
    runtimeDoc.approvals.current?.workflow_step_id || publishOutputs?.workflow_step_id
  );

  if (approvalStepId === 'approve_stage_4_publish') {
    return true;
  }
  if (
    publishStage.status === 'in_progress' ||
    publishStage.status === 'completed' ||
    publishStage.status === 'failed'
  ) {
    return true;
  }
  if (!!recordValue(publishOutputs?.review) || !!recordValue(recordValue(publishStage.primary_output)?.launch_review)) {
    return true;
  }
  if (publishOutputs && Object.keys(publishOutputs).length > 0 && approvalStepId === 'approve_stage_4_publish') {
    return true;
  }
  if (recordValue(publishStage.primary_output) && approvalStepId === 'approve_stage_4_publish') {
    return true;
  }

  return false;
}

export function extractPublishReviewPayload(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  const publishStage = runtimeDoc.stages.publish;
  const reviewOutput = recordValue(publishStage.outputs.review);
  if (reviewOutput) {
    return reviewOutput;
  }

  const primaryOutput = recordValue(publishStage.primary_output);
  const launchReview = recordValue(primaryOutput?.launch_review);
  if (launchReview) {
    return launchReview;
  }

  const loggedReview = publishStageHasRuntimeContext(runtimeDoc)
    ? readPublishStepPayload(runtimeDoc, 'launch_review_preview')
    : null;
  if (loggedReview) {
    return loggedReview;
  }

  return primaryOutput;
}

export function extractPublishReviewBundle(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  return recordValue(extractPublishReviewPayload(runtimeDoc)?.review_bundle);
}
