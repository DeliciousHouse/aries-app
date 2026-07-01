import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdfDescription,
  buildJiraIssueFields,
  buildJiraSummary,
  feedbackLabels,
  feedbackPriorityName,
  syncFeedbackToJira,
  toLabel,
} from '@/lib/feedback/jira-sink';
import { syncFeedback } from '@/lib/feedback/feedback-sink';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';
import type { FeedbackJiraConfig } from '@/lib/feedback/feedback-config';
import type { FeedbackConfig } from '@/lib/feedback/feedback-config';
import type { FeedbackSeverity } from '@/lib/feedback/options';
import type { FeedbackSubmissionRecord } from '@/lib/feedback/types';

const TOKEN = 'super-secret-token-value';

function jiraConfig(over: Partial<FeedbackJiraConfig> = {}): FeedbackJiraConfig {
  return {
    baseUrl: 'https://sugarandleather.atlassian.net',
    email: 'brendan@sugarandleather.com',
    apiToken: TOKEN,
    projectKey: 'AA',
    issueType: 'Task',
    ...over,
  };
}

function record(over: Partial<FeedbackSubmissionRecord> = {}): FeedbackSubmissionRecord {
  return {
    submissionId: 'fb_abc123',
    tenantId: 'tenant_15',
    authState: 'authenticated',
    userId: null,
    category: 'Login issue',
    severity: 'High',
    comment: "Can't log in — the button does nothing",
    pageUrl: 'https://aries.sugarandleather.com/dashboard',
    userAgent: 'Mozilla/5.0',
    viewport: '1920x1080',
    consoleErrors: ['TypeError: x is undefined'],
    environment: 'production',
    screenshot: { bytes: Buffer.from('x'), mime: 'image/png' },
    ipHash: 'deadbeef',
    createdAtIso: '2026-06-26T00:00:00.000Z',
    ...over,
  };
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('toLabel slugifies and prefixes, dropping empties', () => {
  assert.equal(toLabel('cat', 'Login issue'), 'cat-login-issue');
  assert.equal(toLabel('sev', 'Blocker'), 'sev-blocker');
  assert.equal(toLabel('env', '  '), '');
});

test('feedbackLabels carries category/severity/env/auth, deduped', () => {
  const labels = feedbackLabels(record({ category: 'Bug', severity: 'Blocker', environment: 'production' }));
  assert.ok(labels.includes('aries-feedback'));
  assert.ok(labels.includes('cat-bug'));
  assert.ok(labels.includes('sev-blocker'));
  assert.ok(labels.includes('env-production'));
  assert.ok(labels.includes('auth-authenticated'));
  assert.equal(new Set(labels).size, labels.length); // no dupes
  // JIRA labels must not contain spaces.
  for (const l of labels) assert.ok(!/\s/.test(l), `label has space: ${l}`);
});

test('buildJiraSummary prefixes with category and bounds length to <=255', () => {
  const s = buildJiraSummary(record({ category: 'Bug', comment: 'short' }));
  assert.match(s, /^\[Feedback\] Bug — short$/);

  const long = buildJiraSummary(record({ comment: 'x'.repeat(1000) }));
  assert.ok(long.length <= 255, `summary too long: ${long.length}`);
  assert.ok(long.endsWith('…'));
});

/** Recursively assert no ADF text node has empty text (JIRA rejects those). */
function assertNoEmptyText(node: any, path = 'root') {
  if (node && typeof node === 'object') {
    if (node.type === 'text') {
      assert.equal(typeof node.text, 'string');
      assert.ok(node.text.length > 0, `empty text node at ${path}`);
    }
    for (const child of node.content ?? []) assertNoEmptyText(child, `${path}>${child?.type}`);
  }
}

test('buildAdfDescription is valid ADF with comment, metadata, and console errors', () => {
  const adf = buildAdfDescription(record(), 'https://aries.sugarandleather.com/api/feedback/screenshot/fb_abc123');
  assert.equal(adf.type, 'doc');
  assert.equal(adf.version, 1);
  assertNoEmptyText(adf);

  const json = JSON.stringify(adf);
  assert.ok(json.includes("Can't log in"), 'comment present');
  assert.ok(json.includes('codeBlock'), 'console errors in a code block');
  assert.ok(json.includes('TypeError: x is undefined'), 'console error text present');
  assert.ok(json.includes('"type":"link"'), 'page URL / screenshot rendered as link');
});

test('buildAdfDescription handles a blank comment and no console errors without empty nodes', () => {
  const adf = buildAdfDescription(
    record({ comment: '   ', consoleErrors: [], pageUrl: null, screenshot: null, userAgent: null, viewport: null }),
    null,
  );
  assertNoEmptyText(adf);
  assert.ok(!JSON.stringify(adf).includes('codeBlock'), 'no code block when no errors');
});

test('buildJiraIssueFields targets the configured project + issue type', () => {
  const fields = buildJiraIssueFields(jiraConfig(), record(), null) as any;
  assert.equal(fields.project.key, 'AA');
  assert.equal(fields.issuetype.name, 'Task');
  assert.match(fields.summary, /^\[Feedback\] Login issue — /);
  assert.equal(fields.description.type, 'doc');
  assert.ok(Array.isArray(fields.labels));
  // Priority is driven from severity — the record() default is 'High'.
  assert.equal(fields.priority.name, 'High');
});

test('buildJiraIssueFields maps each severity onto a real AA priority name', () => {
  // Names must EXACTLY match the AA project's priority scheme
  // (Highest/High/Medium/Low/Lowest); before this the sink sent no priority so
  // every issue defaulted to Medium.
  const cases: Array<[FeedbackSeverity, string]> = [
    ['Blocker', 'Highest'],
    ['High', 'High'],
    ['Medium', 'Medium'],
    ['Low', 'Low'],
  ];
  for (const [severity, priority] of cases) {
    assert.equal(feedbackPriorityName(record({ severity })), priority, `${severity} name`);
    const fields = buildJiraIssueFields(jiraConfig(), record({ severity }), null) as any;
    assert.equal(fields.priority.name, priority, `${severity} -> ${priority}`);
  }
});

test('priority is fail-open: an unmapped severity omits the field (JIRA default applies)', () => {
  // Guards the "never fail issue creation on a priority the scheme lacks"
  // contract — an unknown severity must drop the field, not send a bad name.
  const rogue = record({ severity: 'Nope' as FeedbackSeverity });
  assert.equal(feedbackPriorityName(rogue), null);
  const fields = buildJiraIssueFields(jiraConfig(), rogue, null) as any;
  assert.equal('priority' in fields, false);
});

// ── network behavior (fake fetch) ───────────────────────────────────────────

function fakeFetch(impl: (url: string, init: RequestInit) => { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = impl(url, init);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('syncFeedbackToJira posts to /rest/api/3/issue with Basic auth and returns the issue key', async () => {
  const { fn, calls } = fakeFetch(() => ({ ok: true, status: 201, body: { id: '1', key: 'AA-42' } }));
  const result = await syncFeedbackToJira(record(), jiraConfig(), 'https://aries.sugarandleather.com', fn);

  assert.equal(result.status, 'synced');
  assert.equal(result.destination, 'jira');
  assert.equal(result.issueKey, 'AA-42');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sugarandleather.atlassian.net/rest/api/3/issue');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^Basic /);
  // The raw token must never appear in plaintext (it's base64 inside the header).
  assert.ok(!headers.Authorization.includes(TOKEN));
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.fields.project.key, 'AA');
  // The classified severity ('High') rides the wire as a JIRA priority name.
  assert.equal(sent.fields.priority.name, 'High');
});

test('syncFeedbackToJira reports failure on non-2xx WITHOUT leaking the token', async () => {
  const { fn } = fakeFetch(() => ({
    ok: false,
    status: 400,
    body: { errorMessages: [], errors: { summary: 'Field required' } },
  }));
  const result = await syncFeedbackToJira(record(), jiraConfig(), null, fn);

  assert.equal(result.status, 'failed');
  assert.equal(result.issueKey, null);
  assert.match(result.error ?? '', /HTTP 400/);
  assert.match(result.error ?? '', /summary: Field required/);
  assert.ok(!(result.error ?? '').includes(TOKEN), 'error must not contain the token');
});

// ── dispatcher precedence ───────────────────────────────────────────────────

function baseConfig(over: Partial<FeedbackConfig> = {}): FeedbackConfig {
  return {
    enabled: true,
    environment: 'production',
    appBaseUrl: 'https://aries.sugarandleather.com',
    rateLimitPerHour: 20,
    composio: null,
    jira: null,
    severityLlm: null,
    ...over,
  };
}

test('syncFeedback prefers JIRA when configured', async () => {
  const { fn, calls } = fakeFetch(() => ({ ok: true, status: 201, body: { key: 'AA-7' } }));
  const result = await syncFeedback(record(), baseConfig({ jira: jiraConfig() }), { fetchImpl: fn });
  assert.equal(result.destination, 'jira');
  assert.equal(result.issueKey, 'AA-7');
  assert.equal(calls.length, 1);
});

test('syncFeedback skips (durable-DB-only) when neither JIRA nor Sheet is configured', async () => {
  const result = await syncFeedback(record(), baseConfig());
  assert.equal(result.status, 'skipped');
  assert.equal(result.destination, 'none');
});

// ── config resolution ───────────────────────────────────────────────────────

test('resolveFeedbackConfig builds jira only when all four vars are set', () => {
  assert.equal(resolveFeedbackConfig({} as unknown as NodeJS.ProcessEnv).jira, null);
  // Missing project key -> not configured.
  assert.equal(
    resolveFeedbackConfig({
      JIRA_BASE_URL: 'https://x.atlassian.net',
      JIRA_EMAIL: 'a@b.com',
      JIRA_API_TOKEN: 't',
    } as unknown as NodeJS.ProcessEnv).jira,
    null,
  );
  const cfg = resolveFeedbackConfig({
    JIRA_BASE_URL: 'https://x.atlassian.net/',
    JIRA_EMAIL: 'a@b.com',
    JIRA_API_TOKEN: 't',
    JIRA_PROJECT_KEY: 'AA',
  } as unknown as NodeJS.ProcessEnv);
  assert.ok(cfg.jira);
  assert.equal(cfg.jira?.baseUrl, 'https://x.atlassian.net'); // trailing slash trimmed
  assert.equal(cfg.jira?.issueType, 'Task'); // default
  assert.equal(cfg.jira?.projectKey, 'AA');
});
