export type MarketingJobType = 'brand_campaign';

export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';

export interface BrandCampaignPayload {
  brandUrl: string;
  competitorUrl: string;
}

export interface PostMarketingJobsRequest {
  tenantId: string;
  jobType: MarketingJobType;
  payload: BrandCampaignPayload;
}

export interface StartJobAccepted {
  marketing_job_status: 'accepted';
  jobId: string;
  tenantId: string;
  jobType: MarketingJobType;
  wiring: 'openclaw_gateway';
  runtimePath: string;
}

export interface GetMarketingJobStatusResponse {
  jobId: string;
  tenantId: string | null;
  marketing_job_state: string;
  marketing_job_status: string;
  marketing_stage: string | null;
  marketing_stage_status: Record<string, string>;
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
  approval_status: 'resumed' | 'error';
  jobId: string;
  tenantId: string;
  resumedStage: string | null;
  completed: boolean;
  wiring: 'openclaw_gateway';
}

export interface HardFailureError {
  error: `HARD_FAILURE:${string}`;
  [k: string]: unknown;
}

export interface UnhandledError {
  error: string;
  [k: string]: unknown;
}
