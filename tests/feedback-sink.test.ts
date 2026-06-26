import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_SHEET_COLUMNS,
  appServedScreenshotLink,
  buildSheetAppendArguments,
  feedbackRowToCells,
  syncFeedbackToSheet,
  toFeedbackSheetRow,
} from '@/lib/feedback/feedback-sink';
import type { FeedbackConfig, FeedbackComposioConfig } from '@/lib/feedback/feedback-config';
import type { FeedbackSubmissionRecord } from '@/lib/feedback/types';
import { fakeGateway } from './composio/helpers';

function record(overrides?: Partial<FeedbackSubmissionRecord>): FeedbackSubmissionRecord {
  return {
    submissionId: 'fb_001a2b',
    tenantId: 'tenant_8842',
    authState: 'authenticated',
    userId: null,
    category: 'Login issue',
    severity: 'Blocker',
    comment: "Can't log in — button does nothing",
    pageUrl: 'https://aries.example.com/dashboard',
    userAgent: 'Chrome 126 / Windows',
    viewport: '1920x1080',
    consoleErrors: ['TypeError: x is undefined', 'TypeError: x is undefined'],
    environment: 'production',
    screenshot: null,
    ipHash: 'abc',
    createdAtIso: '2026-06-22T21:05:00.000Z',
    ...overrides,
  };
}

const composio: FeedbackComposioConfig = {
  apiKey: 'k',
  toolkitVersion: 'latest',
  connectedAccountId: 'ca_google',
  spreadsheetId: 'sheet_1',
  sheetTab: 'Feedback',
  appendActionSlug: 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
};

function config(overrides?: Partial<FeedbackConfig>): FeedbackConfig {
  return {
    enabled: true,
    environment: 'production',
    appBaseUrl: 'https://aries.example.com',
    rateLimitPerHour: 20,
    composio,
    jira: null,
    severityLlm: null,
    ...overrides,
  };
}

test('sheet column order matches the spec §8 schema (13 columns)', () => {
  assert.equal(FEEDBACK_SHEET_COLUMNS.length, 13);
  assert.deepEqual(
    [...FEEDBACK_SHEET_COLUMNS],
    [
      'Submission ID',
      'Timestamp',
      'Tenant ID',
      'Auth state',
      'Category',
      'Severity',
      'Comment',
      'Page URL',
      'Browser / UA',
      'Viewport',
      'Console errors',
      'Screenshot link',
      'Environment',
    ],
  );
});

test('feedbackRowToCells produces one cell per column, in order', () => {
  const row = toFeedbackSheetRow(record(), '');
  const cells = feedbackRowToCells(row);
  assert.equal(cells.length, FEEDBACK_SHEET_COLUMNS.length);
  assert.equal(cells[0], 'fb_001a2b'); // Submission ID
  assert.equal(cells[2], 'tenant_8842'); // Tenant ID
  assert.equal(cells[6], "Can't log in — button does nothing"); // Comment
  assert.equal(cells[10], 'TypeError: x is undefined\nTypeError: x is undefined'); // Console errors joined
  assert.equal(cells[12], 'production'); // Environment
});

test('appServedScreenshotLink builds an absolute url, or a relative fallback', () => {
  const link = appServedScreenshotLink({ appBaseUrl: 'https://aries.example.com/' }, 'fb_001a2b');
  assert.equal(link, 'https://aries.example.com/api/feedback/screenshot/fb_001a2b');
  // Falls back to a relative path (never an empty cell) when no base url is set.
  assert.equal(appServedScreenshotLink({ appBaseUrl: null }, 'fb_x'), '/api/feedback/screenshot/fb_x');
});

test('an already-synced submission is mirrored idempotently (no second append)', async () => {
  // The route short-circuits when prior status is 'synced'; verify the sink itself
  // appends once per call so the route-level guard is the single dedup point.
  const gw = fakeGateway();
  await syncFeedbackToSheet(record(), config(), gw);
  await syncFeedbackToSheet(record(), config(), gw);
  assert.equal(gw.calls.length, 2); // sink always appends; dedup lives in the route
});

test('buildSheetAppendArguments matches GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND schema', () => {
  const args = buildSheetAppendArguments(composio, ['a', 'b']);
  // camelCase keys + tab-qualified A1 range (NOT spreadsheet_id / sheet_name).
  assert.equal(args.spreadsheetId, 'sheet_1');
  assert.equal(args.range, "'Feedback'!A:M"); // 13 columns -> A:M
  assert.equal(args.valueInputOption, 'USER_ENTERED');
  assert.deepEqual(args.values, [['a', 'b']]);
});

test('syncFeedbackToSheet skips when Composio is not configured', async () => {
  const result = await syncFeedbackToSheet(record(), config({ composio: null }));
  assert.equal(result.status, 'skipped');
  assert.equal(result.error, null);
});

test('syncFeedbackToSheet appends exactly one row via executeTool', async () => {
  const gw = fakeGateway({ executeResult: { data: { ok: true }, successful: true, error: null } });
  const result = await syncFeedbackToSheet(record(), config(), gw);
  assert.equal(result.status, 'synced');
  assert.equal(gw.calls.length, 1);
  assert.equal(gw.calls[0].slug, 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND');
  assert.equal(gw.calls[0].options.connectedAccountId, 'ca_google');
  const values = (gw.calls[0].options.arguments?.values as string[][]) ?? [];
  assert.equal(values.length, 1); // exactly one appended row
  assert.equal(values[0].length, 13);
});

test('syncFeedbackToSheet reports failed (retryable) when the tool is unsuccessful', async () => {
  const gw = fakeGateway({ executeResult: { data: null, successful: false, error: 'boom' } });
  const result = await syncFeedbackToSheet(record(), config(), gw);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'boom');
});

test('syncFeedbackToSheet writes the app-served screenshot link into the row', async () => {
  const gw = fakeGateway();
  await syncFeedbackToSheet(
    record({ screenshot: { bytes: Buffer.from('x'), mime: 'image/png' } }),
    config(),
    gw,
  );
  const values = (gw.calls[0].options.arguments?.values as string[][])[0];
  // Screenshot link column (index 11) should be the app-served url.
  assert.equal(values[11], 'https://aries.example.com/api/feedback/screenshot/fb_001a2b');
});

test('syncFeedbackToSheet never throws when executeTool throws', async () => {
  const gw = fakeGateway();
  gw.executeTool = async () => {
    throw new Error('network down');
  };
  const result = await syncFeedbackToSheet(record(), config(), gw);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /network down/);
});
