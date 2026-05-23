import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';
import type {
  SocialContentApprovalCheckpoint,
  SocialContentApprovalStep,
  SocialContentArtifact,
  SocialContentRuntimeState,
  SocialContentStage,
  SocialContentStageRecord,
  SocialContentStageStatus,
} from './types';

type UnknownRecord = Record<string, unknown>;
type MarketingDocWithSocialRuntime = MarketingJobRuntimeDocument & {
  social_content_runtime?: unknown;
};
type SocialContentStageMap = Record<SocialContentStage, SocialContentStageRecord>;

type WeeklyPost = {
  id: string;
  day: string;
  platforms: string[];
  post_type: string;
  title: string;
  caption: string;
  creative_brief_id: string;
  status: string;
};

type ImageCreative = {
  id: string;
  title: string;
  aspect_ratio: string;
  prompt: string;
  status: string;
  artifact_url: string;
};

type VideoScript = {
  id: string;
  title: string;
  duration_seconds: number | null;
  script_markdown: string;
  status: string;
  artifact_url: string;
};

export type SocialContentWeeklyPlan = {
  window_days: number | null;
  posts: WeeklyPost[];
  image_creatives: ImageCreative[];
  video_scripts: VideoScript[];
};

export type SocialContentWorkflowProjection = {
  summary: string;
  weekly_content_plan: SocialContentWeeklyPlan;
};

export const SOCIAL_CONTENT_STAGE_ORDER: SocialContentStage[] = [
  'intake',
  'research',
  'planning',
  'plan_review',
  'copy_production',
  'image_briefing',
  'image_generation',
  'creative_review',
  'social_copy_finalize',
  'video_script',
  'video_review',
  'video_render',
  'publish_review',
  'completed',
  'failed',
];

const STAGE_RANK = new Map(SOCIAL_CONTENT_STAGE_ORDER.map((stage, index) => [stage, index] as const));
const STATUS_RANK: Record<SocialContentStageStatus, number> = {
  pending: 0,
  running: 1,
  awaiting_approval: 2,
  completed: 3,
  failed: 4,
};

const WORKFLOW_STEP_TO_APPROVAL_STEP: Record<string, SocialContentApprovalStep> = {
  approve_weekly_plan: 'approve_weekly_plan',
  approve_post_copy: 'approve_post_copy',
  approve_image_creatives: 'approve_image_creatives',
  approve_video_script: 'approve_video_script',
  approve_video_render: 'approve_video_render',
  approve_publish: 'approve_publish',
  approve_stage_2: 'approve_weekly_plan',
  approve_stage_3: 'approve_post_copy',
  approve_stage_4: 'approve_publish',
  approve_stage_4_publish: 'approve_publish',
};

const APPROVAL_STEP_TO_REVIEW_STAGE: Record<SocialContentApprovalStep, SocialContentStage> = {
  approve_weekly_plan: 'plan_review',
  approve_post_copy: 'creative_review',
  approve_image_creatives: 'creative_review',
  approve_video_script: 'video_review',
  approve_video_render: 'video_review',
  approve_publish: 'publish_review',
};

const APPROVAL_STEP_TO_RESUME_STAGE: Record<SocialContentApprovalStep, SocialContentStage> = {
  approve_weekly_plan: 'copy_production',
  approve_post_copy: 'image_briefing',
  approve_image_creatives: 'social_copy_finalize',
  approve_video_script: 'video_render',
  approve_video_render: 'publish_review',
  approve_publish: 'completed',
};

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stageRank(stage: SocialContentStage): number {
  return STAGE_RANK.get(stage) ?? -1;
}

function createEmptyStageRecord(stage: SocialContentStage): SocialContentStageRecord {
  return {
    stage,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    summary: null,
    output: null,
    artifacts: [],
  };
}

function createEmptyStageMap(): SocialContentStageMap {
  return Object.create(null) as SocialContentStageMap;
}

function ensureStageRecord(
  runtime: SocialContentRuntimeState,
  stage: SocialContentStage,
): SocialContentStageRecord {
  if (!Object.hasOwn(runtime.stages, stage) || !runtime.stages[stage]) {
    runtime.stages[stage] = createEmptyStageRecord(stage);
  }
  return runtime.stages[stage];
}

