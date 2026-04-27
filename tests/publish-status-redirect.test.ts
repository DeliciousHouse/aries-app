import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';

import DashboardPublishStatusPage from '../app/dashboard/publish-status/page';
import PublishStatusPage from '../app/publish-status/page';
import AppShellLayout from '../frontend/app-shell/layout';
import { buildLoginRedirect } from '../lib/auth/callback-url';

function expectRedirect(callable: () => unknown, location: string) {
  assert.throws(callable, (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), 'NEXT_REDIRECT');
    assert.equal((error as { digest?: string }).digest, `NEXT_REDIRECT;replace;${location};307;`);
    return true;
  });
}

test('/publish-status redirects to the canonical dashboard publish-status route', () => {
  expectRedirect(() => PublishStatusPage(), '/dashboard/publish-status');
});

test('/publish-status canonical route preserves the publish-status login callback', () => {
  expectRedirect(() => PublishStatusPage(), '/dashboard/publish-status');

  const element = DashboardPublishStatusPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.loginRedirectPath, '/dashboard/publish-status');
  assert.equal(
    buildLoginRedirect(element.props.loginRedirectPath),
    '/login?callbackUrl=%2Fdashboard%2Fpublish-status',
  );
});

test('/dashboard/publish-status preserves the requested destination through login', () => {
  const element = DashboardPublishStatusPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.loginRedirectPath, '/dashboard/publish-status');
  assert.equal(
    buildLoginRedirect(element.props.loginRedirectPath),
    '/login?callbackUrl=%2Fdashboard%2Fpublish-status',
  );
});
