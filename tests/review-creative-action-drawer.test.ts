import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUploadReplaceFormData,
  canShowCreativeActionDrawer,
  creativeActionSafeErrorMessage,
  readQaPayload,
  regenerateCreativeUrl,
  uploadReplaceCreativeUrl,
} from '../frontend/aries-v1/creative-action-drawer';

const DRAWER_FALLBACK = 'That action could not complete right now.';

test('canShowCreativeActionDrawer: image creative with assetId is allowed', () => {
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'image/png',
      assetId: 'creative-1',
    }),
    true,
  );
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'image/jpeg',
      assetId: 'creative-2',
    }),
    true,
  );
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'IMAGE/WEBP',
      assetId: 'creative-3',
    }),
    true,
  );
});

test('canShowCreativeActionDrawer: video creative is rejected', () => {
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'video/mp4',
      assetId: 'creative-1',
    }),
    false,
  );
});

test('canShowCreativeActionDrawer: pdf and html attachments are rejected', () => {
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'application/pdf',
      assetId: 'creative-1',
    }),
    false,
  );
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'text/html',
      assetId: 'creative-1',
    }),
    false,
  );
});

test('canShowCreativeActionDrawer: null contentType is rejected', () => {
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: null,
      assetId: 'creative-1',
    }),
    false,
  );
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      assetId: 'creative-1',
    }),
    false,
  );
});

test('canShowCreativeActionDrawer: missing assetId is rejected even for image content', () => {
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'image/png',
      assetId: '',
    }),
    false,
  );
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'image/png',
      assetId: '   ',
    }),
    false,
  );
  assert.equal(
    canShowCreativeActionDrawer({
      reviewType: 'creative',
      contentType: 'image/png',
      assetId: null,
    }),
    false,
  );
});

test('canShowCreativeActionDrawer: non-creative reviewTypes are rejected', () => {
  for (const reviewType of ['brand', 'strategy', 'workflow_approval', 'other'] as const) {
    assert.equal(
      canShowCreativeActionDrawer({
        reviewType,
        contentType: 'image/png',
        assetId: 'creative-1',
      }),
      false,
      `expected ${reviewType} to be rejected`,
    );
  }
});

test('canShowCreativeActionDrawer: null/undefined input is rejected', () => {
  assert.equal(canShowCreativeActionDrawer(null), false);
  assert.equal(canShowCreativeActionDrawer(undefined), false);
});

test('regenerateCreativeUrl matches T14 path contract', () => {
  assert.equal(
    regenerateCreativeUrl('mkt_job_1', 'creative-42'),
    '/api/social-content/jobs/mkt_job_1/creatives/creative-42/regenerate',
  );
  assert.equal(
    regenerateCreativeUrl('job with space', 'crv/with/slash'),
    '/api/social-content/jobs/job%20with%20space/creatives/crv%2Fwith%2Fslash/regenerate',
  );
});

test('uploadReplaceCreativeUrl matches T15 path contract', () => {
  assert.equal(
    uploadReplaceCreativeUrl('mkt_job_2', 'creative-99'),
    '/api/social-content/jobs/mkt_job_2/creatives/creative-99/upload-replace',
  );
});

test('buildUploadReplaceFormData: clean upload omits override flags', () => {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clean.png', {
    type: 'image/png',
  });
  const formData = buildUploadReplaceFormData(file);
  const imageEntry = formData.get('image');
  assert.ok(imageEntry instanceof File, 'image entry should be a File');
  assert.equal((imageEntry as File).name, 'clean.png');
  assert.equal((imageEntry as File).type, 'image/png');
  assert.equal(formData.get('operator_override'), null);
  assert.equal(formData.get('tos_acknowledged'), null);
});

test('buildUploadReplaceFormData: override upload sends both required flags as "true"', () => {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'override.png', {
    type: 'image/png',
  });
  const formData = buildUploadReplaceFormData(file, {
    operatorOverride: true,
    tosAcknowledged: true,
  });
  assert.equal(formData.get('operator_override'), 'true');
  assert.equal(formData.get('tos_acknowledged'), 'true');
  const imageEntry = formData.get('image');
  assert.ok(imageEntry instanceof File);
});