function normalizeArtifact(value: unknown, fallbackId: string): SocialContentArtifact {
  const record = asRecord(value);
  return {
    id: stringValue(record?.id) || fallbackId,
    type: stringValue(record?.type) || 'artifact',
    title: stringValue(record?.title) || 'Social content artifact',
    status: stringValue(record?.status) || 'created',
    summary: stringValue(record?.summary) || null,
    url: stringValue(record?.url) || stringValue(record?.artifact_url) || null,
    metadata: record ?? {},
  };
}

function normalizeStageRecord(stage: SocialContentStage, value: unknown): SocialContentStageRecord {
  const record = asRecord(value);
  const rawStatus = stringValue(record?.status) as SocialContentStageStatus;
  const status: SocialContentStageStatus = (
    rawStatus === 'pending'
    || rawStatus === 'running'
    || rawStatus === 'awaiting_approval'
    || rawStatus === 'completed'
    || rawStatus === 'failed'
  )
    ? rawStatus
    : 'pending';
  const artifacts = Array.isArray(record?.artifacts)
    ? record.artifacts.map((artifact, index) => normalizeArtifact(artifact, `${stage}-artifact-${index + 1}`))
    : [];
  return {
    stage,
    status,
    startedAt: stringValue(record?.startedAt) || null,
    completedAt: stringValue(record?.completedAt) || null,
    summary: stringValue(record?.summary) || null,
    output: asRecord(record?.output),
    artifacts,
  };
}

function normalizeApproval(value: unknown): SocialContentApprovalCheckpoint | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const approvalStep = approvalStepFromWorkflowStepId(stringValue(record.approvalStep)) ??
    approvalStepFromWorkflowStepId(stringValue(record.workflowStepId));
  if (!approvalStep) {
    return null;
  }
  const status = stringValue(record.status);
  const normalizedStatus: SocialContentApprovalCheckpoint['status'] = (
    status === 'approved' || status === 'denied'
  )
    ? status
    : 'awaiting_approval';
  return {
    approvalId: stringValue(record.approvalId) || null,
    approvalStep,
    workflowStepId: stringValue(record.workflowStepId) || null,
    resumeToken: stringValue(record.resumeToken) || null,
    status: normalizedStatus,
    requestedAt: stringValue(record.requestedAt) || nowIso(),
    approvedAt: stringValue(record.approvedAt) || null,
    deniedAt: stringValue(record.deniedAt) || null,
  };
}

function normalizeRuntime(
  value: unknown,
  input: { publishingRequested?: boolean } = {},
): SocialContentRuntimeState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const runtime: SocialContentRuntimeState = {
    schemaName: 'social_content_runtime_state',
    schemaVersion: '1.0.0',
    currentStage: 'research',
    stageOrder: [...SOCIAL_CONTENT_STAGE_ORDER],
    stages: createEmptyStageMap(),
    activeApproval: normalizeApproval(record.activeApproval),
    publishingRequested: typeof input.publishingRequested === 'boolean'
      ? input.publishingRequested
      : typeof record.publishingRequested === 'boolean'
        ? record.publishingRequested
        : false,
    updatedAt: stringValue(record.updatedAt) || nowIso(),
  };
  const currentStage = stringValue(record.currentStage);
  if (SOCIAL_CONTENT_STAGE_ORDER.includes(currentStage as SocialContentStage)) {
    runtime.currentStage = currentStage as SocialContentStage;
  }
  const stageRecords = asRecord(record.stages) ?? {};
  for (const stage of SOCIAL_CONTENT_STAGE_ORDER) {
    runtime.stages[stage] = normalizeStageRecord(stage, stageRecords[stage]);
  }
  return runtime;
}

function shouldIgnoreStatusTransition(
  runtime: SocialContentRuntimeState,
  stage: SocialContentStage,
  status: SocialContentStageStatus,
): boolean {
  const currentStageRank = stageRank(runtime.currentStage);
  const nextStageRank = stageRank(stage);
  if (nextStageRank < currentStageRank && status !== 'failed') {
    return true;
  }

  const current = ensureStageRecord(runtime, stage);
  if (
    (current.status === 'completed' || current.status === 'failed') &&
    (status === 'pending' || status === 'running' || status === 'awaiting_approval')
  ) {
    return true;
  }
  if (current.status === 'awaiting_approval' && status === 'running') {
    return true;
  }
  if (STATUS_RANK[status] < STATUS_RANK[current.status] && status !== 'failed') {
    return true;
  }
  return false;
}

function updateRuntimeTimestamp(runtime: SocialContentRuntimeState): void {
  runtime.updatedAt = nowIso();
}

