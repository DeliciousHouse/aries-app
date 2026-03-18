'use client';

import { useMemo } from 'react';

import {
  createMarketingApi,
  type ApproveJobResult,
  type MarketingResult,
  type PostMarketingJobApproveRequest,
} from '@/lib/api/marketing';
import { useAsyncAction } from './use-request-state';

export interface UseMarketingJobApproveOptions {
  baseUrl?: string;
}

export function useMarketingJobApprove(options: UseMarketingJobApproveOptions = {}) {
  const api = useMemo(() => createMarketingApi(options), [options.baseUrl]);
  const state = useAsyncAction<MarketingResult<ApproveJobResult>>();

  return {
    ...state,
    approveJob: (jobId: string, body: PostMarketingJobApproveRequest) =>
      state.run(() => api.approveJob(jobId, body), 'Approval request failed.'),
  };
}
