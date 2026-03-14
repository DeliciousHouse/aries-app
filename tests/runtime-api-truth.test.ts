import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as postContact } from '../app/api/contact/route';
import { POST as postWaitlist } from '../app/api/waitlist/route';
import { POST as postEvents } from '../app/api/events/route';
import { POST as postPublishDispatch } from '../app/api/publish/dispatch/route';

test('/api/contact returns explicit not-implemented semantics', async () => {
  const response = await postContact(
    new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: { name: 'Avery', email: 'avery@example.com' },
        details: { message: 'I want to learn more about Aries.' },
      }),
    }),
  );

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    status: 'error',
    message: 'Contact submissions are not implemented in this runtime.',
    details: {
      wired: false,
      reason: 'no_n8n_contact_workflow',
      logged: true,
    },
  });
});

test('/api/waitlist returns explicit not-implemented semantics', async () => {
  const response = await postWaitlist(
    new Request('http://localhost/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: { email: 'avery@example.com' },
      }),
    }),
  );

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    status: 'error',
    message: 'Waitlist signups are not implemented in this runtime.',
    details: {
      wired: false,
      reason: 'no_n8n_waitlist_workflow',
      logged: true,
    },
  });
});

test('/api/events returns explicit not-implemented semantics', async () => {
  const response = await postEvents(
    new Request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'cta_click',
        page: '/',
        meta: { source: 'hero' },
      }),
    }),
  );

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    status: 'error',
    message: 'Event tracking is not implemented in this runtime.',
    details: {
      wired: false,
      reason: 'no_n8n_event_workflow',
      logged: true,
    },
  });
});

test('/api/publish/dispatch requires tenant_id instead of defaulting a fake tenant', async () => {
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

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    status: 'error',
    reason: 'validation_error:tenant_id',
  });
});

test('/api/publish/dispatch proxies normalized events to the n8n publish webhook', async () => {
  const previousBaseUrl = process.env.N8N_BASE_URL;
  const originalFetch = global.fetch;

  process.env.N8N_BASE_URL = 'https://n8n.example.com';
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ queued: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await postPublishDispatch(
      new Request('http://localhost/api/publish/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'tenant_123',
          provider: 'facebook',
          content: 'Ship it',
          media_urls: ['https://cdn.example.com/image.png'],
        }),
      }),
    );

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, 'https://n8n.example.com/webhook/aries/publish');
    assert.deepEqual(body, {
      status: 'accepted',
      dispatched: true,
      webhookPath: 'aries/publish',
      downstreamStatus: 202,
      event: body.event,
    });
    assert.equal(body.event.tenant_id, 'tenant_123');
    assert.equal(body.event.workflow, 'publish_dispatch');
  } finally {
    global.fetch = originalFetch;
    if (previousBaseUrl === undefined) {
      delete process.env.N8N_BASE_URL;
    } else {
      process.env.N8N_BASE_URL = previousBaseUrl;
    }
  }
});