function serializeRuntime(doc: MarketingDocWithSocialRuntime, runtime: SocialContentRuntimeState): void {
  doc.social_content_runtime = runtime;
}

function requestedPublishFlag(doc: MarketingJobRuntimeDocument): boolean {
  const request = asRecord(doc.inputs?.request);
  if (!request) {
    return false;
  }

  for (const key of [
    'publishRequested',
    'livePublishRequested',
    'livePublishingRequested',
    'livePublish',
    'publishLive',
  ]) {
    if (typeof request[key] === 'boolean') {
      return request[key] === true;
    }
    const raw = stringValue(request[key]);
    if (raw) {
      if (raw === 'true' || raw === '1' || raw === 'yes') return true;
      if (raw === 'false' || raw === '0' || raw === 'no') return false;
    }
  }

  for (const key of ['livePublishPlatforms', 'live_publish_platforms']) {
    if (stringArray(request[key]).length > 0) {
      return true;
    }
  }

  return false;
}

export function createSocialContentRuntimeState(
  input: { publishingRequested?: boolean } = {},
): SocialContentRuntimeState {
  const runtime: SocialContentRuntimeState = {
    schemaName: 'social_content_runtime_state',
    schemaVersion: '1.0.0',
    currentStage: 'research',
    stageOrder: [...SOCIAL_CONTENT_STAGE_ORDER],
    stages: createEmptyStageMap(),
    activeApproval: null,
    publishingRequested: input.publishingRequested ?? false,
    updatedAt: nowIso(),
  };
  for (const stage of SOCIAL_CONTENT_STAGE_ORDER) {
    runtime.stages[stage] = createEmptyStageRecord(stage);
  }
  runtime.stages.intake.status = 'completed';
  runtime.stages.intake.startedAt = runtime.updatedAt;
  runtime.stages.intake.completedAt = runtime.updatedAt;
  runtime.stages.intake.summary = 'Weekly social content intake captured.';
  return runtime;
}

export function ensureSocialContentRuntimeState(
  doc: MarketingJobRuntimeDocument,
  input: { publishingRequested?: boolean } = {},
): SocialContentRuntimeState {
  const withRuntimeDoc = doc as MarketingDocWithSocialRuntime;
  const normalized = normalizeRuntime(withRuntimeDoc.social_content_runtime, input);
  const runtime = normalized ?? createSocialContentRuntimeState({
    publishingRequested: input.publishingRequested ?? requestedPublishFlag(doc),
  });
  if (typeof input.publishingRequested === 'boolean') {
    runtime.publishingRequested = input.publishingRequested;
  }
  updateRuntimeTimestamp(runtime);
  serializeRuntime(withRuntimeDoc, runtime);
  return runtime;
}

export function readSocialContentRuntimeState(
  doc: MarketingJobRuntimeDocument,
): SocialContentRuntimeState | null {
  return normalizeRuntime((doc as MarketingDocWithSocialRuntime).social_content_runtime);
}

export function approvalStepFromWorkflowStepId(value: string): SocialContentApprovalStep | null {
  const normalized = value.trim().toLowerCase();
  return WORKFLOW_STEP_TO_APPROVAL_STEP[normalized] ?? null;
}

export function socialContentReviewStageForApprovalStep(step: SocialContentApprovalStep): SocialContentStage {
  return APPROVAL_STEP_TO_REVIEW_STAGE[step];
}

export function socialContentResumeStageForApprovalStep(step: SocialContentApprovalStep): SocialContentStage {
  return APPROVAL_STEP_TO_RESUME_STAGE[step];
}

