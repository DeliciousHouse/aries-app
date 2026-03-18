'use client';

import { useMemo } from 'react';

import {
  createOnboardingApi,
  type OnboardingStartRequest,
  type OnboardingStartResponse,
} from '@/lib/api/onboarding';
import { useAsyncAction } from './use-request-state';

export interface UseOnboardingStartOptions {
  baseUrl?: string;
}

export function useOnboardingStart(options: UseOnboardingStartOptions = {}) {
  const api = useMemo(() => createOnboardingApi(options), [options.baseUrl]);
  const state = useAsyncAction<OnboardingStartResponse>();

  return {
    ...state,
    start: (body: OnboardingStartRequest) =>
      state.run(() => api.start(body), 'Unable to start onboarding.'),
  };
}
