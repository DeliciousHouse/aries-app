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
      reason: 'no_contact_workflow',
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
      reason: 'no_waitlist_workflow',
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
      reason: 'no_event_workflow',
      logged: true,
    },
  });
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
