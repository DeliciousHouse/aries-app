/**
 * Composio adapter barrel + factory functions.
 *
 * provider-factory.ts loads this module lazily (only when Composio is selected),
 * so importing it constructs nothing until a create* function is called. Each
 * create* wires a resolved config + a live gateway into the matching provider.
 */

import { resolveComposioConfig } from './composio-config';
import { createComposioGateway, type ComposioGateway } from './composio-client';
import { ComposioConfigError } from './errors';
import { ComposioAccountProvider } from './composio-account-provider';
import { ComposioPublisherProvider } from './composio-publisher-provider';
import { ComposioAnalyticsProvider } from './composio-analytics-provider';
import { ComposioCapabilityProvider } from './composio-capability-provider';

function buildGateway(env: NodeJS.ProcessEnv): { gateway: ComposioGateway; config: ReturnType<typeof resolveComposioConfig> } {
  const config = resolveComposioConfig(env);
  if (!config) {
    throw new ComposioConfigError('Composio is enabled but COMPOSIO_API_KEY is not set.');
  }
  return { gateway: createComposioGateway(config), config };
}

export function createComposioAccountProvider(env: NodeJS.ProcessEnv = process.env): ComposioAccountProvider {
  const { gateway, config } = buildGateway(env);
  return new ComposioAccountProvider(gateway, config!);
}

export function createComposioPublisherProvider(env: NodeJS.ProcessEnv = process.env): ComposioPublisherProvider {
  const { gateway, config } = buildGateway(env);
  return new ComposioPublisherProvider(gateway, config!);
}

export function createComposioAnalyticsProvider(env: NodeJS.ProcessEnv = process.env): ComposioAnalyticsProvider {
  const { gateway, config } = buildGateway(env);
  return new ComposioAnalyticsProvider(gateway, config!);
}

export function createComposioCapabilityProvider(env: NodeJS.ProcessEnv = process.env): ComposioCapabilityProvider {
  const { gateway, config } = buildGateway(env);
  return new ComposioCapabilityProvider(gateway, config!);
}

export { ComposioAccountProvider } from './composio-account-provider';
export { ComposioPublisherProvider } from './composio-publisher-provider';
export { ComposioAnalyticsProvider } from './composio-analytics-provider';
export { ComposioCapabilityProvider } from './composio-capability-provider';
export type { ComposioGateway } from './composio-client';
