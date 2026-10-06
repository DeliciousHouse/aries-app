/**
 * Provider selection — the one place that turns flags into concrete providers.
 *
 * Selection rules (see docs/integrations/composio.md):
 *  - Publishing requires Composio. Unscoped direct_meta/auto selection and
 *    the Composio-disabled fallback fail closed, never using global Meta env.
 *  - Analytics retains its unavailable direct Meta adapter when disabled.
 *
 * The Composio adapter is statically imported but its providers are only
 * CONSTRUCTED when actually selected, and the heavy @composio/core SDK is only
 * loaded (via `await import`) on first gateway use — so a disabled deployment
 * pays nothing at runtime and the layer stays cleanly removable.
 */

import type {
  AccountConnectionProvider,
  AnalyticsProvider,
  CapabilityProvider,
  PublisherProvider,
} from './interfaces';
import {
  analyticsProviderSelector,
  isComposioEnabled,
  publishProviderSelector,
  type ProviderSelector,
} from './integration-config';
import { DirectMetaProvider } from '../direct/direct-meta-provider';
import { AutoAnalyticsProvider } from './auto-providers';
import { ProviderUnavailableError } from './errors';
// Static import of the Composio adapter factories. This is intentionally NOT a
// runtime require(): under Turbopack's production build, require() of this
// compiled ES module does not expose its named exports (it returned a module
// object without createComposio*Provider), which 500'd every Composio request.
// Importing statically is safe: the composio module only references provider
// classes + config at load time — the heavy @composio/core SDK is still loaded
// lazily via `await import('@composio/core')` inside the gateway, and the
// providers are only constructed when actually selected below.
import {
  createComposioAccountProvider,
  createComposioPublisherProvider,
  createComposioAnalyticsProvider,
  createComposioCapabilityProvider,
} from '../composio';
import type { IntegrationPlatform } from './types';

/**
 * The effective publish selector after applying the master switch. Exposed so
 * the status endpoint can report what will actually happen.
 */
export function effectivePublishProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelector {
  if (!isComposioEnabled(env)) return 'direct_meta';
  return publishProviderSelector(env);
}

export function effectiveAnalyticsProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelector {
  if (!isComposioEnabled(env)) return 'direct_meta';
  return analyticsProviderSelector(env);
}

export function getPublisherProvider(env: NodeJS.ProcessEnv = process.env): PublisherProvider {
  const selector = effectivePublishProvider(env);
  if (selector !== 'composio') {
    throw new ProviderUnavailableError(
      'direct_meta_unscoped',
      'direct_meta_unscoped: Publishing requires a tenant-connected Composio account; direct_meta and auto are disabled.',
    );
  }
  return createComposioPublisherProvider(env);
}

export function getAnalyticsProvider(env: NodeJS.ProcessEnv = process.env): AnalyticsProvider {
  const direct = new DirectMetaProvider();
  const selector = effectiveAnalyticsProvider(env);
  if (selector === 'direct_meta') return direct;

  const composio = createComposioAnalyticsProvider(env);
  if (selector === 'composio') return composio;
  return new AutoAnalyticsProvider(composio, direct);
}

/**
 * Account-connection management is only meaningful for Composio (direct Meta
 * connections are env-managed via META_PAGE_ID/META_ACCESS_TOKEN and have no
 * end-user connect flow). Returns null when Composio is disabled.
 */
export function getAccountConnectionProvider(
  env: NodeJS.ProcessEnv = process.env,
): AccountConnectionProvider | null {
  if (!isComposioEnabled(env)) return null;
  return createComposioAccountProvider(env);
}

export function getCapabilityProvider(
  env: NodeJS.ProcessEnv = process.env,
): CapabilityProvider {
  if (!isComposioEnabled(env)) return new DirectMetaProvider();
  return createComposioCapabilityProvider(env);
}

/**
 * Platforms that must ALWAYS route through Composio for publishing, regardless
 * of the global PUBLISH_PROVIDER selector. Facebook and Instagram keep the
 * selector-driven path, which refuses unscoped direct_meta/auto publishing.
 *
 */
const COMPOSIO_ONLY_PUBLISH_PLATFORMS = new Set<IntegrationPlatform>(['x', 'reddit', 'linkedin', 'youtube']);

/** True when the platform can only publish through Composio (not direct Meta). */
export function isComposioOnlyPublishPlatform(platform: IntegrationPlatform): boolean {
  return COMPOSIO_ONLY_PUBLISH_PLATFORMS.has(platform);
}

/**
 * Platform-aware publisher factory. Composio-only platforms (x, reddit,
 * linkedin, youtube) always return the Composio publisher, regardless of the
 * global PUBLISH_PROVIDER selector. All other platforms (facebook, instagram, …)
 * delegate to getPublisherProvider and its fail-closed selection guard.
 */
export function getPublisherProviderForPlatform(
  platform: IntegrationPlatform,
  env: NodeJS.ProcessEnv = process.env,
): PublisherProvider {
  if (isComposioOnlyPublishPlatform(platform)) {
    return createComposioPublisherProvider(env);
  }
  return getPublisherProvider(env);
}
