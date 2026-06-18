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
import {
  publishProviderSelector,
  analyticsProviderSelector,
} from '@/backend/integrations/providers/integration-config';

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

// This test exercises the COMPOSIO_ENABLED=false fail-safe on the *effective* functions.
// The raw selectors (publishProviderSelector / analyticsProviderSelector) now default to
// 'composio', but effective* adds a mandatory guard that short-circuits to 'direct_meta'
// when COMPOSIO_ENABLED is not truthy, keeping CI / local envs unaffected.
test('default (no flags): effective providers return direct_meta via the COMPOSIO_ENABLED fail-safe', () => {
  assert.equal(effectivePublishProvider(DISABLED), 'direct_meta');
  assert.equal(effectiveAnalyticsProvider(DISABLED), 'direct_meta');
});

// ── #681 adversarial cases ────────────────────────────────────────────────────

test('#681 (a) GOLDEN fail-safe: effective providers return direct_meta when COMPOSIO_ENABLED is absent or false', () => {
  // The fail-safe in effectivePublishProvider / effectiveAnalyticsProvider is UNCHANGED.
  // Even though the raw selector now defaults to 'composio', the effective functions
  // must still return 'direct_meta' whenever COMPOSIO_ENABLED is not truthy, so that
  // CI and local environments without the flag are byte-identical to before.
  assert.equal(effectivePublishProvider(mkEnv({})), 'direct_meta', 'no COMPOSIO_ENABLED => direct_meta');
  assert.equal(effectiveAnalyticsProvider(mkEnv({})), 'direct_meta', 'no COMPOSIO_ENABLED => direct_meta');
  assert.equal(effectivePublishProvider(mkEnv({ COMPOSIO_ENABLED: 'false' })), 'direct_meta', 'COMPOSIO_ENABLED=false => direct_meta');
  assert.equal(effectiveAnalyticsProvider(mkEnv({ COMPOSIO_ENABLED: 'false' })), 'direct_meta', 'COMPOSIO_ENABLED=false => direct_meta');
  assert.equal(effectivePublishProvider(mkEnv({ COMPOSIO_ENABLED: '0' })), 'direct_meta', 'COMPOSIO_ENABLED=0 => direct_meta');
  assert.equal(effectiveAnalyticsProvider(mkEnv({ COMPOSIO_ENABLED: '0' })), 'direct_meta', 'COMPOSIO_ENABLED=0 => direct_meta');
});

test('#681 (b) NEW default: COMPOSIO_ENABLED=true + selector unset => composio (was direct_meta pre-fix)', () => {
  // Pre-fix: publishProviderSelector / analyticsProviderSelector defaulted to 'direct_meta',
  // so an opted-in deployment needed to also set PUBLISH_PROVIDER=composio explicitly.
  // Post-fix: the raw selector fallback is 'composio', so Composio-enabled pods get the
  // Composio path automatically without an extra env var.
  const env = mkEnv({ COMPOSIO_ENABLED: 'true' });
  assert.equal(effectivePublishProvider(env), 'composio', 'COMPOSIO_ENABLED=true + unset PUBLISH_PROVIDER => composio');
  assert.equal(effectiveAnalyticsProvider(env), 'composio', 'COMPOSIO_ENABLED=true + unset ANALYTICS_PROVIDER => composio');
});

test('#681 (c) explicit override: COMPOSIO_ENABLED=true + explicit selector wins over composio default', () => {
  // Explicit PUBLISH_PROVIDER / ANALYTICS_PROVIDER values always win, regardless of the default.
  assert.equal(
    effectivePublishProvider(mkEnv({ COMPOSIO_ENABLED: 'true', PUBLISH_PROVIDER: 'direct_meta' })),
    'direct_meta',
    'explicit direct_meta overrides the composio default',
  );
  assert.equal(
    effectivePublishProvider(mkEnv({ COMPOSIO_ENABLED: 'true', PUBLISH_PROVIDER: 'auto' })),
    'auto',
    'explicit auto overrides the composio default',
  );
  assert.equal(
    effectiveAnalyticsProvider(mkEnv({ COMPOSIO_ENABLED: 'true', ANALYTICS_PROVIDER: 'direct_meta' })),
    'direct_meta',
    'explicit direct_meta overrides analytics composio default',
  );
  assert.equal(
    effectiveAnalyticsProvider(mkEnv({ COMPOSIO_ENABLED: 'true', ANALYTICS_PROVIDER: 'auto' })),
    'auto',
    'explicit auto overrides analytics composio default',
  );
});

test('#681 raw selector default: publishProviderSelector and analyticsProviderSelector default to composio when env var is unset', () => {
  // Raw selectors are the pre-fail-safe layer. Their default changed from 'direct_meta'
  // to 'composio'. Callers that reach the raw selector directly (e.g. isFacebookInsightsEnabled)
  // see 'composio' when ANALYTICS_PROVIDER / PUBLISH_PROVIDER is unset.
  assert.equal(publishProviderSelector(mkEnv({})), 'composio', 'raw publish selector defaults to composio');
  assert.equal(analyticsProviderSelector(mkEnv({})), 'composio', 'raw analytics selector defaults to composio');
  // Explicit values still win.
  assert.equal(publishProviderSelector(mkEnv({ PUBLISH_PROVIDER: 'direct_meta' })), 'direct_meta');
  assert.equal(publishProviderSelector(mkEnv({ PUBLISH_PROVIDER: 'auto' })), 'auto');
  assert.equal(analyticsProviderSelector(mkEnv({ ANALYTICS_PROVIDER: 'direct_meta' })), 'direct_meta');
  assert.equal(analyticsProviderSelector(mkEnv({ ANALYTICS_PROVIDER: 'auto' })), 'auto');
});
