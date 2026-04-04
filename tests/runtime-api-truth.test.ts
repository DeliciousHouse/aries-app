import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as postContact } from '../app/api/contact/route';
import { POST as postPublishDispatch } from '../app/api/publish/dispatch/route';
import { POST as postMarketingJobs } from '../app/api/marketing/jobs/route';

test('/api/contact returns an explicit unavailable response until a real adapter is configured', async () => {
  const response = await postContact(
    new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Avery Example',
        email: 'avery@example.com',
        message: 'Need help with Aries.',
      }),
    }),
  );

  assert.equal(response.status, 501);
  const body = (await response.json()) as {
    status: string;
    reason: string;
    message: string;
    request: {
      name: string | null;
      email: string | null;
      message_present: boolean;
    };
  };
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'contact_not_configured');
  assert.match(body.message, /not configured/i);
  assert.equal(body.request.name, 'Avery Example');
  assert.equal(body.request.email, 'avery@example.com');
  assert.equal(body.request.message_present, true);
});

test('/api/publish/dispatch requires authenticated tenant context', async () => {
  const response = await postPublishDispatch(
    new Request('http://localhost/api/publish/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'facebook',
        content: 'hello world',
        media_urls: [],
      }),
    }),
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as {
    status: string;
    reason: string;
    message: string;
  };
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'tenant_context_required');
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
});

test('/api/marketing/jobs requires authenticated tenant context', async () => {
  const response = await postMarketingJobs(
    new Request('http://localhost/api/marketing/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobType: 'brand_campaign',
        payload: {
          brandUrl: 'https://brand.example',
          competitorUrl: 'https://betterup.com',
        },
      }),
    }),
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as {
    status: string;
    reason: string;
    message: string;
  };
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'tenant_context_required');
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
});
