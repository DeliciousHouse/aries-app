import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import React from 'react';

import { GET as getOnboardingStatus } from '../app/api/onboarding/status/[tenantId]/route';
import OnboardingStatusScreen from '../frontend/onboarding/status';
import type { OnboardingStatusSuccess } from '../lib/api/onboarding';

const notFoundStatusPayload: OnboardingStatusSuccess = {
  request_status: 'ok',
  onboarding_status: 'ok',
  tenant_id: 'tenant_missing',
  provisioning_status: 'not_found',
  validation_status: 'unknown',
  progress_hint: 'not_started',
  artifacts: {
    draft: false,
    validated: false,
    validation_report: false,
    idempotency_marker: false,
  },
};

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderedText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(renderedText).join(' ');
  }
  if (typeof node === 'object' && 'children' in node) {
    const children = (node as { children?: unknown }).children;
    return renderedText(children);
  }
  return '';
}

test('/api/onboarding/status maps request success separately from tenant existence for not-found tenants', async () => {
  const oldDataRoot = process.env.DATA_ROOT;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'aries-onboarding-status-not-found-'));

  try {
    process.env.DATA_ROOT = dataRoot;

    const response = await getOnboardingStatus(
      new Request('http://localhost/api/onboarding/status/tenant_missing'),
      { params: Promise.resolve({ tenantId: 'tenant_missing' }) },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(body, notFoundStatusPayload);
  } finally {
    if (oldDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = oldDataRoot;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('onboarding status screen behavior shows tenant-not-found copy and badge without top-level OK badge', async () => {
  const previousFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    assert.equal(url, 'https://aries.example.com/api/onboarding/status/tenant_missing');
    return new Response(JSON.stringify(notFoundStatusPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { act, create } = await import('react-test-renderer');
    let root!: import('react-test-renderer').ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(OnboardingStatusScreen, {
          baseUrl: 'https://aries.example.com',
          initialTenantId: 'tenant_missing',
        }),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.deepEqual(fetchedUrls, ['https://aries.example.com/api/onboarding/status/tenant_missing']);

    const text = renderedText(root.toJSON());
    assert.match(text, /Tenant not found/);
    assert.match(
      text,
      /The status request succeeded, but Aries could not find onboarding artifacts for this tenant ID yet\./,
    );
    assert.match(text, /request_status\s+Request succeeded/);
    assert.match(text, /tenant_status\s+Not found/);
    assert.doesNotMatch(text, /onboarding_status\s+OK/);

    const statusBadges = root.root.findAllByProps({ role: 'status' });
    const statuses = statusBadges.map((badge) => badge.props['data-status']);
    assert.ok(statuses.includes('not_found'), 'expected a not_found StatusBadge for the missing tenant');
    assert.equal(statuses.includes('ok'), false, 'missing tenants should not render an OK onboarding_status badge');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
