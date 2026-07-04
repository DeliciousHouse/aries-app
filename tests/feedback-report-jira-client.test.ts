import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JiraReportError,
  createJiraReportClient,
  scrubJiraSecrets,
} from '../backend/feedback/jira-report-client';
import type { FeedbackReportJiraConfig } from '../backend/feedback/report-config';

const TOKEN = 'ATATT3xFfGF0SECRETSECRETSECRETSECRETSECRETSECRET';
const CONFIG: FeedbackReportJiraConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'bot@example.com',
  apiToken: TOKEN,
  projectKey: 'AA',
  issueType: 'Bug',
};
const BASIC = Buffer.from(`${CONFIG.email}:${TOKEN}`).toString('base64');

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('token and basic credential never appear in errors, even when the response echoes them', async () => {
  const { fetchImpl } = fakeFetch(() =>
    json(500, { errorMessages: [`upstream saw Authorization: Basic ${BASIC} raw=${TOKEN}`] }),
  );
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.createIssue({ fields: {} }),
    (error: unknown) => {
      assert.ok(error instanceof JiraReportError);
      const everything = `${String(error)} ${error.message} ${JSON.stringify({ ...error })}`;
      assert.ok(!everything.includes(TOKEN), 'raw token leaked');
      assert.ok(!everything.includes(BASIC), 'basic credential leaked');
      assert.ok(everything.includes('[REDACTED]'));
      return true;
    },
  );
});

test('scrubbing happens BEFORE truncation — a token straddling the clip boundary leaves no prefix', async () => {
  // 390 filler chars put the token right across the 400-char clip boundary.
  const detail = 'x'.repeat(390) + TOKEN + 'tail';
  const { fetchImpl } = fakeFetch(() => json(500, { errorMessages: [detail] }));
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.createIssue({ fields: {} }),
    (error: unknown) => {
      assert.ok(error instanceof JiraReportError);
      // Truncate-first would leave the first ~10 chars of the token visible.
      assert.ok(!error.message.includes(TOKEN.slice(0, 8)), 'token prefix leaked past the clip');
      return true;
    },
  );
});

test('scrubJiraSecrets replaces every occurrence of both secret forms', () => {
  const scrubbed = scrubJiraSecrets(`a ${TOKEN} b ${BASIC} c ${TOKEN}`, CONFIG);
  assert.ok(!scrubbed.includes(TOKEN));
  assert.ok(!scrubbed.includes(BASIC));
  assert.equal(scrubbed.match(/\[REDACTED\]/g)?.length, 3);
});

test('transport errors are rethrown as JiraReportError with no cause and scrubbed text', async () => {
  const original = new TypeError(`fetch failed connecting with ${TOKEN}`);
  const { fetchImpl } = fakeFetch(() => {
    throw original;
  });
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.createIssue({ fields: {} }),
    (error: unknown) => {
      assert.ok(error instanceof JiraReportError);
      assert.equal((error as Error).cause, undefined, 'auth-bearing original must not chain');
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test('an aborted request maps to a timeout message', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const { fetchImpl } = fakeFetch(() => {
    throw abort;
  });
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.searchIssueKeyByLabel('aries-sub-x'),
    (error: unknown) => error instanceof JiraReportError && /timed out/.test(error.message),
  );
});

test('JQL injection guard: unsafe labels are rejected with ZERO HTTP calls', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(200, { issues: [] }));
  const client = createJiraReportClient(CONFIG, fetchImpl);
  for (const evil of [
    'aries-sub-x" OR reporter=currentUser() OR labels="y',
    'UPPER-not-allowed',
    'space label',
    '',
  ]) {
    await assert.rejects(
      () => client.searchIssueKeyByLabel(evil),
      (error: unknown) => error instanceof JiraReportError,
    );
  }
  assert.equal(calls.length, 0, 'no HTTP request may be issued for a rejected label');
});

test('search uses GET /rest/api/3/search/jql and returns the first key or null', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(200, { issues: [{ key: 'AA-42' }] }));
  const client = createJiraReportClient(CONFIG, fetchImpl);
  const key = await client.searchIssueKeyByLabel('aries-sub-abc-123');
  assert.equal(key, 'AA-42');
  assert.ok(calls[0].url.startsWith('https://example.atlassian.net/rest/api/3/search/jql?'));
  assert.ok(calls[0].url.includes(encodeURIComponent('labels = "aries-sub-abc-123"')));
  assert.equal(calls[0].init.method, 'GET');

  const { fetchImpl: emptyFetch } = fakeFetch(() => json(200, { issues: [] }));
  const emptyClient = createJiraReportClient(CONFIG, emptyFetch);
  assert.equal(await emptyClient.searchIssueKeyByLabel('aries-sub-abc-123'), null);
});

test('a search hit with a malformed key is a typed error, not a poisoned path segment', async () => {
  const { fetchImpl } = fakeFetch(() => json(200, { issues: [{ key: '../../etc' }] }));
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.searchIssueKeyByLabel('aries-sub-abc'),
    (error: unknown) => error instanceof JiraReportError,
  );
});

test('non-JSON 2xx bodies wrap into the same typed error', async () => {
  const { fetchImpl } = fakeFetch(
    () => new Response('<html>proxy says hi</html>', { status: 200 }),
  );
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await assert.rejects(
    () => client.createIssue({ fields: {} }),
    (error: unknown) => error instanceof JiraReportError && /non-JSON/.test(error.message),
  );
});

test('create posts to /rest/api/3/issue with basic auth and returns a validated key', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(201, { key: 'AA-7' }));
  const client = createJiraReportClient(CONFIG, fetchImpl);
  const key = await client.createIssue({ fields: { summary: 's' } });
  assert.equal(key, 'AA-7');
  assert.equal(calls[0].url, 'https://example.atlassian.net/rest/api/3/issue');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${BASIC}`);

  const { fetchImpl: badKeyFetch } = fakeFetch(() => json(201, { key: 'not a key' }));
  await assert.rejects(
    () => createJiraReportClient(CONFIG, badKeyFetch).createIssue({ fields: {} }),
    (error: unknown) => error instanceof JiraReportError,
  );
});

test('attach validates the issue key, sends no-check token + multipart form', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(200, [{ id: '1' }]));
  const client = createJiraReportClient(CONFIG, fetchImpl);
  await client.attachScreenshot('AA-7', Buffer.from('png-bytes'), 'image/png', 'shot.png');
  assert.equal(calls[0].url, 'https://example.atlassian.net/rest/api/3/issue/AA-7/attachments');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Atlassian-Token'], 'no-check');
  assert.ok(calls[0].init.body instanceof FormData);
  const file = (calls[0].init.body as FormData).get('file');
  assert.ok(file instanceof Blob);
  assert.equal((file as File).name, 'shot.png');

  const { fetchImpl: guard, calls: guardCalls } = fakeFetch(() => json(200, []));
  await assert.rejects(
    () =>
      createJiraReportClient(CONFIG, guard).attachScreenshot(
        'AA-7/../secrets',
        Buffer.from('x'),
        'image/png',
        'f.png',
      ),
    (error: unknown) => error instanceof JiraReportError,
  );
  assert.equal(guardCalls.length, 0, 'unsafe key must never reach the wire');
});
