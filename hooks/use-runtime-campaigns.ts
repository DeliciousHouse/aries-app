'use client';

import { useCallback, useEffect, useMemo } from 'react';

import { createAriesV1Api, type CampaignListResponse } from '@/lib/api/aries-v1';
import { useRequestState } from './use-request-state';

export function useRuntimeCampaigns(options: { baseUrl?: string; autoLoad?: boolean } = {}) {
  const api = useMemo(() => createAriesV1Api(options), [options.baseUrl]);
  const state = useRequestState<CampaignListResponse>();
  const { setError, setLoading, setSuccess } = state;

  const load = useCallback(async () => {
    setLoading();
    try {
      const response = await api.getCampaigns();
      setSuccess(response);
      return response;
    } catch (error) {
      setError(error, 'Failed to load campaigns.');
      return null;
    }
  }, [api, setError, setLoading, setSuccess]);

  useEffect(() => {
    if (options.autoLoad === false) return;
    void load();
  }, [load, options.autoLoad]);

  return { ...state, load };
}