test('readQaPayload: parses verdict, scores, and reasons from upload response body', () => {
  const qa = readQaPayload({
    qa: {
      verdict: 'pass',
      attempt_number: 2,
      reasons: ['brand_color_mismatch'],
      scores: {
        brand_color_match: 0.91,
        text_legibility: 0.86,
        brand_violation: 0.04,
        forbidden_pattern_hits: 0,
      },
    },
  });
  assert.ok(qa);
  assert.equal(qa.verdict, 'pass');
  assert.equal(qa.attempt_number, 2);
  assert.deepEqual(qa.reasons, ['brand_color_mismatch']);
  assert.equal(qa.scores.brand_color_match, 0.91);
  assert.equal(qa.scores.text_legibility, 0.86);
  assert.equal(qa.scores.brand_violation, 0.04);
  assert.equal(qa.scores.forbidden_pattern_hits, 0);
});

test('readQaPayload: returns null when qa block is missing or malformed', () => {
  assert.equal(readQaPayload({}), null);
  assert.equal(readQaPayload({ qa: null }), null);
  assert.equal(readQaPayload({ qa: 'invalid' }), null);
  assert.equal(readQaPayload({ qa: { verdict: 'pass' } }), null);
  assert.equal(readQaPayload(null), null);
  assert.equal(readQaPayload(undefined), null);
});

test('readQaPayload: defaults non-numeric scores to 0 and clamps attempt_number', () => {
  const qa = readQaPayload({
    qa: {
      verdict: 'fail',
      reasons: 'not-an-array',
      scores: {
        brand_color_match: 'oops',
        text_legibility: NaN,
        brand_violation: null,
        forbidden_pattern_hits: 3,
      },
    },
  });
  assert.ok(qa);
  assert.equal(qa.scores.brand_color_match, 0);
  assert.equal(qa.scores.text_legibility, 0);
  assert.equal(qa.scores.brand_violation, 0);
  assert.equal(qa.scores.forbidden_pattern_hits, 3);
  assert.deepEqual(qa.reasons, []);
  assert.equal(qa.attempt_number, 1);
});

test('creativeActionSafeErrorMessage: blocks raw provider/internal codes that previously slipped through', () => {
  const leakyCodes = [
    'hermes_regenerate_run_failed',
    'hermes_run_submission_failed',
    'storage_failure',
    'storage_write_failed',
    'provider_timeout',
    'provider_unavailable',
    'internal_error',
    'database_unavailable',
    'db_constraint_violation',
    'aries_run_failed',
    'workflow_state_invalid',
    'gateway_timeout',
    'upstream_failure',
    'unexpected_failure',
    'something_unauthorized',
  ];
  for (const code of leakyCodes) {
    assert.equal(
      creativeActionSafeErrorMessage(code, DRAWER_FALLBACK),
      DRAWER_FALLBACK,
      `expected raw code "${code}" to be redacted to fallback`,
    );
  }
});

test('creativeActionSafeErrorMessage: returns fallback for empty / null / whitespace input', () => {
  assert.equal(creativeActionSafeErrorMessage(null, DRAWER_FALLBACK), DRAWER_FALLBACK);
  assert.equal(creativeActionSafeErrorMessage(undefined, DRAWER_FALLBACK), DRAWER_FALLBACK);
  assert.equal(creativeActionSafeErrorMessage('', DRAWER_FALLBACK), DRAWER_FALLBACK);
  assert.equal(creativeActionSafeErrorMessage('   ', DRAWER_FALLBACK), DRAWER_FALLBACK);
});

