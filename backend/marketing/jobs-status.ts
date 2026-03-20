import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodePath } from '@/lib/runtime-paths';

import {
  assertMarketingRuntimeSchemas,
  loadMarketingJobRuntime,
  responseStageStatus,
  type MarketingJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';

type TimelineTone = 'info' | 'success' | 'warning' | 'danger';

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
  publishConfig: {
    platforms: string[];
    livePublishPlatforms: string[];
    videoRenderPlatforms: string[];
  };
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
  return stageLogRoot(stage).replace('{runId}', runId) + `/${stepName}.json`;
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

function deriveState(
  runtimeDoc: MarketingJobRuntimeDocument,
  stageStatus: Record<string, string>
): { state: string; status: string; currentStage: string | null; nextStep: string; repairStatus: string; needsAttention: boolean } {
  if (runtimeDoc.status === 'completed' || stageStatus.publish === 'completed') {
    return {
      state: 'completed',
      status: 'completed',
      currentStage: 'publish',
      nextStep: 'none',
      repairStatus: 'not_required',
      needsAttention: false,
    };
  }

  if (runtimeDoc.status === 'awaiting_approval' && runtimeDoc.approvals.current) {
    return {
      state: 'approval_required',
      status: 'awaiting_approval',
      currentStage: runtimeDoc.approvals.current.stage,
      nextStep: 'submit_approval',
      repairStatus: 'not_required',
      needsAttention: true,
    };
  }

  if (runtimeDoc.status === 'failed' || runtimeDoc.state === 'failed') {
    return {
      state: runtimeDoc.state,
      status: runtimeDoc.status,
      currentStage: runtimeDoc.current_stage,
      nextStep: 'invoke_marketing_repair',
      repairStatus: 'required',
      needsAttention: true,
    };
  }

  return {
    state: runtimeDoc.state,
    status: runtimeDoc.status,
    currentStage: runtimeDoc.current_stage,
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
    const stageLabel = state.currentStage ? STAGE_LABELS[state.currentStage as MarketingStage] : 'Current';
    return {
      headline: `${stageLabel} stage is ready for approval`,
      subheadline: 'Review the latest stage outputs and approve the checkpoint to move the real job forward.',
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
  runtimeDoc: MarketingJobRuntimeDocument,
  stageStatus: Record<string, string>
): MarketingStageCard[] {
  return (['research', 'strategy', 'production', 'publish'] as MarketingStage[]).map((stage) => {
    const stageRecord = runtimeDoc.stages[stage];
    switch (stage) {
      case 'research':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Competitive research completed.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
      case 'strategy':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Campaign strategy is ready.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
      case 'production':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Production assets are ready.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
      case 'publish':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Launch review and publishing happen in the final stage.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
    }
  });
}

function buildApproval(
  jobId: string,
  runtimeDoc: MarketingJobRuntimeDocument
): MarketingApprovalSummary | null {
  const approval = runtimeDoc.approvals.current;
  if (!approval) {
    return null;
  }
  return {
    required: true,
    status: approval.status,
    title: approval.title,
    message: approval.message,
    actionLabel: 'Open approval dashboard',
    actionHref: `/marketing/job-approve?jobId=${encodeURIComponent(jobId)}`,
  };
}

function withDetails(...details: Array<string | null | undefined>): string[] {
  return details.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0);
}

function buildArtifacts(
  runtimeDoc: MarketingJobRuntimeDocument,
  approval: MarketingApprovalSummary | null
): MarketingArtifactCard[] {
  return Object.values(runtimeDoc.stages)
    .flatMap((stageRecord) =>
      stageRecord.artifacts.map((entry) => ({
        id: entry.id,
        stage: entry.stage,
        title: entry.title,
        category: entry.category,
        status: entry.status,
        summary: entry.summary,
        details: entry.details,
        preview: readTextPreview(entry.preview_path ?? null) || undefined,
        actionLabel:
          entry.id === 'launch-review' && approval?.required
            ? approval.actionLabel
            : entry.action_label ?? undefined,
        actionHref:
          entry.id === 'launch-review' && approval?.required
            ? approval.actionHref
            : entry.action_href ?? undefined,
      }))
    );
}

function buildTimeline(
  runtimeDoc: MarketingJobRuntimeDocument,
  state: ReturnType<typeof deriveState>
): MarketingTimelineEntry[] {
  const timeline: MarketingTimelineEntry[] = [];

  if (runtimeDoc.created_at) {
    timeline.push({
      id: 'accepted',
      at: runtimeDoc.created_at,
      tone: 'info',
      label: 'Campaign accepted',
      description: 'Aries created the marketing job and started the direct Lobster pipeline.',
    });
  }

  for (const stage of ['research', 'strategy', 'production', 'publish'] as MarketingStage[]) {
    const record = runtimeDoc.stages[stage];
    if (record.completed_at) {
      timeline.push({
        id: `${stage}-completed`,
        at: record.completed_at,
        tone: 'success',
        label: `${STAGE_LABELS[stage]} completed`,
        description: record.summary?.summary || `${STAGE_LABELS[stage]} completed successfully.`,
      });
    } else if (record.status === 'awaiting_approval') {
      timeline.push({
        id: `${stage}-approval`,
        at: runtimeDoc.approvals.current?.requested_at ?? record.started_at,
        tone: 'warning',
        label: `${STAGE_LABELS[stage]} approval requested`,
        description:
          runtimeDoc.approvals.current?.message ||
          `${STAGE_LABELS[stage]} is waiting on explicit approval.`,
      });
    } else if (record.failed_at) {
      timeline.push({
        id: `${stage}-failed`,
        at: record.failed_at,
        tone: 'danger',
        label: `${STAGE_LABELS[stage]} failed`,
        description: record.errors[record.errors.length - 1]?.message || `${STAGE_LABELS[stage]} failed.`,
      });
    } else if (record.started_at && record.status === 'in_progress') {
      timeline.push({
        id: `${stage}-running`,
        at: record.started_at,
        tone: 'info',
        label: `${STAGE_LABELS[stage]} running`,
        description: `${STAGE_LABELS[stage]} is actively executing.`,
      });
    }
  }

  if (runtimeDoc.status === 'completed') {
    timeline.push({
      id: 'publish-packages',
      at: runtimeDoc.updated_at,
      tone: 'success',
      label: 'Publish packages generated',
      description: 'Selected platform packages and review outputs were generated.',
    });
  }

  if (state.needsAttention && state.status !== 'awaiting_approval' && runtimeDoc.updated_at) {
    timeline.push({
      id: 'attention',
      at: runtimeDoc.updated_at,
      tone: 'danger',
      label: 'Operator attention required',
      description: 'A failure was recorded in the marketing runtime.',
    });
  }

  return timeline.sort((left, right) => {
    if (!left.at && !right.at) return 0;
    if (!left.at) return 1;
    if (!right.at) return -1;
    return left.at.localeCompare(right.at);
  });
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
      publishConfig: {
        platforms: [],
        livePublishPlatforms: [],
        videoRenderPlatforms: [],
      },
      nextStep: 'none',
      repairStatus: 'not_required',
    };
  }

  const stageStatus: Record<string, string> = {
    research: responseStageStatus(runtimeDoc.stages.research),
    strategy: responseStageStatus(runtimeDoc.stages.strategy),
    production: responseStageStatus(runtimeDoc.stages.production),
    publish: responseStageStatus(runtimeDoc.stages.publish),
  };
  const state = deriveState(runtimeDoc, stageStatus);
  const approval = buildApproval(jobId, runtimeDoc);

  return {
    jobId,
    tenantId: runtimeDoc.tenant_id,
    state: state.state,
    status: state.status,
    currentStage: state.currentStage,
    stageStatus,
    updatedAt: runtimeDoc.updated_at,
    approvalRequired: !!runtimeDoc.approvals.current,
    needsAttention: state.needsAttention,
    summary: buildSummary(state),
    stageCards: buildStageCards(runtimeDoc, stageStatus),
    artifacts: buildArtifacts(runtimeDoc, approval),
    timeline: buildTimeline(runtimeDoc, state),
    approval,
    publishConfig: {
      platforms: runtimeDoc.publish_config.platforms,
      livePublishPlatforms: runtimeDoc.publish_config.live_publish_platforms,
      videoRenderPlatforms: runtimeDoc.publish_config.video_render_platforms,
    },
    nextStep: state.nextStep,
    repairStatus: state.repairStatus,
  };
}
