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
 * The Composio providers are imported lazily (only constructed when actually
 * selected) so a disabled deployment never even loads the adapter — keeping the
 * whole layer cleanly removable.
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

// Composio providers are required lazily so the adapter (and its SDK) is never
// loaded when Composio is disabled or unselected.
function loadComposio() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../composio') as typeof import('../composio');
}

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

  const composio = loadComposio().createComposioPublisherProvider(env);
  if (selector === 'composio') return composio;
  // auto: Composio first, direct Meta fallback.
  return new AutoPublisherProvider(composio, direct);
}

export function getAnalyticsProvider(env: NodeJS.ProcessEnv = process.env): AnalyticsProvider {
  const direct = new DirectMetaProvider();
  const selector = effectiveAnalyticsProvider(env);
  if (selector === 'direct_meta') return direct;

  const composio = loadComposio().createComposioAnalyticsProvider(env);
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
  return loadComposio().createComposioAccountProvider(env);
}

export function getCapabilityProvider(
  env: NodeJS.ProcessEnv = process.env,
): CapabilityProvider {
  if (!isComposioEnabled(env)) return new DirectMetaProvider();
  return loadComposio().createComposioCapabilityProvider(env);
}
