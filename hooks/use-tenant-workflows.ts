'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createOperationsApi,
  type TenantWorkflow,
  type TenantWorkflowRunRequest,
  type TenantWorkflowRunResponse,
} from '@/lib/api/operations';
import { useAsyncAction, useRequestState } from './use-request-state';

export interface UseTenantWorkflowsOptions {
  baseUrl?: string;
  autoLoad?: boolean;
}

export function useTenantWorkflows(options: UseTenantWorkflowsOptions = {}) {
  const api = useMemo(() => createOperationsApi(options), [options.baseUrl]);
  const listState = useRequestState<TenantWorkflow[]>();
  const runState = useAsyncAction<TenantWorkflowRunResponse>();
  const { setError, setLoading, setSuccess } = listState;

  const refresh = useCallback(async () => {
    setLoading();
    try {
      const response = await api.tenantWorkflows();
      setSuccess(response.workflows);
      return response.workflows;
    } catch (error) {
      setError(error, 'Unable to load tenant workflows.');
      return null;
    }
  }, [api, setError, setLoading, setSuccess]);

  useEffect(() => {
    if (options.autoLoad === false) {
      return;
    }

    void refresh();
  }, [options.autoLoad, refresh]);

  return {
    list: {
      ...listState,
      refresh,
    },
    run: {
      ...runState,
      execute: (workflowId: string, body: TenantWorkflowRunRequest = {}) =>
        runState.run(
          () => api.runTenantWorkflow(workflowId, body),
          'Unable to run tenant workflow.'
        ),
    },
  };
}
