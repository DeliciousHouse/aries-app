import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCodePath } from '@/lib/runtime-paths';

import type { MarketingJobRuntimeDocument, MarketingStage } from './runtime-state';

export type MarketingArtifactStageNumber = 1 | 2 | 3 | 4;

export type StepPayloadResolution = {
  runId: string | null;
  path: string | null;
  payload: Record<string, unknown> | null;
  source: 'cache' | 'log' | 'none';
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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

function slugify(value: string, fallback = 'campaign'): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function stageKey(stage: MarketingArtifactStageNumber): MarketingStage {
  if (stage === 1) return 'research';
  if (stage === 2) return 'strategy';
  if (stage === 3) return 'production';
  return 'publish';
}

function cacheRoot(stage: MarketingArtifactStageNumber): string {
  const envKey =
    stage === 1
      ? 'LOBSTER_STAGE1_CACHE_DIR'
      : stage === 2
        ? 'LOBSTER_STAGE2_CACHE_DIR'
        : stage === 3
          ? 'LOBSTER_STAGE3_CACHE_DIR'
          : 'LOBSTER_STAGE4_CACHE_DIR';
  const fallback =
    stage === 1
      ? 'lobster-stage1-cache'
      : stage === 2
        ? 'lobster-stage2-cache'
        : stage === 3
          ? 'lobster-stage3-cache'
          : 'lobster-stage4-cache';
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallback);
}

function stageFolder(stage: MarketingArtifactStageNumber): string {
  if (stage === 1) return 'stage-1-research';
  if (stage === 2) return 'stage-2-strategy';
  if (stage === 3) return 'stage-3-production';
  return 'stage-4-publish-optimize';
}

function lobsterRoots(): string[] {
  return uniqueStrings([
    process.env.OPENCLAW_LOCAL_LOBSTER_CWD,
    process.env.OPENCLAW_LOBSTER_CWD,
    resolveCodePath('lobster'),
  ]).map((root) => path.resolve(root));
}

function lobsterOutputRoots(): string[] {
  // See real-artifacts.lobsterOutputRoots for why the host bind-mount is included.
  const hostMount = process.env.ARIES_LOBSTER_HOST_OUTPUT_MOUNT?.trim();
  return uniqueStrings([
    ...lobsterRoots().map((root) => path.join(root, 'output')),
    hostMount ? path.normalize(hostMount) : null,
  ]);
}

async function readJsonIfExists(filePath: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!filePath) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

function competitorRunIdPrefixes(runtimeDoc: MarketingJobRuntimeDocument): string[] {
  const raw = stringValue(runtimeDoc.inputs.competitor_url || runtimeDoc.inputs.request?.competitorUrl);
  if (!raw) {
    return [];
  }

  const prefixes = uniqueStrings([
    slugify(raw, 'campaign'),
  ]);

  try {
    const url = new URL(raw);
    prefixes.push(
      slugify(url.hostname.replace(/^www\./, ''), 'campaign'),
      slugify(url.hostname, 'campaign'),
    );
  } catch {
    // Keep the raw-url slug only when the URL parser fails.
  }

  return uniqueStrings(prefixes);
}

function stageTimestamp(runtimeDoc: MarketingJobRuntimeDocument, stage: MarketingStage): number {
  const record = runtimeDoc.stages[stage];
  const candidates = [
    record.completed_at,
    record.started_at,
    runtimeDoc.updated_at,
    runtimeDoc.created_at,
  ]
    .map((value) => Date.parse(stringValue(value)))
    .filter((value) => Number.isFinite(value));

  return candidates[0] ?? 0;
}

export async function inferMarketingStageRunId(
  runtimeDoc: MarketingJobRuntimeDocument,
  stage: MarketingArtifactStageNumber,
): Promise<string | null> {
  const currentStage = stageKey(stage);
  const explicitRunId = stringValue(runtimeDoc.stages[currentStage].run_id);
  if (explicitRunId) {
    return explicitRunId;
  }

  const prefixes = competitorRunIdPrefixes(runtimeDoc);
  if (prefixes.length === 0) {
    return null;
  }

  const targetTime = stageTimestamp(runtimeDoc, currentStage);
  const candidates: Array<{ runId: string; score: number; mtimeMs: number }> = [];
  const seenRunIds = new Set<string>();

  const stageCacheRoot = cacheRoot(stage);
  if (existsSync(stageCacheRoot)) {
    for (const entry of await readdir(stageCacheRoot)) {
      if (!prefixes.some((prefix) => entry.startsWith(`${prefix}-`))) {
        continue;
      }
      if (seenRunIds.has(entry)) {
        continue;
      }
      try {
        const entryPath = path.join(stageCacheRoot, entry);
        const stats = await stat(entryPath);
        if (!stats.isDirectory()) {
          continue;
        }
        seenRunIds.add(entry);
        candidates.push({
          runId: entry,
          score: Math.abs(stats.mtimeMs - targetTime),
          mtimeMs: stats.mtimeMs,
        });
      } catch {}
    }
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const logsRoot = path.join(outputRoot, 'logs');
    if (!existsSync(logsRoot)) {
      continue;
    }
    for (const entry of await readdir(logsRoot)) {
      if (!prefixes.some((prefix) => entry.startsWith(`${prefix}-`))) {
        continue;
      }
      if (seenRunIds.has(entry)) {
        continue;
      }
      const stagePath = path.join(logsRoot, entry, stageFolder(stage));
      if (!existsSync(stagePath)) {
        continue;
      }
      try {
        const stats = await stat(stagePath);
        seenRunIds.add(entry);
        candidates.push({
          runId: entry,
          score: Math.abs(stats.mtimeMs - targetTime),
          mtimeMs: stats.mtimeMs,
        });
      } catch {}
    }
  }

  return candidates
    .sort((left, right) => left.score - right.score || right.mtimeMs - left.mtimeMs)[0]
    ?.runId || null;
}

export async function readMarketingStageStepPayload(
  runtimeDoc: MarketingJobRuntimeDocument,
  stage: MarketingArtifactStageNumber,
  stepName: string,
  preferredRunId?: string | null,
): Promise<StepPayloadResolution> {
  const currentStage = stageKey(stage);
  const runIds = uniqueStrings([
    preferredRunId,
    stringValue(runtimeDoc.stages[currentStage].run_id),
    await inferMarketingStageRunId(runtimeDoc, stage),
  ]);

  for (const runId of runIds) {
    const cachePath = path.join(cacheRoot(stage), runId, `${stepName}.json`);
    const cached = await readJsonIfExists(cachePath);
    if (cached) {
      return {
        runId,
        path: cachePath,
        payload: cached,
        source: 'cache',
      };
    }

    for (const outputRoot of lobsterOutputRoots()) {
      const logPath = path.join(outputRoot, 'logs', runId, stageFolder(stage), `${stepName}.json`);
      const logged = await readJsonIfExists(logPath);
      if (logged) {
        return {
          runId,
          path: logPath,
          payload: logged,
          source: 'log',
        };
      }
    }
  }

  return {
    runId: runIds[0] || null,
    path: null,
    payload: null,
    source: 'none',
  };
}
