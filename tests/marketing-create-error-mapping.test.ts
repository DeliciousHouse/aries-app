import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUSINESS_TYPE_MISSING_COPY,
  WEBSITE_UNREACHABLE_COPY,
  WEBSITE_URL_REQUIRED_COPY,
  humanizeMarketingCreateMessage,
  mapMarketingCreateFailure,
} from '../lib/marketing-create-errors';
import { COMPETITOR_URL_SOCIAL_ERROR } from '../lib/marketing-competitor';
import { submitGenerateThisWeek } from '../frontend/aries-v1/generate-this-week';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// AA-131: a create-post submission that failed on brand-kit extraction
// surfaced the raw `brand_kit_fetch_failed:fetch failed` code in the form's
// top-level alert, with no hint which input to fix. The mapping pins each
// operator-actionable failure to the create form's field names and collapses
// the inner error detail out of the response body.

test('mapMarketingCreateFailure collapses brand_kit_fetch_failed inner detail and pins websiteUrl', () => {
  const mapped = mapMarketingCreateFailure('brand_kit_fetch_failed:fetch failed');
  assert.ok(mapped);
  assert.equal(mapped.status, 422);
  assert.equal(mapped.error, 'brand_kit_fetch_failed');
  assert.equal(mapped.fieldErrors?.websiteUrl, WEBSITE_UNREACHABLE_COPY);
  // The undici cause must never reach the response body.
  assert.ok(!JSON.stringify(mapped).includes('fetch failed'));
});

test('mapMarketingCreateFailure unwraps the needs_brand_kit weekly-refresh prefix', () => {
  const mapped = mapMarketingCreateFailure('needs_brand_kit:brand_kit_fetch_failed:getaddrinfo ENOTFOUND example.test');
  assert.ok(mapped);
  assert.equal(mapped.status, 422);
  assert.equal(mapped.error, 'brand_kit_fetch_failed');
  assert.equal(mapped.fieldErrors?.websiteUrl, WEBSITE_UNREACHABLE_COPY);
  assert.ok(!JSON.stringify(mapped).includes('ENOTFOUND'));
});

test('mapMarketingCreateFailure maps brand_url_missing to a required websiteUrl field error', () => {
  const mapped = mapMarketingCreateFailure('needs_brand_kit:brand_url_missing');
  assert.ok(mapped);
  assert.equal(mapped.status, 422);
  assert.equal(mapped.fieldErrors?.websiteUrl, WEBSITE_URL_REQUIRED_COPY);
});

test('mapMarketingCreateFailure maps missing_required_fields entries to form field errors', () => {
  const mapped = mapMarketingCreateFailure('missing_required_fields:payload.brandUrl,payload.businessType');
  assert.ok(mapped);
  assert.equal(mapped.status, 400);
  assert.equal(mapped.error, 'missing_required_fields:payload.brandUrl,payload.businessType');
  assert.equal(mapped.fieldErrors?.websiteUrl, WEBSITE_URL_REQUIRED_COPY);
  assert.equal(mapped.fieldErrors?.businessType, BUSINESS_TYPE_MISSING_COPY);
  assert.ok(mapped.message.includes(WEBSITE_URL_REQUIRED_COPY));
  assert.ok(mapped.message.includes(BUSINESS_TYPE_MISSING_COPY));
});

test('mapMarketingCreateFailure surfaces unmapped missing fields in the message', () => {
  const mapped = mapMarketingCreateFailure('missing_required_fields:tenantId');
  assert.ok(mapped);
  assert.equal(mapped.status, 400);
  assert.equal(mapped.fieldErrors, undefined);
  assert.ok(mapped.message.includes('tenantId'));
});

test('mapMarketingCreateFailure returns null for unknown failures', () => {
  assert.equal(mapMarketingCreateFailure('some_totally_unknown_error'), null);
  assert.equal(mapMarketingCreateFailure(''), null);
});

test('humanizeMarketingCreateMessage falls back to the input for unknown codes', () => {
  assert.equal(humanizeMarketingCreateMessage('brand_kit_fetch_failed:fetch failed'), WEBSITE_UNREACHABLE_COPY);
  assert.equal(humanizeMarketingCreateMessage('anything else'), 'anything else');
});

// Handler-level regression: the POST /api/marketing/jobs response for a
// brand-kit fetch failure must carry structured fieldErrors and must NOT echo
// the raw inner error. Uses a private-IP brand URL so ssrfSafeFetch rejects
// deterministically with no network dependency (any fetch/DNS failure takes
// the same brand_kit_fetch_failed wrap).
async function withHandlerRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-create-error-'));
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function tenantLoaderStub(tenantId: string) {
  return async () => ({
    userId: `user-${tenantId}`,
    tenantId,
    tenantSlug: tenantId.replace(/_/g, '-'),
    role: 'tenant_admin' as const,
  });
}

test('POST /api/marketing/jobs returns 422 + websiteUrl fieldError when the brand-kit fetch fails', async () => {
  await withHandlerRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://127.0.0.1/',
            businessType: 'Test vertical',
          },
        }),
      }),
      tenantLoaderStub('tenant_create_error_fetch'),
    );

    assert.equal(response.status, 422);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'brand_kit_fetch_failed');
    assert.equal(typeof body.message, 'string');
    const fieldErrors = body.fieldErrors as Record<string, string>;
    assert.equal(fieldErrors.websiteUrl, WEBSITE_UNREACHABLE_COPY);
    // No inner fetch/DNS/SSRF detail may leak into the response body.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('ssrf_blocked'));
    assert.ok(!serialized.includes('fetch failed'));
    assert.ok(!serialized.includes('127.0.0.1'));
  });
});

test('POST /api/marketing/jobs returns 400 + competitorUrl fieldError for a social competitor URL', async () => {
  await withHandlerRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            competitorUrl: 'https://www.facebook.com/somecompetitor',
          },
        }),
      }),
      tenantLoaderStub('tenant_create_error_competitor'),
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, COMPETITOR_URL_SOCIAL_ERROR);
    const fieldErrors = body.fieldErrors as Record<string, string>;
    assert.equal(fieldErrors.competitorUrl, COMPETITOR_URL_SOCIAL_ERROR);
  });
});

test('submitGenerateThisWeek prefers the operator-facing message over the machine error code', async () => {
  const fetchStub = (async () =>
    new Response(
      JSON.stringify({
        error: 'brand_kit_fetch_failed',
        message: WEBSITE_UNREACHABLE_COPY,
        fieldErrors: { websiteUrl: WEBSITE_UNREACHABLE_COPY },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  const result = await submitGenerateThisWeek(fetchStub);
  assert.equal(result.ok, false);
  assert.equal(result.errorMessage, WEBSITE_UNREACHABLE_COPY);
});

test('POST /api/marketing/jobs returns 400 + businessType fieldError when the profile has no business type', async () => {
  await withHandlerRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
          },
        }),
      }),
      tenantLoaderStub('tenant_create_error_biztype'),
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'missing_required_fields:payload.businessType');
    const fieldErrors = body.fieldErrors as Record<string, string>;
    assert.equal(fieldErrors.businessType, BUSINESS_TYPE_MISSING_COPY);
  });
});
