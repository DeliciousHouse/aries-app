'use client';

import { useMemo } from 'react';

import {
  createOperationsApi,
  type PublishDispatchRequest,
  type PublishDispatchResponse,
} from '@/lib/api/operations';
import { useAsyncAction } from './use-request-state';

export interface UsePublishDispatchOptions {
  baseUrl?: string;
}

export function usePublishDispatch(options: UsePublishDispatchOptions = {}) {
  const api = useMemo(() => createOperationsApi(options), [options.baseUrl]);
  const state = useAsyncAction<PublishDispatchResponse>();

  return {
    ...state,
    dispatch: (body: PublishDispatchRequest) =>
      state.run(() => api.publishDispatch(body), 'Unable to dispatch publish request.'),
  };
}