export function socialContentStageFromCallbackStage(stage: string | null | undefined): SocialContentStage | null {
  const normalized = (stage ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (SOCIAL_CONTENT_STAGE_ORDER.includes(normalized as SocialContentStage)) {
    return normalized as SocialContentStage;
  }
  if (normalized === 'strategy' || normalized === 'planning') {
    return 'planning';
  }
  if (normalized === 'production') {
    return 'copy_production';
  }
  if (normalized === 'image_creatives' || normalized === 'image_generation') {
    return 'image_generation';
  }
  if (normalized === 'video_scripts') {
    return 'video_script';
  }
  if (normalized === 'approval') {
    return 'plan_review';
  }
  if (normalized === 'publish') {
    return 'publish_review';
  }
  if (normalized === 'research') {
    return 'research';
  }
  return null;
}

export function markSocialContentStageRunning(
  doc: MarketingJobRuntimeDocument,
  stage: SocialContentStage,
  output: Record<string, unknown> | null = null,
): SocialContentRuntimeState {
  const runtime = ensureSocialContentRuntimeState(doc);
  if (shouldIgnoreStatusTransition(runtime, stage, 'running')) {
    return runtime;
  }
  const record = ensureStageRecord(runtime, stage);
  if (!record.startedAt) {
    record.startedAt = nowIso();
  }
  record.status = 'running';
  if (output) {
    record.output = output;
  }
  runtime.currentStage = stage;
  runtime.activeApproval = null;
  updateRuntimeTimestamp(runtime);
  serializeRuntime(doc as MarketingDocWithSocialRuntime, runtime);
  return runtime;
}

export function markSocialContentStageCompleted(
  doc: MarketingJobRuntimeDocument,
  stage: SocialContentStage,
  input: {
    summary?: string | null;
    output?: Record<string, unknown> | null;
    artifacts?: SocialContentArtifact[];
  } = {},
): SocialContentRuntimeState {
  const runtime = ensureSocialContentRuntimeState(doc);
  if (shouldIgnoreStatusTransition(runtime, stage, 'completed')) {
    return runtime;
  }
  const record = ensureStageRecord(runtime, stage);
  if (!record.startedAt) {
    record.startedAt = nowIso();
  }
  record.status = 'completed';
  record.completedAt = nowIso();
  record.summary = input.summary ?? record.summary;
  record.output = input.output ?? record.output;
  record.artifacts = input.artifacts ?? record.artifacts;
  runtime.currentStage = stage;
  updateRuntimeTimestamp(runtime);
  serializeRuntime(doc as MarketingDocWithSocialRuntime, runtime);
  return runtime;
}

export function markSocialContentStageAwaitingApproval(
  doc: MarketingJobRuntimeDocument,
  input: {
    approvalStep: SocialContentApprovalStep;
    approvalId: string | null;
    workflowStepId: string | null;
    resumeToken: string | null;
    requestedAt?: string | null;
    summary?: string | null;
    output?: Record<string, unknown> | null;
    completedStage?: SocialContentStage | null;
    artifacts?: SocialContentArtifact[];
  },
): SocialContentRuntimeState {
  const runtime = ensureSocialContentRuntimeState(doc);
  const reviewStage = socialContentReviewStageForApprovalStep(input.approvalStep);
  if (input.completedStage && input.completedStage !== reviewStage) {
    const completedRecord = ensureStageRecord(runtime, input.completedStage);
    if (!completedRecord.startedAt) {
      completedRecord.startedAt = nowIso();
    }
    completedRecord.status = 'completed';
    completedRecord.completedAt = nowIso();
    completedRecord.summary = input.summary ?? completedRecord.summary;
    completedRecord.output = input.output ?? completedRecord.output;
    if (input.artifacts) {
      completedRecord.artifacts = input.artifacts;
    }
  }
  if (shouldIgnoreStatusTransition(runtime, reviewStage, 'awaiting_approval')) {
    return runtime;
  }
  const record = ensureStageRecord(runtime, reviewStage);
  if (!record.startedAt) {
    record.startedAt = nowIso();
  }
  record.status = 'awaiting_approval';
  record.summary = input.summary ?? record.summary;
  record.output = input.output ?? record.output;
  if (input.artifacts) {
    record.artifacts = input.artifacts;
  }
  runtime.currentStage = reviewStage;
  runtime.activeApproval = {
    approvalId: input.approvalId,
    approvalStep: input.approvalStep,
    workflowStepId: input.workflowStepId,
    resumeToken: input.resumeToken,
    status: 'awaiting_approval',
    requestedAt: input.requestedAt ?? nowIso(),
    approvedAt: null,
    deniedAt: null,
  };
  updateRuntimeTimestamp(runtime);
  serializeRuntime(doc as MarketingDocWithSocialRuntime, runtime);
  return runtime;
}

export function markSocialContentApprovalResolutionSubmitted(
  doc: MarketingJobRuntimeDocument,
  input: {
    approvalStep: SocialContentApprovalStep;
    approved: boolean;
  },
): SocialContentRuntimeState {
  const runtime = ensureSocialContentRuntimeState(doc);
  const reviewStage = socialContentReviewStageForApprovalStep(input.approvalStep);
  const reviewRecord = ensureStageRecord(runtime, reviewStage);
  if (input.approved) {
    reviewRecord.status = 'completed';
    reviewRecord.completedAt = reviewRecord.completedAt ?? nowIso();
    const nextStage = socialContentResumeStageForApprovalStep(input.approvalStep);
    if (nextStage === 'completed') {
      const completedRecord = ensureStageRecord(runtime, 'completed');
      completedRecord.status = 'completed';
      completedRecord.startedAt = completedRecord.startedAt ?? nowIso();
      completedRecord.completedAt = nowIso();
      runtime.currentStage = 'completed';
    } else {
      const nextRecord = ensureStageRecord(runtime, nextStage);
      nextRecord.status = 'running';
      nextRecord.startedAt = nextRecord.startedAt ?? nowIso();
      runtime.currentStage = nextStage;
    }
    runtime.activeApproval = null;
  } else {
    reviewRecord.status = 'failed';
    reviewRecord.completedAt = nowIso();
    const failedRecord = ensureStageRecord(runtime, 'failed');
    failedRecord.status = 'failed';
    failedRecord.startedAt = failedRecord.startedAt ?? nowIso();
    failedRecord.completedAt = nowIso();
    runtime.currentStage = 'failed';
    runtime.activeApproval = {
      approvalId: runtime.activeApproval?.approvalId ?? null,
      approvalStep: input.approvalStep,
      workflowStepId: runtime.activeApproval?.workflowStepId ?? null,
      resumeToken: runtime.activeApproval?.resumeToken ?? null,
      status: 'denied',
      requestedAt: runtime.activeApproval?.requestedAt ?? nowIso(),
      approvedAt: null,
      deniedAt: nowIso(),
    };
  }
  updateRuntimeTimestamp(runtime);
  serializeRuntime(doc as MarketingDocWithSocialRuntime, runtime);
  return runtime;
}

export function markSocialContentStageFailed(
  doc: MarketingJobRuntimeDocument,
  stage: SocialContentStage,
  message: string,
  output: Record<string, unknown> | null = null,
): SocialContentRuntimeState {
  const runtime = ensureSocialContentRuntimeState(doc);
  const record = ensureStageRecord(runtime, stage);
  if (!record.startedAt) {
    record.startedAt = nowIso();
  }
  record.status = 'failed';
  record.completedAt = nowIso();
  record.summary = message;
  record.output = output ?? record.output;
  const failedRecord = ensureStageRecord(runtime, 'failed');
  failedRecord.status = 'failed';
  failedRecord.startedAt = failedRecord.startedAt ?? nowIso();
  failedRecord.completedAt = nowIso();
  failedRecord.summary = message;
  failedRecord.output = output ?? failedRecord.output;
  runtime.currentStage = 'failed';
  runtime.activeApproval = null;
  updateRuntimeTimestamp(runtime);
  serializeRuntime(doc as MarketingDocWithSocialRuntime, runtime);
  return runtime;
}

export function isSocialContentPublishApprovalRequired(doc: MarketingJobRuntimeDocument): boolean {
  return ensureSocialContentRuntimeState(doc).publishingRequested;
}

/**
 * Sweeps every non-terminal social-content stage that precedes `upToStage`
 * (inclusive) from `running`/`pending`/`awaiting_approval` to `completed`.
 *
 * Called by the publish-skip path in the Hermes callback handler before the
 * job goes terminal. Without this sweep, stages like `copy_production`,
 * `image_briefing`, and `image_generation` can be left in `running` state
 * when the job transitions to `completed`, stranding the run with no images.
 *
 * Stages that are already `completed` or `failed` are left untouched.
 * The `completed` and `failed` sentinel stages are skipped — those are
 * managed by the caller.
 */
export function reconcileSocialContentIntermediateStages(
  doc: MarketingJobRuntimeDocument,
  upToStage: SocialContentStage,
  sweepSummary: string,
): SocialContentRuntimeState {
  const runtime = ensureSocialContentRuntimeState(doc);
  const targetRank = stageRank(upToStage);
  const sentinels = new Set<SocialContentStage>(['completed', 'failed']);

  for (const stage of SOCIAL_CONTENT_STAGE_ORDER) {
    if (sentinels.has(stage)) continue;
    if (stageRank(stage) > targetRank) break;
    const record = ensureStageRecord(runtime, stage);
    if (record.status === 'completed' || record.status === 'failed') continue;
    // Transition any running/pending/awaiting_approval stage to completed.
    if (!record.startedAt) {
      record.startedAt = nowIso();
    }
    record.status = 'completed';
    record.completedAt = nowIso();
    if (!record.summary) {
      record.summary = sweepSummary;
    }
  }

  updateRuntimeTimestamp(runtime);
  serializeRuntime(doc as MarketingDocWithSocialRuntime, runtime);
  return runtime;
}

function parsePosts(value: unknown): WeeklyPost[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is UnknownRecord => !!entry)
    .map((entry) => ({
      id: stringValue(entry.id),
      day: stringValue(entry.day),
      platforms: stringArray(entry.platforms),
      post_type: stringValue(entry.post_type),
      title: stringValue(entry.title),
      caption: stringValue(entry.caption),
      creative_brief_id: stringValue(entry.creative_brief_id),
      status: stringValue(entry.status),
    }));
}

