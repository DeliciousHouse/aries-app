import { requestJson, type ApiClientOptions } from './http';

export type MarketingJobType = 'brand_campaign';
export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';

export interface BrandCampaignPayload {
  brandUrl: string;
  competitorUrl: string;
}

export interface PostMarketingJobsRequest {
  jobType: MarketingJobType;
  payload: BrandCampaignPayload;
}

export interface StartJobAccepted {
  marketing_job_status: 'accepted';
  jobId: string;
  jobType: MarketingJobType;
  approvalRequired?: boolean;
  jobStatusUrl?: string;
}

export interface GetMarketingJobStatusResponse {
  jobId: string;
  marketing_job_state: string;
  marketing_job_status: string;
  marketing_stage: string | null;
  marketing_stage_status: Record<string, string>;
  updatedAt: string | null;
  needs_attention: boolean;
  approvalRequired?: boolean;
}

export interface PostMarketingJobApproveRequest {
  approvedBy: string;
  approvedStages?: MarketingStage[];
  resumePublishIfNeeded?: boolean;
}

export interface ApproveJobResult {
  approval_status: 'resumed' | 'error';
  jobId: string;
  resumedStage: string | null;
  completed: boolean;
  reason?: string;
  jobStatusUrl?: string;
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
