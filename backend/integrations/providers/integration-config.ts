/**
 * Feature-flag + env resolution for the integration provider layer.
 *
 * Every flag is read here and nowhere else, so the surface is auditable and the
 * whole Composio layer can be turned off with a single env var. Defaults are
 * chosen so an environment with NONE of these set behaves exactly as before:
 * Composio disabled, direct Meta everywhere.
 *
 * Flag-truthiness follows the repo's canonical 4-token idiom
 * (`1` | `true` | `yes` | `on`); see CLAUDE.md "Optional safety flags".
 */

import type { IntegrationPlatform } from './types';

export type ProviderSelector = 'direct_meta' | 'composio' | 'auto';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function parseFlag(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
}

function parseSelector(raw: string | undefined | null, fallback: ProviderSelector): ProviderSelector {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'direct_meta' || v === 'composio' || v === 'auto') return v;
  return fallback;
}

/** Composio is only ever active when explicitly enabled. Default OFF. */
export function isComposioEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.COMPOSIO_ENABLED);
}

export function publishProviderSelector(env: NodeJS.ProcessEnv = process.env): ProviderSelector {
  return parseSelector(env.PUBLISH_PROVIDER, 'direct_meta');
}

export function analyticsProviderSelector(env: NodeJS.ProcessEnv = process.env): ProviderSelector {
  return parseSelector(env.ANALYTICS_PROVIDER, 'direct_meta');
}

/** Per-platform Composio auth-config ID, falling back to the default config. */
export function composioAuthConfigId(
  platform: IntegrationPlatform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const perPlatform: Record<IntegrationPlatform, string | undefined> = {
    meta_ads: env.COMPOSIO_METAADS_AUTH_CONFIG_ID,
    facebook: env.COMPOSIO_FACEBOOK_AUTH_CONFIG_ID,
    instagram: env.COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID,
    tiktok: env.COMPOSIO_TIKTOK_AUTH_CONFIG_ID,
    youtube: env.COMPOSIO_YOUTUBE_AUTH_CONFIG_ID,
    linkedin: env.COMPOSIO_LINKEDIN_AUTH_CONFIG_ID,
    reddit: env.COMPOSIO_REDDIT_AUTH_CONFIG_ID,
  };
  const specific = perPlatform[platform]?.trim();
  if (specific) return specific;
  const fallback = env.COMPOSIO_DEFAULT_AUTH_CONFIG_ID?.trim();
  return fallback || null;
}

export function composioApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.COMPOSIO_API_KEY?.trim();
  return k || null;
}

/**
 * Toolkit version used for manual (by-slug) Composio tool execution. The
 * @composio/core SDK requires a toolkit version for `tools.execute`; an
 * unspecified/"latest" version throws ComposioToolVersionRequiredError unless
 * the version check is skipped. Default 'latest' (the gateway pairs it with
 * dangerouslySkipVersionCheck). Pin a concrete version (e.g. '20250909_00') via
 * COMPOSIO_TOOLKIT_VERSION to opt out of "latest" drift in production.
 */
export function composioToolkitVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.COMPOSIO_TOOLKIT_VERSION?.trim();
  return v || 'latest';
}

/**
 * Full snapshot of the resolved config — handy for the capability/status UI and
 * for tests that want to assert flag behavior without poking process.env keys
 * one at a time.
 */
export interface ResolvedIntegrationConfig {
  composioEnabled: boolean;
  composioApiKeyPresent: boolean;
  publishProvider: ProviderSelector;
  analyticsProvider: ProviderSelector;
}

export function resolveIntegrationConfig(env: NodeJS.ProcessEnv = process.env): ResolvedIntegrationConfig {
  return {
    composioEnabled: isComposioEnabled(env),
    composioApiKeyPresent: composioApiKey(env) !== null,
    publishProvider: publishProviderSelector(env),
    analyticsProvider: analyticsProviderSelector(env),
  };
}
