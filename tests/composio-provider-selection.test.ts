import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPublisherProvider,
  getAnalyticsProvider,
  getAccountConnectionProvider,
  getCapabilityProvider,
  effectivePublishProvider,
  effectiveAnalyticsProvider,
} from '@/backend/integrations/providers/provider-factory';

const mkEnv = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;
const DISABLED = mkEnv({});

test('Composio disabled => direct Meta everywhere, no account provider', () => {
  assert.equal(getPublisherProvider(DISABLED).kind, 'direct_meta');
  assert.equal(getAnalyticsProvider(DISABLED).kind, 'direct_meta');
  assert.equal(getCapabilityProvider(DISABLED).kind, 'direct_meta');
  assert.equal(getAccountConnectionProvider(DISABLED), null);
});

test('master switch: COMPOSIO_ENABLED=false forces direct_meta even when PUBLISH_PROVIDER=composio', () => {
  const env = mkEnv({ COMPOSIO_ENABLED: 'false', PUBLISH_PROVIDER: 'composio', ANALYTICS_PROVIDER: 'composio' });
  assert.equal(effectivePublishProvider(env), 'direct_meta');
  assert.equal(effectiveAnalyticsProvider(env), 'direct_meta');
  assert.equal(getPublisherProvider(env).kind, 'direct_meta');
});

test('PUBLISH_PROVIDER=composio with Composio enabled => composio publisher', () => {
  const env = mkEnv({ COMPOSIO_ENABLED: 'true', COMPOSIO_API_KEY: 'k', PUBLISH_PROVIDER: 'composio' });
  assert.equal(effectivePublishProvider(env), 'composio');
  const provider = getPublisherProvider(env);
  // ComposioPublisherProvider supports all integration platforms.
  assert.equal(provider.supports('tiktok'), true);
});

test('PUBLISH_PROVIDER=auto => composite that still supports direct Meta platforms', () => {
  const env = mkEnv({ COMPOSIO_ENABLED: 'true', COMPOSIO_API_KEY: 'k', PUBLISH_PROVIDER: 'auto' });
  assert.equal(effectivePublishProvider(env), 'auto');
  const provider = getPublisherProvider(env);
  assert.equal(provider.supports('facebook'), true);
});

test('default (no flags) selectors resolve to direct_meta', () => {
  assert.equal(effectivePublishProvider(DISABLED), 'direct_meta');
  assert.equal(effectiveAnalyticsProvider(DISABLED), 'direct_meta');
});
