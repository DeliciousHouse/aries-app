import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReportRequest } from '../backend/feedback/report-validation';
import { resolveFeedbackReportConfig } from '../backend/feedback/report-config';

const IDEMPOTENCY_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('a valid body validates with trimmed fields and default category', () => {
  const result = validateReportRequest({
    idempotency_key: IDEMPOTENCY_KEY,
    impact: 'p2_feature_degraded',
    title: '  Broken publish button  ',
    description: '  It does nothing.  ',
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.value.idempotencyKey, IDEMPOTENCY_KEY);
    assert.equal(result.value.category, 'bug');
    assert.equal(result.value.title, 'Broken publish button');
    assert.equal(result.value.description, 'It does nothing.');
    assert.equal(result.value.screenshot, null);
  }
});

test('impact is required with no default; invalid values are 422 field errors', () => {
  for (const impact of [undefined, null, '', 'p5_whatever', 42]) {
    const result = validateReportRequest({ impact, title: 't', description: 'd' });
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.fieldErrors.impact);
  }
});

test('title and description boundaries mirror the client rules', () => {
  const ok = validateReportRequest({
    idempotency_key: IDEMPOTENCY_KEY,
    impact: 'p4_question',
    title: 'x'.repeat(255),
    description: 'y'.repeat(10_000),
  });
  assert.ok(ok.ok);

  const overTitle = validateReportRequest({
    impact: 'p4_question',
    title: 'x'.repeat(256),
    description: 'd',
  });
  assert.ok(!overTitle.ok && overTitle.fieldErrors.title);

  const overDesc = validateReportRequest({
    impact: 'p4_question',
    title: 't',
    description: 'y'.repeat(10_001),
  });
  assert.ok(!overDesc.ok && overDesc.fieldErrors.description);

  const empty = validateReportRequest({ impact: 'p4_question', title: '   ', description: '' });
  assert.ok(!empty.ok && empty.fieldErrors.title && empty.fieldErrors.description);
});

test('invalid category is rejected; absent category defaults to bug', () => {
  const bad = validateReportRequest({
    impact: 'p4_question',
    category: 'Bug', // legacy capitalized vocabulary is NOT the v2 enum
    title: 't',
    description: 'd',
  });
  assert.ok(!bad.ok && bad.fieldErrors.category);

  const question = validateReportRequest({
    idempotency_key: IDEMPOTENCY_KEY,
    impact: 'p4_question',
    category: 'question',
    title: 't',
    description: 'd',
  });
  assert.ok(question.ok && question.ok && question.value.category === 'question');
});

test('INVARIANT: body-supplied identity/tenant/priority fields are ignored entirely', () => {
  const spoof = validateReportRequest({
    idempotency_key: IDEMPOTENCY_KEY,
    impact: 'p0_system_blocked',
    title: 't',
    description: 'd',
    // Every field an attacker might smuggle:
    submitter_id: 'victim-user',
    submitterId: 'victim-user',
    submitter_email: 'victim@example.com',
    tenant_id: 'other-tenant',
    tenantId: 'other-tenant',
    tenantSlug: 'other-co',
    customer_slug: 'other-co',
    priority: 'P0 - Crit Sit',
    labels: ['customer-other'],
    jira_ticket_key: 'AA-999',
    status: 'synced',
  });
  assert.ok(spoof.ok);
  if (spoof.ok) {
    const keys = Object.keys(spoof.value).sort();
    assert.deepEqual(keys, [
      'category',
      'description',
      'idempotencyKey',
      'impact',
      'screenshot',
      'title',
    ]);
    const serialized = JSON.stringify(spoof.value);
    assert.ok(!serialized.includes('victim'));
    assert.ok(!serialized.includes('other-tenant'));
    assert.ok(!serialized.includes('AA-999'));
  }
});

test('a canonical client idempotency UUID is required and validated', () => {
  for (const idempotency_key of [undefined, null, '', 'not-a-uuid', `${IDEMPOTENCY_KEY}x`]) {
    const result = validateReportRequest({
      idempotency_key,
      impact: 'p4_question',
      title: 't',
      description: 'd',
    });
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.fieldErrors.idempotency_key);
  }
});

test('config is dark by default: no JIRA_* env ⇒ jira null, knobs at plan defaults', () => {
  const config = resolveFeedbackReportConfig({} as unknown as NodeJS.ProcessEnv);
  assert.equal(config.jira, null);
  assert.equal(config.maxImageBytes, 2_000_000);
  assert.equal(config.userRateLimitPerHour, 10);
  assert.equal(config.sharedRateLimitPerHour, 100);
  assert.equal(config.dedupWindowSeconds, 60);
  assert.equal(config.retryIntervalMinutes, 5);
  assert.equal(config.retryBatchLimit, 10);
  assert.equal(config.retryMaxAttempts, 5);
  assert.equal(config.stalePendingMinutes, 15);
});

test('config: JIRA_ISSUE_TOKEN is accepted as the token alias; issue type defaults to Bug', () => {
  const env = {
    JIRA_BASE_URL: 'https://example.atlassian.net/',
    JIRA_EMAIL: 'bot@example.com',
    JIRA_ISSUE_TOKEN: 'alias-token',
    JIRA_PROJECT_KEY: 'AA',
  } as unknown as NodeJS.ProcessEnv;
  const config = resolveFeedbackReportConfig(env);
  assert.ok(config.jira);
  assert.equal(config.jira?.apiToken, 'alias-token');
  assert.equal(config.jira?.baseUrl, 'https://example.atlassian.net');
  assert.equal(config.jira?.issueType, 'Bug');

  const primary = resolveFeedbackReportConfig({
    ...env,
    JIRA_API_TOKEN: 'primary-token',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(primary.jira?.apiToken, 'primary-token');
});

test('config: a partial JIRA_* set stays unconfigured (never invent a piece)', () => {
  const config = resolveFeedbackReportConfig({
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_EMAIL: 'bot@example.com',
    // token + project key missing
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.jira, null);
});

test('config: garbage knob values fall back to defaults', () => {
  const config = resolveFeedbackReportConfig({
    FEEDBACK_MAX_IMAGE_BYTES: 'garbage',
    FEEDBACK_USER_RATE_LIMIT_PER_HOUR: '-5',
    FEEDBACK_SHARED_RATE_LIMIT_PER_HOUR: 'not-a-limit',
    FEEDBACK_RETRY_MAX_ATTEMPTS: '0',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.maxImageBytes, 2_000_000);
  assert.equal(config.userRateLimitPerHour, 10);
  assert.equal(config.sharedRateLimitPerHour, 100);
  assert.equal(config.retryMaxAttempts, 5);
});

test('config: shared durable endpoint/tenant ceiling is configurable', () => {
  const config = resolveFeedbackReportConfig({
    FEEDBACK_SHARED_RATE_LIMIT_PER_HOUR: '37',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.sharedRateLimitPerHour, 37);
});
