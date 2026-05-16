export type SocialContentJobType = 'weekly_social_content';

export type SocialContentStage =
  | 'intake'
  | 'research'
  | 'planning'
  | 'plan_review'
  | 'copy_production'
  | 'image_briefing'
  | 'image_generation'
  | 'creative_review'
  | 'video_script'
  | 'video_review'
  | 'video_render'
  | 'publish_review'
  | 'completed'
  | 'failed';

export type SocialContentStageStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

export type SocialContentApprovalStep =
  | 'approve_weekly_plan'
  | 'approve_post_copy'
  | 'approve_image_creatives'
  | 'approve_video_script'
  | 'approve_video_render'
  | 'approve_publish';

export type SocialContentArtifact = {
  id: string;
  type: string;
  title: string;
  status: string;
  summary: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
};

export type SocialContentStageRecord = {
  stage: SocialContentStage;
  status: SocialContentStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  summary: string | null;
  output: Record<string, unknown> | null;
  artifacts: SocialContentArtifact[];
};

export type SocialContentApprovalCheckpoint = {
  approvalId: string | null;
  approvalStep: SocialContentApprovalStep;
  workflowStepId: string | null;
  resumeToken: string | null;
  status: 'awaiting_approval' | 'approved' | 'denied';
  requestedAt: string;
  approvedAt: string | null;
  deniedAt: string | null;
};

export type SocialContentRuntimeState = {
  schemaName: 'social_content_runtime_state';
  schemaVersion: '1.0.0';
  currentStage: SocialContentStage;
  stageOrder: SocialContentStage[];
  stages: Record<SocialContentStage, SocialContentStageRecord>;
  activeApproval: SocialContentApprovalCheckpoint | null;
  publishingRequested: boolean;
  updatedAt: string;
};

export interface WeeklySocialContentPayload {
  brandUrl: string;
  businessName?: string;
  businessType: string;
  primaryGoal: string;
  offer?: string;
  audience?: string;
  competitorUrl?: string;
  competitorBrand?: string;
  facebookPageUrl?: string;
  adLibraryUrl?: string;
  channels: Array<'meta' | 'instagram' | 'linkedin' | 'x' | 'tiktok' | 'youtube'>;
  campaignWindowDays: number;
  staticPostCount: number;
  imageCreativeCount: number;
  videoScriptCount: number;
  videoRenderCount: number;
  brandVoice?: string;
  styleVibe?: string;
  visualReferences?: string[];
  mustUseCopy?: string;
  mustAvoidAesthetics?: string;
  forbiddenVisualPatterns?: string[];
  notes?: string;
}

export const DEFAULT_SOCIAL_CONTENT_CHANNELS: WeeklySocialContentPayload['channels'] = [
  'meta',
  'instagram',
];

export const DEFAULT_SOCIAL_CONTENT_FORBIDDEN_PATTERNS: string[] = [
  'split-screen',
  'before/after',
  'side-by-side comparison',
  'two-panel layout',
  'old way vs new way',
  'generic stock office',
];

export const DEFAULT_SOCIAL_CONTENT_COUNTS = {
  campaignWindowDays: 7 as const,
  staticPostCount: 7,
  imageCreativeCount: 3,
  videoScriptCount: 1,
  videoRenderCount: 0,
};
