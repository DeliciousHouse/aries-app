import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';

import ReviewItemPage from '../app/review/[reviewId]/page';
import ReviewQueuePage from '../app/review/page';
import AppShellLayout from '../frontend/app-shell/layout';
import { buildLoginRedirect } from '../lib/auth/callback-url';

test('review queue passes an explicit login callback path into the app shell', () => {
  const element = ReviewQueuePage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.loginRedirectPath, '/review');
  assert.equal(
    buildLoginRedirect(element.props.loginRedirectPath),
    '/login?callbackUrl=%2Freview',
  );
});

test('review deep links preserve the requested destination through login', async () => {
  const element = await ReviewItemPage({
    params: Promise.resolve({
      reviewId: 'mkt_c3929018-5bdb-4dfc-83ab-f2ed13bdb97b%3A%3Acreative%3Aimage-proof',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(
    element.props.loginRedirectPath,
    '/review/mkt_c3929018-5bdb-4dfc-83ab-f2ed13bdb97b%3A%3Acreative%3Aimage-proof',
  );
  assert.equal(
    buildLoginRedirect(element.props.loginRedirectPath),
    '/login?callbackUrl=%2Freview%2Fmkt_c3929018-5bdb-4dfc-83ab-f2ed13bdb97b%253A%253Acreative%253Aimage-proof',
  );
});
