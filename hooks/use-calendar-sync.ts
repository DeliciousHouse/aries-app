'use client';

import { useMemo } from 'react';

import {
  createOperationsApi,
  type CalendarSyncRequest,
  type CalendarSyncResponse,
} from '@/lib/api/operations';
import { useAsyncAction } from './use-request-state';

export interface UseCalendarSyncOptions {
  baseUrl?: string;
}

export function useCalendarSync(options: UseCalendarSyncOptions = {}) {
  const api = useMemo(() => createOperationsApi(options), [options.baseUrl]);
  const state = useAsyncAction<CalendarSyncResponse>();

  return {
    ...state,
    sync: (body: CalendarSyncRequest = {}) =>
      state.run(() => api.calendarSync(body), 'Unable to start calendar sync.'),
  };
}
