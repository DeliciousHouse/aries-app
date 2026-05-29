'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createAriesV1Api, type SocialContentListResponse } from '@/lib/api/aries-v1';
import { useRequestState } from './use-request-state';

export function useRuntimePosts(options: { baseUrl?: string; autoLoad?: boolean } = {}) {
  // Callers pass inline object literals (e.g. `{ autoLoad: true }`) which
  // produce a new reference on every render.  Extract the two primitive values
  // so every useMemo / useCallback / useEffect below depends only on stable
  // scalars — never on the transient object identity.  Without this, the
  // options object reference captured inside deleteCampaign / restoreCampaign
  // caused those callbacks to be recreated on every render, which in turn
  // recreated `load`, which re-fired the autoLoad effect, producing the
  // observed back-to-back refetch loop on /dashboard/results and
  // /dashboard/social-content (visible as repeated [jobs-cache] miss →
  // [marketing-hydration] workspace-view entries in prod logs).
  const baseUrl = options.baseUrl;
  const autoLoad = options.autoLoad;

  const api = useMemo(() => createAriesV1Api({ baseUrl }), [baseUrl]);
  const state = useRequestState<SocialContentListResponse>();
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
      const response = await api.getSocialContentList();
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
        const base = baseUrl || '';
        const response = await fetch(`${base}/api/marketing/jobs/${encodeURIComponent(jobId)}`, {
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
    [baseUrl, busyCampaignId, load],
  );

  const restoreCampaign = useCallback(
    async (jobId: string) => {
      if (!jobId || busyCampaignId) {
        return false;
      }
      setBusyCampaignId(jobId);
      setActionError(null);
      try {
        const base = baseUrl || '';
        const response = await fetch(`${base}/api/marketing/jobs/${encodeURIComponent(jobId)}/restore`, {
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
    [baseUrl, busyCampaignId, load],
  );

  useEffect(() => {
    if (autoLoad === false) return;
    void load();
  }, [autoLoad, load]);

  return {
    ...state,
    load,
    deleteCampaign,
    restoreCampaign,
    busyCampaignId,
    actionError,
  };
}
