import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  legacyStageCacheReadFallbackEnabled,
  lobsterOutputRoots,
  stageCacheRoot,
  stageCacheRootForTenant,
} from './artifact-store';
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

function stageFolder(stage: MarketingArtifactStageNumber): string {
  if (stage === 1) return 'stage-1-research';
  if (stage === 2) return 'stage-2-strategy';
  if (stage === 3) return 'stage-3-production';
  return 'stage-4-publish-optimize';
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

  const tenantId = stringValue(runtimeDoc.tenant_id);
  if (!tenantId) {
    // Fail closed: without a tenant we cannot safely surface a cached runId,
    // because the inference fallback keys off a competitor URL slug that
    // can collide across tenants.
    return null;
  }

  const targetTime = stageTimestamp(runtimeDoc, currentStage);
  const candidates: Array<{ runId: string; score: number; mtimeMs: number }> = [];
  const seenRunIds = new Set<string>();

  // Scan only the tenant-scoped cache subtree so a sibling tenant's directory
  // can never surface as a "closest by mtime" candidate. The legacy shared
  // layout is intentionally skipped here even when the read fallback gate is
  // on — inference would have no way to verify the legacy entry belongs to
  // this tenant.
  const tenantCacheRoot = path.join(stageCacheRoot(stage), tenantId);
  if (existsSync(tenantCacheRoot)) {
    for (const entry of await readdir(tenantCacheRoot)) {
      if (!prefixes.some((prefix) => entry.startsWith(`${prefix}-`))) {
        continue;
      }
      if (seenRunIds.has(entry)) {
        continue;
      }
      try {
        const entryPath = path.join(tenantCacheRoot, entry);
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

  const tenantId = stringValue(runtimeDoc.tenant_id);
  if (!tenantId) {
    // Same fail-closed reasoning as inferMarketingStageRunId — a missing
    // tenant_id on a runtime doc is a programmer error, not a normal state.
    return {
      runId: runIds[0] || null,
      path: null,
      payload: null,
      source: 'none',
    };
  }

  for (const runId of runIds) {
    const cachePath = path.join(stageCacheRootForTenant(stage, tenantId), runId, `${stepName}.json`);
    const cached = await readJsonIfExists(cachePath);
    if (cached) {
      return {
        runId,
        path: cachePath,
        payload: cached,
        source: 'cache',
      };
    }

    // Legacy on-disk caches at `<cacheRoot>/<runId>/<step>.json` (no tenant
    // segment) remain readable as a last resort while operators migrate. New
    // writes always go to the tenant-scoped path; this branch only reads.
    if (legacyStageCacheReadFallbackEnabled()) {
      const legacyCachePath = path.join(stageCacheRoot(stage), runId, `${stepName}.json`);
      const legacyCached = await readJsonIfExists(legacyCachePath);
      if (legacyCached) {
        return {
          runId,
          path: legacyCachePath,
          payload: legacyCached,
          source: 'cache',
        };
      }
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
