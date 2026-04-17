'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createAriesV1Api, type CampaignListResponse } from '@/lib/api/aries-v1';
import { useRequestState } from './use-request-state';

export function useRuntimeCampaigns(options: { baseUrl?: string; autoLoad?: boolean } = {}) {
  const api = useMemo(() => createAriesV1Api(options), [options.baseUrl]);
  const state = useRequestState<CampaignListResponse>();
  const { setError, setLoading, setSuccess } = state;
  // `busyCampaignId` is a single-slot lock keyed by jobId. We intentionally
  // avoid a set/map because the UI only ever fires one delete or restore at
  // a time (per row), and a single in-flight id keeps the state simple for
  // callers to render "deleting…" / "restoring…" labels.
  const [busyCampaignId, setBusyCampaignId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const deleteCampaign = useCallback(
    async (jobId: string) => {
      if (!jobId || busyCampaignId) {
        return false;
      }
      setBusyCampaignId(jobId);
      setActionError(null);
      try {
        const baseUrl = options.baseUrl || '';
        const response = await fetch(`${baseUrl}/api/marketing/jobs/${encodeURIComponent(jobId)}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setActionError(body.error || 'Failed to delete campaign.');
          return false;
        }
        await load();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Failed to delete campaign.');
        return false;
      } finally {
        setBusyCampaignId(null);
      }
    },
    [busyCampaignId, load, options.baseUrl],
  );

  const restoreCampaign = useCallback(
    async (jobId: string) => {
      if (!jobId || busyCampaignId) {
        return false;
      }
      setBusyCampaignId(jobId);
      setActionError(null);
      try {
        const baseUrl = options.baseUrl || '';
        const response = await fetch(`${baseUrl}/api/marketing/jobs/${encodeURIComponent(jobId)}/restore`, {
          method: 'POST',
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setActionError(body.error || 'Failed to restore campaign.');
          return false;
        }
        await load();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Failed to restore campaign.');
        return false;
      } finally {
        setBusyCampaignId(null);
      }
    },
    [busyCampaignId, load, options.baseUrl],
  );

  useEffect(() => {
    if (options.autoLoad === false) return;
    void load();
  }, [load, options.autoLoad]);

  return {
    ...state,
    load,
    deleteCampaign,
    restoreCampaign,
    busyCampaignId,
    actionError,
  };
}
