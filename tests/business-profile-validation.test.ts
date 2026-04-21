import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  hasValidationErrors,
  isValidBusinessName,
  isValidWebsiteUrl,
  validateBusinessProfileForm,
} from '../lib/validation/business-profile';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('isValidWebsiteUrl rejects malformed input that used to be auto-prepended', () => {
  assert.equal(isValidWebsiteUrl('not-a-url'), false);
  assert.equal(isValidWebsiteUrl(''), false);
  assert.equal(isValidWebsiteUrl('   '), false);
  assert.equal(isValidWebsiteUrl('nike'), false);
  assert.equal(isValidWebsiteUrl('nike.com'), false, 'missing scheme must be rejected');
  assert.equal(isValidWebsiteUrl('https://nike'), false, 'host without dot must be rejected');
  assert.equal(isValidWebsiteUrl('ftp://nike.com'), false, 'non-http scheme must be rejected');
});

test('isValidWebsiteUrl accepts full http(s) URLs', () => {
  assert.equal(isValidWebsiteUrl('https://nike.com'), true);
  assert.equal(isValidWebsiteUrl('http://example.co.uk/path?x=1'), true);
  assert.equal(isValidWebsiteUrl('https://sub.domain.io'), true);
});

test('isValidBusinessName rejects empty / whitespace-only', () => {
  assert.equal(isValidBusinessName(''), false);
  assert.equal(isValidBusinessName('   '), false);
  assert.equal(isValidBusinessName('Nike'), true);
});

test('validateBusinessProfileForm reports both fields when invalid', () => {
  const errors = validateBusinessProfileForm({ businessName: '', websiteUrl: 'not-a-url' });
  assert.ok(errors.businessName);
  assert.ok(errors.websiteUrl);
  assert.equal(hasValidationErrors(errors), true);
});

test('validateBusinessProfileForm returns no errors for valid input', () => {
  const errors = validateBusinessProfileForm({
    businessName: 'Nike',
    websiteUrl: 'https://nike.com',
  });
  assert.deepEqual(errors, {});
  assert.equal(hasValidationErrors(errors), false);
});

test('business profile screen wires validation + save feedback', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'business-profile-screen.tsx'),
    'utf8',
  );
  assert.ok(
    source.includes('validateBusinessProfileForm'),
    'screen must import validation helper',
  );
  assert.ok(
    source.includes('Business profile saved'),
    'screen must show success feedback copy',
  );
  assert.ok(
    source.includes('Failed to save business profile'),
    'screen must show failure feedback copy',
  );
  assert.ok(
    /disabled=\{[^}]*(isInvalid|hasErrors|fieldErrors)/.test(source) ||
      source.includes('disabled={business.save.isLoading || hasErrors'),
    'Save button must be disabled when validation errors exist',
  );
});

test('mocked save flow surfaces success and 422 error states', async () => {
  // This is a lightweight unit test of the feedback contract that the screen
  // relies on: `business.save` is a useAsyncAction that sets error on failure
  // and data on success. We simulate that contract without rendering React.
  type SaveResult = { ok: boolean; message?: string };
  async function runSave(
    fetcher: () => Promise<Response>,
  ): Promise<{ success: boolean; error: string | null }> {
    try {
      const response = await fetcher();
      if (!response.ok) {
        let message = 'Failed to save business profile.';
        try {
          const body = (await response.json()) as { error?: string; message?: string };
          message = body.error || body.message || message;
        } catch {
          // non-JSON body; keep fallback
        }
        return { success: false, error: message };
      }
      return { success: true, error: null };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save business profile.',
      };
    }
  }

  const ok = await runSave(
    async () => new Response(JSON.stringify({ profile: {} }), { status: 200 }),
  );
  assert.deepEqual(ok, { success: true, error: null });

  const unprocessable = await runSave(
    async () =>
      new Response(JSON.stringify({ error: 'Business name required' }), { status: 422 }),
  );
  assert.equal(unprocessable.success, false);
  assert.equal(unprocessable.error, 'Business name required');

  const genericFail = await runSave(
    async () => new Response('nope', { status: 500 }),
  );
  assert.equal(genericFail.success, false);
  assert.equal(genericFail.error, 'Failed to save business profile.');

  // suppress unused warning in case helpers file evolves
  void ({} as SaveResult);
});
