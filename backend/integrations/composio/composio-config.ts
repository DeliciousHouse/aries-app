/**
 * Composio adapter configuration.
 *
 * Two kinds of identifier matter here:
 *  1. Toolkit slugs — the stable Composio toolkit identifier per platform
 *     (e.g. 'facebook'). These are well-known and hard-coded.
 *  2. Action slugs — the per-operation tool slug executed via
 *     composio.tools.execute(slug, ...) (e.g. 'FACEBOOK_CREATE_PAGE_POST').
 *     These vary by toolkit version, so they are NOT hard-coded/guessed. They
 *     are read from env overrides; when unset, the adapter reports the operation
 *     as unavailable rather than inventing a slug. See docs/integrations/composio.md.
 *
 * This keeps the adapter honest: it only calls action slugs an operator has
 * explicitly confirmed for their Composio account + toolkit version.
 */

import type { IntegrationPlatform } from '../providers/types';
import { composioApiKey, composioAuthConfigId } from '../providers/integration-config';

/** Stable Composio toolkit slug per platform. */
export const TOOLKIT_SLUG: Record<IntegrationPlatform, string> = {
  facebook: 'facebook',
  instagram: 'instagram',
  meta_ads: 'metaads',
  tiktok: 'tiktok',
  youtube: 'youtube',
  linkedin: 'linkedin',
  reddit: 'reddit',
};

export type ComposioOperation =
  | 'publish_post'
  | 'upload_media'
  | 'post_insights'
  | 'ad_insights'
  | 'account_insights'
  | 'create_ad'
  | 'list_ad_accounts'
  | 'list_pages'
  | 'account_info'
  | 'list_posts'
  | 'list_comments';

/**
 * Env override key for a given platform+operation action slug, e.g.
 * COMPOSIO_FACEBOOK_PUBLISH_POST_ACTION. Unset => operation unavailable.
 */
function actionEnvKey(platform: IntegrationPlatform, op: ComposioOperation): string {
  return `COMPOSIO_${platform.toUpperCase()}_${op.toUpperCase()}_ACTION`;
}

export function actionSlug(
  platform: IntegrationPlatform,
  op: ComposioOperation,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[actionEnvKey(platform, op)]?.trim();
  return raw || null;
}

export interface ComposioConfig {
  apiKey: string;
  authConfigIdFor(platform: IntegrationPlatform): string | null;
  toolkitSlugFor(platform: IntegrationPlatform): string;
  actionSlugFor(platform: IntegrationPlatform, op: ComposioOperation): string | null;
}

/**
 * Build a resolved config snapshot. Returns null (rather than throwing) when no
 * API key is present, so callers can degrade gracefully — the providers turn a
 * null config into a clear ComposioConfigError only at the point of use.
 */
export function resolveComposioConfig(env: NodeJS.ProcessEnv = process.env): ComposioConfig | null {
  const apiKey = composioApiKey(env);
  if (!apiKey) return null;
  return {
    apiKey,
    authConfigIdFor: (platform) => composioAuthConfigId(platform, env),
    toolkitSlugFor: (platform) => TOOLKIT_SLUG[platform],
    actionSlugFor: (platform, op) => actionSlug(platform, op, env),
  };
}
