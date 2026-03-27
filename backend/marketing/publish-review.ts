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

function inferPublishRunId(runtimeDoc: MarketingJobRuntimeDocument): string | null {
  const explicitRunId = stringValue(runtimeDoc.stages.publish.run_id);
  if (explicitRunId) {
    return explicitRunId;
  }

  const prefix = competitorSlug(runtimeDoc);
  if (!prefix) {
    return null;
  }

  const targetTime = publishStageTimestamp(runtimeDoc);
  const candidates = lobsterOutputRoots()
    .flatMap((outputRoot) => {
      const logsRoot = path.join(outputRoot, 'logs');
      if (!existsSync(logsRoot)) {
        return [];
      }

      return readdirSync(logsRoot)
        .filter((entry) => entry.startsWith(`${prefix}-`))
        .map((entry) => {
          const stagePath = path.join(logsRoot, entry, 'stage-4-publish-optimize');
          if (!existsSync(stagePath)) {
            return null;
          }
          try {
            const stats = statSync(stagePath);
            return {
              runId: entry,
              score: Math.abs(stats.mtimeMs - targetTime),
              mtimeMs: stats.mtimeMs,
            };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { runId: string; score: number; mtimeMs: number } => !!entry);
    })
    .sort((left, right) => left.score - right.score || right.mtimeMs - left.mtimeMs);

  return candidates[0]?.runId || null;
}

function readPublishStepPayload(runtimeDoc: MarketingJobRuntimeDocument, stepName: string): Record<string, unknown> | null {
  const runIds = uniqueStrings([
    runtimeDoc.stages.publish.run_id,
    inferPublishRunId(runtimeDoc),
  ]);

  for (const runId of runIds) {
    const cachePath = path.join(cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache'), runId, `${stepName}.json`);
    const cached = readJsonIfExists(cachePath);
    if (cached) {
      return cached;
    }

    for (const outputRoot of lobsterOutputRoots()) {
      const logged = readJsonIfExists(
        path.join(outputRoot, 'logs', runId, 'stage-4-publish-optimize', `${stepName}.json`)
      );
      if (logged) {
        return logged;
      }
    }
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
  if (
    publishStage.status !== 'not_started' &&
    (publishStage.run_id || publishStage.started_at || publishStage.completed_at || publishStage.failed_at)
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
