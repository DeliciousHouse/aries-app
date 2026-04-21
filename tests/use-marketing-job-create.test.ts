import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import {
  isValidWebsiteUrl,
  parseMarketingFieldErrors,
} from '../lib/api/marketing';
import { useMarketingJobCreate } from '../hooks/use-marketing-job-create';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('parseMarketingFieldErrors maps FastAPI detail[] shape to camelCase field names', () => {
  const body = {
    detail: [{ loc: ['body', 'website_url'], msg: 'Invalid URL' }],
  };
  const result = parseMarketingFieldErrors(body);
  assert.deepEqual(result, { websiteUrl: 'Invalid URL' });
});

test('parseMarketingFieldErrors handles errors[] shape', () => {
  const body = {
    errors: [
      { field: 'website_url', message: 'must be a URL' },
      { field: 'competitor_url', message: 'invalid host' },
    ],
  };
  const result = parseMarketingFieldErrors(body);
  assert.deepEqual(result, {
    websiteUrl: 'must be a URL',
    competitorUrl: 'invalid host',
  });
});

test('parseMarketingFieldErrors returns {} for unstructured bodies', () => {
  assert.deepEqual(parseMarketingFieldErrors(null), {});
  assert.deepEqual(parseMarketingFieldErrors({ error: 'oops' }), {});
  assert.deepEqual(parseMarketingFieldErrors('string'), {});
});

test('isValidWebsiteUrl blocks obviously-invalid inputs', () => {
  assert.equal(isValidWebsiteUrl('not-a-url'), false);
  assert.equal(isValidWebsiteUrl(''), false);
  assert.equal(isValidWebsiteUrl('   '), false);
  assert.equal(isValidWebsiteUrl('ftp://example.com'), false);
  assert.equal(isValidWebsiteUrl('https://example'), false);
});

test('isValidWebsiteUrl accepts simple http(s) URLs', () => {
  assert.equal(isValidWebsiteUrl('https://example.com'), true);
  assert.equal(isValidWebsiteUrl('http://example.co'), true);
  assert.equal(isValidWebsiteUrl('https://sub.example.com/path'), true);
});

test('useMarketingJobCreate surfaces 422 field errors from FastAPI detail[] body', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        detail: [{ loc: ['body', 'website_url'], msg: 'Invalid URL' }],
      }),
      { status: 422, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;

  let captured: ReturnType<typeof useMarketingJobCreate> | null = null;

  function Harness() {
    captured = useMarketingJobCreate();
    return React.createElement('div', null, 'harness');
  }

  try {
    const { act, create } = await import('react-test-renderer');
    await act(async () => {
      create(React.createElement(Harness));
      await flushMicrotasks();
    });

    await act(async () => {
      const fd = new FormData();
      fd.set('jobType', 'brand_campaign');
      fd.set('brandUrl', 'not-a-url');
      await captured!.createJob(fd);
      await flushMicrotasks();
    });

    const result = captured as ReturnType<typeof useMarketingJobCreate> | null;
    assert.ok(result, 'hook should be captured');
    assert.equal(result.isError, true);
    assert.equal(result.error?.status, 422);
    assert.deepEqual(result.fieldErrors, { websiteUrl: 'Invalid URL' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('useMarketingJobCreate keeps fieldErrors empty for non-422 errors', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'boom' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  let captured: ReturnType<typeof useMarketingJobCreate> | null = null;

  function Harness() {
    captured = useMarketingJobCreate();
    return React.createElement('div', null, 'harness');
  }

  try {
    const { act, create } = await import('react-test-renderer');
    await act(async () => {
      create(React.createElement(Harness));
      await flushMicrotasks();
    });

    await act(async () => {
      const fd = new FormData();
      fd.set('jobType', 'brand_campaign');
      await captured!.createJob(fd);
      await flushMicrotasks();
    });

    const result = captured as ReturnType<typeof useMarketingJobCreate> | null;
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.deepEqual(result.fieldErrors, {});
  } finally {
    globalThis.fetch = previousFetch;
  }
});
