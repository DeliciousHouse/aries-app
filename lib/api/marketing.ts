import { requestJson, type ApiClientOptions } from './http';

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
}

export interface GetMarketingJobStatusResponse {
  jobId: string;
  tenantId: string | null;
  marketing_job_state: string;
  marketing_job_status: string;
  marketing_stage: string | null;
  marketing_stage_status: Record<string, string>;
  updatedAt: string | null;
  needs_attention: boolean;
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
  reason?: string;
}

export interface MarketingApiError {
  error: string;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export type MarketingResult<TData> = TData | MarketingApiError;

export function createMarketingApi(options: ApiClientOptions = {}) {
  return {
    createJob(body: PostMarketingJobsRequest) {
      return requestJson<MarketingResult<StartJobAccepted>>(
        '/api/marketing/jobs',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    getJob(jobId: string) {
      return requestJson<MarketingResult<GetMarketingJobStatusResponse>>(
        `/api/marketing/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options
      );
    },

    approveJob(jobId: string, body: PostMarketingJobApproveRequest) {
      return requestJson<MarketingResult<ApproveJobResult>>(
        `/api/marketing/jobs/${encodeURIComponent(jobId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },
  };
}

export function isMarketingErrorResult<TData>(
  value: MarketingResult<TData>
): value is MarketingApiError {
  return typeof (value as MarketingApiError)?.error === 'string';
}
