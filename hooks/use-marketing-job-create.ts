'use client';

import { useMemo } from 'react';

import {
  createMarketingApi,
  isMarketingErrorResult,
  parseMarketingFieldErrors,
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

  // Prefer structured field errors from a 422 response body over the generic
  // top-level error message. Both the thrown ApiRequestError (via state.error.details)
  // and an inline MarketingApiError result carry the same shape.
  const fieldErrors = useMemo<Record<string, string>>(() => {
    if (state.error?.status === 422) {
      const parsed = parseMarketingFieldErrors(state.error.details);
      if (Object.keys(parsed).length > 0) return parsed;
    }
    // Also support success-shaped error envelopes ({ error: ..., errors: [...] })
    const data = state.data;
    if (data && typeof data === 'object' && isMarketingErrorResult(data)) {
      return parseMarketingFieldErrors(data);
    }
    return {};
  }, [state.error, state.data]);

  return {
    ...state,
    fieldErrors,
    createJob: (body: PostMarketingJobsRequest | FormData) =>
      state.run(async () => {
        const result = await api.createJob(body);
        if (isMarketingErrorResult(result)) {
          const err = new Error(
            (typeof result.message === 'string' && result.message.trim()) ||
              result.error ||
              'Failed to create marketing job.'
          ) as Error & { status?: number; code?: string; details?: unknown };
          err.status = 422;
          err.code = typeof result.error === 'string' ? result.error : 'validation_failed';
          err.details = result;
          throw err;
        }
        return result;
      }, 'Failed to create marketing job.'),
  };
}