function parseImageCreatives(value: unknown): ImageCreative[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is UnknownRecord => !!entry)
    .map((entry) => ({
      id: stringValue(entry.id),
      title: stringValue(entry.title),
      aspect_ratio: stringValue(entry.aspect_ratio),
      prompt: stringValue(entry.prompt),
      status: stringValue(entry.status),
      artifact_url: stringValue(entry.artifact_url),
    }));
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function parseVideoArtifactUrl(entry: UnknownRecord): string {
  const renderedVideo = asRecord(entry.rendered_video);
  const render = asRecord(entry.render);
  const asset = asRecord(entry.asset);

  return firstString(
    entry.artifact_url,
    entry.url,
    entry.rendered_video_url,
    entry.rendered_video_path,
    entry.video_url,
    entry.video_path,
    renderedVideo?.artifact_url,
    renderedVideo?.url,
    renderedVideo?.rendered_video_url,
    renderedVideo?.rendered_video_path,
    renderedVideo?.video_url,
    renderedVideo?.video_path,
    render?.artifact_url,
    render?.url,
    render?.rendered_video_url,
    render?.rendered_video_path,
    asset?.artifact_url,
    asset?.url,
    asset?.path,
  );
}

function parseVideoScripts(value: unknown): VideoScript[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is UnknownRecord => !!entry)
    .map((entry) => ({
      id: stringValue(entry.id),
      title: stringValue(entry.title),
      duration_seconds: numberValue(entry.duration_seconds),
      script_markdown: stringValue(entry.script_markdown),
      status: stringValue(entry.status),
      artifact_url: parseVideoArtifactUrl(entry),
    }));
}

