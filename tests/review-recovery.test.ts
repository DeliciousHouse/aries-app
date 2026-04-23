import assert from 'node:assert/strict';
import test from 'node:test';

import { getReviewRecoveryState } from '../frontend/aries-v1/review-recovery';

test('review recovery state is null for generic review errors', () => {
  assert.equal(
    getReviewRecoveryState({
      status: 404,
      code: 'review_not_found',
      message: 'review_not_found',
    }),
    null,
  );
});

test('review recovery state exposes actionable links for wrong-workspace deep links', () => {
  const recovery = getReviewRecoveryState({
    status: 409,
    code: 'review_not_in_current_workspace',
    message: 'This review belongs to a different workspace than the one currently active for your account.',
  });

  assert.ok(recovery);
  assert.equal(recovery.title, 'This review belongs to a different workspace');
  assert.equal(recovery.primaryAction.label, 'Open review queue');
  assert.equal(recovery.primaryAction.href, '/review');
  assert.equal(recovery.secondaryAction.label, 'Open campaigns');
  assert.equal(recovery.secondaryAction.href, '/dashboard/campaigns');
  assert.match(recovery.guidance, /sign out and reopen the same link/i);
});
