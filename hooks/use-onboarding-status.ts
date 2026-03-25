'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createOnboardingApi,
  type OnboardingStatusQuery,
  type OnboardingStatusResponse,
} from '@/lib/api/onboarding';
import { useRequestState } from './use-request-state';

export interface UseOnboardingStatusOptions {
  baseUrl?: string;
  tenantId?: string;
  query?: OnboardingStatusQuery;
  autoLoad?: boolean;
}

export function useOnboardingStatus(options: UseOnboardingStatusOptions = {}) {
  const api = useMemo(() => createOnboardingApi(options), [options.baseUrl]);
  const state = useRequestState<OnboardingStatusResponse>();
  const { setError, setLoading, setSuccess } = state;

  const load = useCallback(
    async (tenantId: string, query?: OnboardingStatusQuery) => {
      const normalizedTenantId = tenantId.trim();
      if (!normalizedTenantId) {
        setError(new Error('tenant_id is required'));
        return null;
      }

      setLoading();
      try {
        const response = await api.status(normalizedTenantId, query);
        setSuccess(response);
        return response;
      } catch (error) {
        setError(error, 'Unable to load onboarding status.');
        return null;
      }
    },
    [api, setError, setLoading, setSuccess]
  );

  useEffect(() => {
    if (!options.autoLoad || !options.tenantId?.trim()) {
      return;
    }

    void load(options.tenantId, options.query);
  }, [load, options.autoLoad, options.query, options.tenantId]);

  return {
    ...state,
    load,
  };
}
