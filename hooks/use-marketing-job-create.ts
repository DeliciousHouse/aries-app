'use client';

import { useMemo } from 'react';

import {
  createMarketingApi,
  isMarketingErrorResult,
  type MarketingResult,
  type PostMarketingJobsRequest,
  type StartJobAccepted,
} from '@/lib/api/marketing';
import { useAsyncAction } from './use-request-state';

export interface UseMarketingJobCreateOptions {
  baseUrl?: string;
}

export function useMarketingJobCreate(options: UseMarketingJobCreateOptions = {}) {
  const api = useMemo(() => createMarketingApi(options), [options.baseUrl]);
  const state = useAsyncAction<MarketingResult<StartJobAccepted>>();

  return {
    ...state,
    createJob: (body: PostMarketingJobsRequest) =>
      state.run(async () => {
        const result = await api.createJob(body);
        if (isMarketingErrorResult(result)) {
          throw new Error(
            (typeof result.message === 'string' && result.message.trim()) ||
              result.error ||
              'Failed to create marketing job.'
          );
        }
        return result;
      }, 'Failed to create marketing job.'),
  };
}
