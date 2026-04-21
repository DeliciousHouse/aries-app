import assert from 'node:assert/strict';
import test from 'node:test';

import PublishStatusPage from '../app/publish-status/page';

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
