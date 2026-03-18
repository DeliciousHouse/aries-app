'use client';

import { useMemo } from 'react';

import {
  createOperationsApi,
  type PublishRetryRequest,
  type PublishRetryResponse,
} from '@/lib/api/operations';
import { useAsyncAction } from './use-request-state';

export interface UsePublishRetryOptions {
  baseUrl?: string;
}

export function usePublishRetry(options: UsePublishRetryOptions = {}) {
  const api = useMemo(() => createOperationsApi(options), [options.baseUrl]);
  const state = useAsyncAction<PublishRetryResponse>();

  return {
    ...state,
    retry: (body: PublishRetryRequest = {}) =>
      state.run(() => api.publishRetry(body), 'Unable to schedule publish retry.'),
  };
}
