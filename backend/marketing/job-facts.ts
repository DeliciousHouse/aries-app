import { readFile } from 'node:fs/promises';

import type { MarketingJobRuntimeDocument, MarketingStage } from './runtime-state';
import {
  readMarketingStageStepPayload,
  type MarketingArtifactStageNumber,
  type StepPayloadResolution,
} from './stage-artifact-resolution';

type JsonRecord = Record<string, unknown>;

type MarketingJobFactsDependencies = {
  readJsonAtPath?: (absolutePath: string) => Promise<JsonRecord | null>;
  readStageStepPayload?: (
    runtimeDoc: MarketingJobRuntimeDocument,
    stage: MarketingArtifactStageNumber,
    stepName: string,
    preferredRunId?: string | null,
  ) => Promise<StepPayloadResolution>;
};

export interface MarketingJobFacts {
  runtimeDoc: MarketingJobRuntimeDocument;
  runId: string | null;
  stagePayload(stage: MarketingStage, stepName: string): Promise<JsonRecord | null>;
  jsonAtPath(absolutePath: string): Promise<JsonRecord | null>;
}

function stageNumber(stage: MarketingStage): MarketingArtifactStageNumber {
  if (stage === 'research') {
    return 1;
  }
  if (stage === 'strategy') {
    return 2;
  }
  if (stage === 'production') {
    return 3;
  }
  return 4;
}

async function defaultReadJsonAtPath(absolutePath: string): Promise<JsonRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export function createMarketingJobFacts(
  runtimeDoc: MarketingJobRuntimeDocument,
  runId: string | null,
  dependencies: MarketingJobFactsDependencies = {},
): MarketingJobFacts {
  const readJsonAtPath = dependencies.readJsonAtPath ?? defaultReadJsonAtPath;
  const readStageStepPayload = dependencies.readStageStepPayload ?? readMarketingStageStepPayload;
  const pathCache = new Map<string, Promise<JsonRecord | null>>();
  const stageCache = new Map<string, Promise<StepPayloadResolution>>();

  return {
    runtimeDoc,
    runId,
    async stagePayload(stage, stepName) {
      const cacheKey = `${stage}:${stepName}`;
      const existing = stageCache.get(cacheKey);
      if (existing) {
        return (await existing).payload;
      }

      const pending = readStageStepPayload(
        runtimeDoc,
        stageNumber(stage),
        stepName,
        runId,
      ).then((resolution) => {
        if (resolution.path && !pathCache.has(resolution.path)) {
          pathCache.set(resolution.path, Promise.resolve(resolution.payload));
        }
        return resolution;
      });

      stageCache.set(cacheKey, pending);
      return (await pending).payload;
    },
    jsonAtPath(absolutePath) {
      const existing = pathCache.get(absolutePath);
      if (existing) {
        return existing;
      }

      const pending = readJsonAtPath(absolutePath);
      pathCache.set(absolutePath, pending);
      return pending;
    },
  };
}
