import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFeedbackConfig, resolveFeedbackEnvironment } from '@/lib/feedback/feedback-config';

const FULL_COMPOSIO = {
  COMPOSIO_ENABLED: 'true',
  COMPOSIO_API_KEY: 'k',
  COMPOSIO_FEEDBACK_GOOGLE_CONNECTED_ACCOUNT_ID: 'ca_google',
  FEEDBACK_GOOGLE_SHEET_ID: 'sheet_1',
  COMPOSIO_FEEDBACK_SHEETS_APPEND_ACTION: 'GOOGLESHEETS_BATCH_UPDATE',
} as unknown as NodeJS.ProcessEnv;

test('feature is enabled by default (opt-out)', () => {
  const cfg = resolveFeedbackConfig({} as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, true);
});

test('FEEDBACK_ENABLED=false disables the feature', () => {
  const cfg = resolveFeedbackConfig({ FEEDBACK_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, false);
});

test('Composio mirror is null until ALL required vars are present', () => {
  assert.equal(resolveFeedbackConfig({} as unknown as NodeJS.ProcessEnv).composio, null);

  // Missing the append action slug -> still not configured (never guessed).
  const partial = { ...FULL_COMPOSIO };
  delete (partial as Record<string, unknown>).COMPOSIO_FEEDBACK_SHEETS_APPEND_ACTION;
  assert.equal(resolveFeedbackConfig(partial).composio, null);
});

test('Composio mirror respects the COMPOSIO_ENABLED master kill-switch', () => {
  const off = { ...FULL_COMPOSIO };
  delete (off as Record<string, unknown>).COMPOSIO_ENABLED;
  assert.equal(resolveFeedbackConfig(off).composio, null);
  assert.equal(resolveFeedbackConfig({ ...FULL_COMPOSIO, COMPOSIO_ENABLED: 'false' }).composio, null);
});

test('Composio mirror resolves when fully configured', () => {
  const cfg = resolveFeedbackConfig(FULL_COMPOSIO);
  assert.ok(cfg.composio);
  assert.equal(cfg.composio?.connectedAccountId, 'ca_google');
  assert.equal(cfg.composio?.spreadsheetId, 'sheet_1');
  assert.equal(cfg.composio?.appendActionSlug, 'GOOGLESHEETS_BATCH_UPDATE');
  assert.equal(cfg.composio?.sheetTab, 'Feedback'); // default tab
});

test('sheet tab override is honored', () => {
  const cfg = resolveFeedbackConfig({ ...FULL_COMPOSIO, FEEDBACK_GOOGLE_SHEET_TAB: 'Triage' });
  assert.equal(cfg.composio?.sheetTab, 'Triage');
});

test('rate limit parses, falling back to 20 on garbage', () => {
  assert.equal(resolveFeedbackConfig({ FEEDBACK_RATE_LIMIT_PER_HOUR: '5' } as unknown as NodeJS.ProcessEnv).rateLimitPerHour, 5);
  assert.equal(resolveFeedbackConfig({ FEEDBACK_RATE_LIMIT_PER_HOUR: 'abc' } as unknown as NodeJS.ProcessEnv).rateLimitPerHour, 20);
  assert.equal(resolveFeedbackConfig({ FEEDBACK_RATE_LIMIT_PER_HOUR: '-3' } as unknown as NodeJS.ProcessEnv).rateLimitPerHour, 20);
});

test('environment label prefers explicit override, else NODE_ENV', () => {
  assert.equal(resolveFeedbackEnvironment({ FEEDBACK_ENVIRONMENT: 'production' } as unknown as NodeJS.ProcessEnv), 'production');
  assert.equal(resolveFeedbackEnvironment({ NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv), 'development');
  assert.equal(resolveFeedbackEnvironment({} as unknown as NodeJS.ProcessEnv), 'unknown');
});
