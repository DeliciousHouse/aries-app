import type {
  OnboardingStartRequest,
  OnboardingStartSuccess,
  OnboardingStartError,
  OnboardingStatusSuccess,
  OnboardingStatusError,
  OnboardingStatusPathParams,
  OnboardingStatusQuery
} from '../contracts/onboarding';

export interface OnboardingClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function mkUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function createOnboardingClient(options: OnboardingClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async start(body: OnboardingStartRequest): Promise<OnboardingStartSuccess | OnboardingStartError> {
      const res = await fetchImpl(mkUrl(baseUrl, '/api/onboarding/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    },

    async status(
      params: OnboardingStatusPathParams | string,
      query?: OnboardingStatusQuery
    ): Promise<OnboardingStatusSuccess | OnboardingStatusError> {
      const tenantId = typeof params === 'string' ? params : params.tenantId;
      const qs = new URLSearchParams();
      if (query?.signup_event_id) qs.set('signup_event_id', query.signup_event_id);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const res = await fetchImpl(
        mkUrl(baseUrl, `/api/onboarding/status/${encodeURIComponent(tenantId)}${suffix}`),
        { method: 'GET' }
      );
      return res.json();
    }
  };
}
