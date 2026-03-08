import type {
  PostMarketingJobsRequest,
  StartJobAccepted,
  GetMarketingJobStatusResponse,
  PostMarketingJobApproveRequest,
  ApproveJobResult,
  HardFailureError,
  UnhandledError
} from '../contracts/marketing';

export interface MarketingClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type MarketingResult<T> = T | HardFailureError | UnhandledError;

function mkUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function createMarketingClient(options: MarketingClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async createJob(body: PostMarketingJobsRequest): Promise<MarketingResult<StartJobAccepted>> {
      const res = await fetchImpl(mkUrl(baseUrl, '/api/marketing/jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    },

    async getJob(jobId: string): Promise<MarketingResult<GetMarketingJobStatusResponse>> {
      const res = await fetchImpl(mkUrl(baseUrl, `/api/marketing/jobs/${encodeURIComponent(jobId)}`), {
        method: 'GET'
      });
      return res.json();
    },

    async approveJob(jobId: string, body: PostMarketingJobApproveRequest): Promise<MarketingResult<ApproveJobResult>> {
      const res = await fetchImpl(mkUrl(baseUrl, `/api/marketing/jobs/${encodeURIComponent(jobId)}/approve`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    }
  };
}
