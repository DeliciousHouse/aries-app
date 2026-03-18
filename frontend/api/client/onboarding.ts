import { createOnboardingApi, type OnboardingStatusQuery } from '@/lib/api/onboarding';
import type { ApiClientOptions } from '@/lib/api/http';

export interface OnboardingStatusPathParams {
  tenantId: string;
}

export type OnboardingClientOptions = ApiClientOptions;

export function createOnboardingClient(options: OnboardingClientOptions = {}) {
  const api = createOnboardingApi(options);

  return {
    start: api.start,
    status(
      params: OnboardingStatusPathParams | string,
      query?: OnboardingStatusQuery
    ) {
      const tenantId = typeof params === 'string' ? params : params.tenantId;
      return api.status(tenantId, query);
    },
  };
}
