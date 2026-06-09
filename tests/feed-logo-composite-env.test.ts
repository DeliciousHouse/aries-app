import assert from 'node:assert/strict';
import test from 'node:test';

import { isFeedLogoCompositeEnabled } from '../backend/social-content/feed-logo-composite-env';

test('isFeedLogoCompositeEnabled: truthy values enable', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(isFeedLogoCompositeEnabled({ ARIES_FEED_LOGO_COMPOSITE_ENABLED: v }), true, `"${v}" should enable`);
  }
});

test('isFeedLogoCompositeEnabled: falsy / unset values disable', () => {
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', undefined]) {
    assert.equal(
      isFeedLogoCompositeEnabled({ ARIES_FEED_LOGO_COMPOSITE_ENABLED: v as string | undefined }),
      false,
      `"${String(v)}" should not enable`,
    );
  }
  assert.equal(isFeedLogoCompositeEnabled({}), false, 'unset should disable (default OFF)');
});
