import assert from 'node:assert/strict';
import test from 'node:test';

import { ReportTenantAttributionError } from '../backend/feedback/report-submitter';
import { handleFeedbackSubmit } from '../app/api/feedback/submit/route';
import { readWorkspaceMismatchBody } from '../lib/api/workspace-guard';
import { WorkspaceMismatchError } from '../lib/tenant-context';

function request(): Request {
  return new Request('https://aries.example.com/api/feedback/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

const enabled = () => true;

test('feedback submit route maps a typed stale-workspace conflict to the shared 409 interlock shape', async () => {
  const response = await handleFeedbackSubmit(request(), {
    enabled,
    resolveSubmitter: async () => {
      throw new ReportTenantAttributionError('workspace conflict', {
        cause: new WorkspaceMismatchError('workspace_mismatch', '9', '7'),
      });
    },
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'workspace_mismatch');
  assert.ok(readWorkspaceMismatchBody(body), 'lib/api/http must recognize the route response');
});

test('feedback submit route maps an authenticated membership conflict to a recognized 409', async () => {
  const response = await handleFeedbackSubmit(request(), {
    enabled,
    resolveSubmitter: async () => {
      throw new ReportTenantAttributionError(
        'Resolved workspace membership does not belong to the authenticated user.',
      );
    },
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'workspace_mismatch');
  assert.ok(readWorkspaceMismatchBody(body), 'membership conflicts must trigger the workspace interlock');
});

test('feedback submit route maps tenant dependency failures to a safe retryable 503', async () => {
  const response = await handleFeedbackSubmit(request(), {
    enabled,
    resolveSubmitter: async () => {
      throw new ReportTenantAttributionError('tenant lookup failed', {
        cause: new Error('database host and internal diagnostic must stay private'),
      });
    },
  });

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'tenant_context_unavailable');
  assert.equal(typeof body.message, 'string');
  assert.doesNotMatch(JSON.stringify(body), /database host|internal diagnostic/i);
  assert.equal(readWorkspaceMismatchBody(body), null);
});
