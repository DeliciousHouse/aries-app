'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createMarketingApi,
  type GetMarketingJobStatusResponse,
  type MarketingResult,
} from '@/lib/api/marketing';
import { useRequestState } from './use-request-state';

export interface UseMarketingJobStatusOptions {
  baseUrl?: string;
  jobId?: string;
  autoLoad?: boolean;
}

export interface LoadMarketingJobStatusOptions {
  quiet?: boolean;
}

export function useMarketingJobStatus(options: UseMarketingJobStatusOptions = {}) {
  const api = useMemo(() => createMarketingApi(options), [options.baseUrl]);
  const state = useRequestState<MarketingResult<GetMarketingJobStatusResponse>>();

  const load = useCallback(
    async (jobId: string, loadOptions: LoadMarketingJobStatusOptions = {}) => {
      const normalizedJobId = jobId.trim();
      if (!normalizedJobId) {
        state.setError(new Error('jobId is required'));
        return null;
      }

      if (!loadOptions.quiet) {
        state.setLoading();
      }
      try {
        const response = await api.getJob(normalizedJobId);
        state.setSuccess(response);
        return response;
      } catch (error) {
        state.setError(error, 'Failed to load job status.');
        return null;
      }
    },
    [api, state]
  );

  useEffect(() => {
    if (!options.autoLoad || !options.jobId?.trim()) {
      return;
    }

    void load(options.jobId);
  }, [load, options.autoLoad, options.jobId]);

  return {
    ...state,
    load,
  };
}
