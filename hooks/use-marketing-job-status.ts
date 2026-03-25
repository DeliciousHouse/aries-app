'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createMarketingApi,
  isMarketingErrorResult,
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
  const { reset, setError, setLoading, setSuccess } = state;

  const load = useCallback(
    async (jobId: string, loadOptions: LoadMarketingJobStatusOptions = {}) => {
      const normalizedJobId = jobId.trim();
      if (!normalizedJobId) {
        setError(new Error('jobId is required'));
        return null;
      }

      if (!loadOptions.quiet) {
        setLoading();
      }
      try {
        const response = await api.getJob(normalizedJobId);
        if (isMarketingErrorResult(response)) {
          const message =
            (typeof response.message === 'string' && response.message.trim()) ||
            response.error ||
            'Failed to load job status.';
          reset();
          setError(new Error(message));
          return null;
        }
        setSuccess(response);
        return response;
      } catch (error) {
        setError(error, 'Failed to load job status.');
        return null;
      }
    },
    [api, reset, setError, setLoading, setSuccess]
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