test('creativeActionSafeErrorMessage: curated codes return curated user-facing copy', () => {
  assert.equal(
    creativeActionSafeErrorMessage('unsupported_mime_type', DRAWER_FALLBACK),
    'That file type is not supported. Use PNG, JPEG, or WebP.',
  );
  assert.equal(
    creativeActionSafeErrorMessage('UNSUPPORTED_MIME_TYPE', DRAWER_FALLBACK),
    'That file type is not supported. Use PNG, JPEG, or WebP.',
  );
  assert.equal(
    creativeActionSafeErrorMessage('file_too_large', DRAWER_FALLBACK),
    'That file is too large. The maximum size is 8 MB.',
  );
  assert.equal(
    creativeActionSafeErrorMessage('missing_file', DRAWER_FALLBACK),
    'No file was selected. Choose an image to upload.',
  );
  assert.equal(
    creativeActionSafeErrorMessage('override_requires_tos_acknowledgement', DRAWER_FALLBACK),
    'Confirm the ToS checkbox before overriding.',
  );
  assert.equal(
    creativeActionSafeErrorMessage('creative_not_found', DRAWER_FALLBACK),
    'This creative is no longer available.',
  );
  assert.equal(
    creativeActionSafeErrorMessage('social_content_job_not_found', DRAWER_FALLBACK),
    'This post is no longer available in this workspace.',
  );
});

test('creativeActionSafeErrorMessage: any unknown snake_case identifier defaults to fallback', () => {
  assert.equal(
    creativeActionSafeErrorMessage('foo_bar_baz', DRAWER_FALLBACK),
    DRAWER_FALLBACK,
  );
  assert.equal(
    creativeActionSafeErrorMessage('some_new_backend_code', DRAWER_FALLBACK),
    DRAWER_FALLBACK,
  );
});

test('creativeActionSafeErrorMessage: defers to customer-safe redactor for plain prose', () => {
  assert.equal(
    creativeActionSafeErrorMessage('This image looks great.', DRAWER_FALLBACK),
    'This image looks great.',
  );
});

test('creativeActionSafeErrorMessage: still redacts secret/auth keywords via customer-safe layer', () => {
  assert.equal(
    creativeActionSafeErrorMessage('meta_app_secret rotation needed', DRAWER_FALLBACK),
    DRAWER_FALLBACK,
  );
  assert.equal(
    creativeActionSafeErrorMessage('Authentication required.', DRAWER_FALLBACK),
    'Your session is no longer active. Sign in again to continue.',
  );
});

test('creativeActionSafeErrorMessage: defaults fallback to drawer generic when omitted', () => {
  assert.equal(
    creativeActionSafeErrorMessage('hermes_regenerate_run_failed'),
    DRAWER_FALLBACK,
  );
});

test('production error path: regenerate 502 with hermes_regenerate_run_failed never leaks raw code', async () => {
  const { default: CreativeActionDrawer } = await import('../frontend/aries-v1/creative-action-drawer');
  assert.equal(typeof CreativeActionDrawer, 'function');
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ status: 'error', error: 'hermes_regenerate_run_failed', reason: 'hermes_regenerate_run_failed' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  const response = await fakeFetch(regenerateCreativeUrl('job-1', 'creative-1'));
  const body = (await response.json()) as Record<string, unknown>;
  const derived = creativeActionSafeErrorMessage(
    typeof body.error === 'string' ? body.error : null,
    DRAWER_FALLBACK,
  );
  assert.equal(derived, DRAWER_FALLBACK);
  assert.equal(derived.includes('hermes'), false);
  assert.equal(derived.includes('regenerate_run_failed'), false);
});

test('production error path: upload 500 with storage_failure never leaks raw code', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ status: 'error', error: 'storage_failure' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  const response = await fakeFetch(uploadReplaceCreativeUrl('job-1', 'creative-1'));
  const body = (await response.json()) as Record<string, unknown>;
  const derived = creativeActionSafeErrorMessage(
    typeof body.error === 'string' ? body.error : null,
    DRAWER_FALLBACK,
  );
  assert.equal(derived, DRAWER_FALLBACK);
  assert.equal(derived.includes('storage'), false);
});

test('production error path: thrown Error.message containing provider_timeout never leaks raw code', () => {
  const errorMessage = 'provider_timeout: hermes did not respond';
  const derived = creativeActionSafeErrorMessage(errorMessage, DRAWER_FALLBACK);
  assert.equal(derived, DRAWER_FALLBACK);
  assert.equal(derived.includes('provider'), false);
  assert.equal(derived.includes('timeout'), false);
});
