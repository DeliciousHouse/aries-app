export type MarketingJobType =
  | 'marketing_research'
  | 'marketing_strategy'
  | 'marketing_production'
  | 'marketing_publish'
  | 'unknown';

export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';

export interface PostMarketingJobsRequest {
  tenantId: string;
  jobType: MarketingJobType;
  payload?: Record<string, unknown>;
}

export interface StartJobAccepted {
  status: 'accepted';
  jobId: string;
  tenantId: string;
  jobType: MarketingJobType;
  wiring: 'n8n_research_webhook' | 'backend_fallback';
  runtimePath: string;
}

export interface GetMarketingJobStatusResponse {
  jobId: string;
  tenantId: string | null;
  state: string;
  status: string;
  currentStage: string | null;
  stageStatus: Record<string, string>;
  updatedAt: string | null;
  runtimePath: string;
}

export interface PostMarketingJobApproveRequest {
  tenantId: string;
  approvedBy: string;
  approvedStages?: MarketingStage[];
  resumePublishIfNeeded?: boolean;
}

export interface ApproveJobResult {
  status: 'resumed' | 'error';
  jobId: string;
  tenantId: string;
  resumedStage: string | null;
  completed: boolean;
  wiring: 'n8n_approval_resume_webhook' | 'backend_fallback';
}

export interface HardFailureError {
  error: `HARD_FAILURE:${string}`;
  [k: string]: unknown;
}

export interface UnhandledError {
  error: string;
  [k: string]: unknown;
}
