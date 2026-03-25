import assert from 'node:assert/strict';
import test from 'node:test';

import { createOnboardingClient } from '../frontend/api/client/onboarding';
import { normalizeMarketingJobId } from '../frontend/marketing/job-status';
import { resolveOnboardingStatusHref } from '../frontend/onboarding/start';

test('resolveOnboardingStatusHref prefers backend-confirmed tenant and signup event ids', () => {
  const href = resolveOnboardingStatusHref(
    {
      tenant_id: 'tenant_backend',
      signup_event_id: 'signup_backend',
    },
    'tenant_form',
    'signup_form',
  );

  assert.equal(href, '/onboarding/status?tenant_id=tenant_backend&signup_event_id=signup_backend');
});

test('createOnboardingClient.status appends signup_event_id when provided', async () => {
  const requests: string[] = [];
  const client = createOnboardingClient({
    baseUrl: 'https://aries.example.com',
    fetchImpl: (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      return new Response(
        JSON.stringify({
          onboarding_status: 'ok',
          tenant_id: 'tenant_backend',
          signup_event_id: 'signup_backend',
          provisioning_status: 'in_progress',
          validation_status: 'unknown',
          progress_hint: 'waiting_for_validation',
          artifacts: {
            draft: false,
            validated: false,
            validation_report: false,
            idempotency_marker: false,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch,
  });

  await client.status('tenant_backend', { signup_event_id: 'signup_backend' });

  assert.deepEqual(requests, [
    'https://aries.example.com/api/onboarding/status/tenant_backend?signup_event_id=signup_backend',
  ]);
});

test('normalizeMarketingJobId trims route-provided job ids for auto-load', () => {
  assert.equal(normalizeMarketingJobId('  mkt_123  '), 'mkt_123');
  assert.equal(normalizeMarketingJobId(''), '');
  assert.equal(normalizeMarketingJobId(undefined), '');
});
