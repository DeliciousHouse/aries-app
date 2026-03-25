'use client';

import { useMemo } from 'react';

import {
  createMarketingApi,
  isMarketingErrorResult,
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
      state.run(async () => {
        const result = await api.approveJob(jobId, body);
        if (isMarketingErrorResult(result)) {
          throw new Error(
            (typeof result.message === 'string' && result.message.trim()) ||
              result.error ||
              'Approval request failed.'
          );
        }
        return result;
      }, 'Approval request failed.'),
  };
}
