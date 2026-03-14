import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOauthConnectInput } from '../../lib/oauth-connect-input';
import { verifyLogin } from '../../frontend/services/supabase';

test('placeholder login helper rejects authentication attempts', async () => {
  await assert.rejects(
    () => verifyLogin('user@example.com', 'Password1!'),
    /google oauth|temporarily unavailable/i
  );
});

test('integrations connect input uses authenticated tenant context instead of request body tenant_id', async () => {
  const request = new Request('https://aries.example.com/api/integrations/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged-tenant' }),
  });

  const input = await buildOauthConnectInput(request, {
    userId: 'user_123',
    tenantId: 'tenant_real',
    tenantSlug: 'acme',
    role: 'tenant_admin',
  });

  assert.equal(input.provider, 'facebook');
  assert.equal(input.payload.tenant_id, 'tenant_real');
});

test('integrations connect builds callback URLs from APP_BASE_URL using auth namespace', async () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://app.example.com';

  try {
    const request = new Request('https://ignored.example.com/api/integrations/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged-tenant' }),
    });

    const input = await buildOauthConnectInput(request, {
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    });
    assert.equal(input.payload.tenant_id, 'tenant_real');
    assert.equal(input.payload.redirect_uri, 'https://app.example.com/api/auth/oauth/facebook/callback');
  } finally {
    if (previousAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = previousAppBaseUrl;
    }
  }
});