export function parseSocialContentWorkflowOutput(value: unknown): SocialContentWorkflowProjection | null {
  const record = asRecord(value);
  if (!record) return null;

  const weeklyContentPlan = record.weekly_content_plan ?? record.weeklyPlan;
  const planRecord = asRecord(weeklyContentPlan);
  if (!planRecord) return null;

  return {
    summary: stringValue(record.summary),
    weekly_content_plan: {
      window_days: numberValue(planRecord.window_days),
      posts: parsePosts(planRecord.posts),
      image_creatives: parseImageCreatives(planRecord.image_creatives),
      video_scripts: parseVideoScripts(planRecord.video_scripts),
    },
  };
}

export function socialContentArtifactsFromProjection(
  projection: SocialContentWorkflowProjection,
): SocialContentArtifact[] {
  const imageArtifacts: SocialContentArtifact[] = projection.weekly_content_plan.image_creatives.map((creative, index) => ({
    id: creative.id || `image-${index + 1}`,
    type: 'image_creative',
    title: creative.title || `Image creative ${index + 1}`,
    status: creative.status || 'generated',
    summary: creative.prompt || creative.title || null,
    url: creative.artifact_url || null,
    metadata: {
      aspect_ratio: creative.aspect_ratio || null,
    },
  }));

  const scriptArtifacts: SocialContentArtifact[] = projection.weekly_content_plan.video_scripts.map((script, index) => ({
    id: script.id || `video-script-${index + 1}`,
    type: 'video_script',
    title: script.title || `Video script ${index + 1}`,
    status: script.status || 'generated',
    summary: script.script_markdown ? script.script_markdown.slice(0, 240) : null,
    url: script.artifact_url || null,
    metadata: {
      duration_seconds: script.duration_seconds,
    },
  }));

  return [...imageArtifacts, ...scriptArtifacts];
}
