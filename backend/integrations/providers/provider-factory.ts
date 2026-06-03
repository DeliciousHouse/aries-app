/**
 * Provider selection — the one place that turns flags into concrete providers.
 *
 * Selection rules (see docs/integrations/composio.md):
 *  - COMPOSIO_ENABLED is the master switch. When false, the factory ALWAYS
 *    returns the direct Meta provider, regardless of PUBLISH_PROVIDER /
 *    ANALYTICS_PROVIDER. This guarantees the legacy behavior with a single env.
 *  - With Composio enabled:
 *      direct_meta -> direct Meta provider (Composio code never constructed)
 *      composio    -> Composio provider only
 *      auto        -> Composio first, fall back to direct Meta on failure or
 *                     for any platform Composio cannot service.
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
import { AutoPublisherProvider, AutoAnalyticsProvider } from './auto-providers';
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
  const direct = new DirectMetaProvider();
  const selector = effectivePublishProvider(env);
  if (selector === 'direct_meta') return direct;

  const composio = createComposioPublisherProvider(env);
  if (selector === 'composio') return composio;
  // auto: Composio first, direct Meta fallback.
  return new AutoPublisherProvider(composio, direct);
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
