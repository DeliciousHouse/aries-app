'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createAriesV1Api,
  type InsightsAccountMetricsResponse,
  type InsightsPostsResponse,
  type InsightsSummaryResponse,
} from '@/lib/api/aries-v1';

import { useRequestState } from './use-request-state';

export type InsightsAnalyticsData = {
  summary: InsightsSummaryResponse;
  accountMetrics: InsightsAccountMetricsResponse;
  posts: InsightsPostsResponse;
};

/**
 * Loads the three read-only insights endpoints (#596) for the analytics screen.
 * Facebook-only: the platform filter defaults to `facebook` (Instagram is
 * deferred). The three fetches are independent client-side GETs, so they run in
 * parallel — this is the browser issuing three HTTP requests, NOT a server-side
 * DB fan-out within one endpoint (the pool-contention guardrail does not apply).
 * Any failure surfaces as a single error+retry; an all-zero/empty payload is a
 * valid success the screen renders as an empty state.
 */
export function useInsightsAnalytics(
  options: { baseUrl?: string; autoLoad?: boolean; platform?: string; days?: number } = {},
) {
  const baseUrl = options.baseUrl;
  const autoLoad = options.autoLoad;
  const platform = options.platform ?? 'facebook';
  const days = options.days;

  const api = useMemo(() => createAriesV1Api({ baseUrl }), [baseUrl]);
  const state = useRequestState<InsightsAnalyticsData>();
  const { setError, setLoading, setSuccess } = state;

  const load = useCallback(async () => {
    setLoading();
    try {
      const [summary, accountMetrics, posts] = await Promise.all([
        api.getInsightsSummary({ platform, days }),
        api.getInsightsAccountMetrics({ platform, days }),
        api.getInsightsPosts({ platform }),
      ]);
      const data: InsightsAnalyticsData = { summary, accountMetrics, posts };
      setSuccess(data);
      return data;
    } catch (error) {
      setError(error, 'Failed to load analytics.');
      return null;
    }
  }, [api, platform, days, setError, setLoading, setSuccess]);

  useEffect(() => {
    if (autoLoad === false) return;
    void load();
  }, [load, autoLoad]);

  return { ...state, load };
}
