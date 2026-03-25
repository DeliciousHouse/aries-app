'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createMarketingApi,
  isMarketingErrorResult,
  type GetMarketingJobStatusResponse,
} from '@/lib/api/marketing';
import { ApiRequestError } from '@/lib/api/http';
import { useRequestState } from './use-request-state';

export interface UseLatestMarketingJobOptions {
  baseUrl?: string;
  autoLoad?: boolean;
}

export function useLatestMarketingJob(options: UseLatestMarketingJobOptions = {}) {
  const api = useMemo(() => createMarketingApi(options), [options.baseUrl]);
  const state = useRequestState<GetMarketingJobStatusResponse | null>();
  const { reset, setError, setLoading, setSuccess } = state;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading();
    }
    try {
      const response = await api.getLatestJob();
      if (isMarketingErrorResult(response)) {
        const message =
          (typeof response.message === 'string' && response.message.trim()) ||
          response.error ||
          'Failed to load latest marketing job.';
        reset();
        setError(new Error(message));
        return null;
      }
      setSuccess(response);
      return response;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setSuccess(null);
        return null;
      }
      setError(error, 'Failed to load latest marketing job.');
      return null;
    }
  }, [api, reset, setError, setLoading, setSuccess]);

  useEffect(() => {
    if (!options.autoLoad) {
      return;
    }

    void load();
  }, [load, options.autoLoad]);

  return {
    ...state,
    load,
  };
}
