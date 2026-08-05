'use client';

import { useCallback, useEffect } from 'react';

import type { WeeklyResultsReport } from '@/backend/marketing/weekly-results-report';

import { useRequestState } from './use-request-state';

export type WeeklyResultsResponse =
  | { enabled: false }
  | { enabled: true; report: WeeklyResultsReport };

/**
 * S5-1 / AA-110 — loads GET /api/dashboard/weekly-results.
 *
 * A single GET; nothing to parallelize. `{ enabled: false }` is a valid success
 * (the flag is off), not an error — the panel simply renders nothing.
 */
export function useWeeklyResults(options: { autoLoad?: boolean; week?: string } = {}) {
  const { autoLoad, week } = options;
  const state = useRequestState<WeeklyResultsResponse>();
  const { setError, setLoading, setSuccess } = state;

  const load = useCallback(async () => {
    setLoading();
    try {
      const qs = week ? `?week=${encodeURIComponent(week)}` : '';
      const res = await fetch(`/api/dashboard/weekly-results${qs}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`Weekly results are not available right now (${res.status}).`);
      }
      const data = (await res.json()) as WeeklyResultsResponse;
      setSuccess(data);
      return data;
    } catch (error) {
      setError(error, 'Failed to load this week’s results.');
      return null;
    }
  }, [week, setError, setLoading, setSuccess]);

  useEffect(() => {
    if (autoLoad === false) return;
    void load();
  }, [autoLoad, load]);

  return { ...state, load, reload: load };
}
