'use client';

import { useMemo } from 'react';

import {
  createMarketingApi,
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
      state.run(() => api.createJob(body), 'Failed to create marketing job.'),
  };
}
