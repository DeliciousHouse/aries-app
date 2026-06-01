/**
 * Public entry point for the Aries integration provider layer.
 *
 * Consumers should import from here, not from individual provider files:
 *   import { getPublisherProvider } from '@/backend/integrations/providers';
 *
 * This barrel is provider-agnostic — it never imports the Composio adapter
 * directly; the factory loads it lazily only when selected.
 */

export * from './types';
export * from './interfaces';
export * from './errors';
export {
  parseFlag,
  isComposioEnabled,
  publishProviderSelector,
  analyticsProviderSelector,
  composioAuthConfigId,
  composioApiKey,
  resolveIntegrationConfig,
  type ProviderSelector,
  type ResolvedIntegrationConfig,
} from './integration-config';
export {
  getPublisherProvider,
  getAnalyticsProvider,
  getAccountConnectionProvider,
  getCapabilityProvider,
  effectivePublishProvider,
  effectiveAnalyticsProvider,
} from './provider-factory';
