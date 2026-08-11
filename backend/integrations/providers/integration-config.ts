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

import { actionSlug } from '../composio/composio-config';
import { INTEGRATION_PLATFORMS, type IntegrationPlatform } from './types';

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

/** X (Twitter) connect rollout flag. Default OFF — ships the platform dormant. */
export function isXEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_X_ENABLED);
}

/**
 * YouTube rollout flag (#637 analytics, #638 comments, #636 publish). Default
 * OFF — ships the Composio-backed YouTube insights adapter AND the still→video
 * publish path dormant. YouTube already *connects* via Composio, so this flag
 * does NOT gate connectability (it is deliberately NOT wired into
 * `connectablePlatforms`); it gates the insights bridge + adapter, the publish
 * branch (composio-publisher-provider), and YouTube as a schedulable target
 * (scheduled-posts allowlist + scheduled-dispatch admit gate). NEW flag — never
 * reuse ARIES_X_ENABLED.
 */
export function isYouTubeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_YOUTUBE_ENABLED);
}

/**
 * Reddit publish rollout flag. Default OFF — ships the publish path dormant
 * (Reddit already *connects* via Composio; this flag gates publish only, so it
 * is deliberately NOT wired into `connectablePlatforms`).
 */
export function isRedditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_REDDIT_ENABLED);
}

/**
 * Explicit target subreddit for Reddit publish (COMPOSIO_REDDIT_TARGET_SUBREDDIT).
 *
 * Returns null when unset/empty. There is NO `u_<username>` profile fallback:
 * Reddit's `sr` field resolves COMMUNITY names only, so a user-profile target
 * deterministically fails with SUBREDDIT_NOEXIST. On null the reddit publish
 * path refuses up-front with a capability error
 * (composio-publisher-provider.ts) and the weekly crosspost producer skips
 * reddit entirely (weekly-crosspost.ts `isCrosspostPlatformConfigured`), so no
 * reddit row is ever synthesized that cannot be delivered.
 */
export function redditTargetSubreddit(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.COMPOSIO_REDDIT_TARGET_SUBREDDIT?.trim();
  return v || null;
}

/**
 * LinkedIn rollout flag. Default OFF. Gates the connect-time person-URN
 * resolution (and, later, LinkedIn publish #646); LinkedIn is already a
 * connectable platform, so this flag does NOT gate connectability — only the
 * extra `LINKEDIN_GET_MY_INFO` author-URN lookup. When OFF the connect path is
 * byte-identical to today (no executeTool call).
 */
export function isLinkedInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_LINKEDIN_ENABLED);
}

// ---------------------------------------------------------------------------
// "Which platforms can a weekly run actually deliver posts to right now?"
//
// SINGLE SOURCE OF TRUTH (AA-217). These four exports are the ONLY place that
// answers that question. They were hoisted here out of
// `backend/marketing/weekly-crosspost.ts` (which now consumes them) precisely so
// the publish gate, the crosspost fan-out and the alternate-primary resolver can
// never drift into three parallel copies — drift is what produces the
// "gate passes but the run synthesizes zero rows" silent-empty-week failure.
//
// Adding a platform to the weekly pipeline means touching ONLY this block.
// ---------------------------------------------------------------------------

/**
 * The Composio-only publish platforms a weekly feed image can be delivered to
 * beyond Meta. Order is meaningful: it is the order rows are synthesized in.
 */
export const CROSSPOST_PLATFORMS = ['x', 'linkedin', 'reddit'] as const;
export type CrosspostPlatform = (typeof CROSSPOST_PLATFORMS)[number];

/**
 * The Meta-family organic publish targets. These are the legacy primary
 * surfaces (feed/story/reel) and are always publishable — they are gated by a
 * tenant connection, never by a rollout flag.
 */
export const META_PUBLISH_PLATFORMS = ['facebook', 'instagram'] as const;

/**
 * AA-217 rollout flag: let ANY connected publishable platform unblock weekly
 * generation + publishing, not just Meta. Default OFF, so a merge deploys dark
 * and live behavior is byte-identical until the flag is set in the host .env.
 *
 * When OFF: the publish gate counts Meta only and synthesis always takes the
 * legacy Meta-primary path. When ON: the gate counts every publishable platform
 * and a tenant with no Meta connection synthesizes primary rows for the
 * platforms it actually has.
 */
export function isAnyPlatformPublishEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_ANY_PLATFORM_PUBLISH_ENABLED);
}

/** The canonical falsy tokens, so an explicit `0`/`false` can never be read as a tenant list. */
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * AA-218 rollout flag: carry the tenant's REAL platforms into the Hermes scope +
 * stage prompts and produce per-platform NATIVE content, instead of one
 * Meta-flavoured caption clamped at the adapter layer. Default OFF.
 *
 * SEPARATE FROM `ARIES_ANY_PLATFORM_PUBLISH_ENABLED` on purpose, even though
 * both were folded into that one flag when AA-218 was rebuilt onto master.
 * They answer different questions:
 *   - ANY_PLATFORM decides ELIGIBILITY — does a non-Meta connection count as a
 *     publishable channel at all, so the tenant gets a week of content and
 *     primary rows on the platforms it actually has.
 *   - This flag decides VOICE — whether the strategy/production/publish PROMPTS
 *     are told the tenant's real platforms, so a LinkedIn post is written as a
 *     LinkedIn post rather than a re-targeted Instagram caption.
 * With this OFF and ANY_PLATFORM ON you get exactly AA-217 behaviour: the rows
 * land on the right platforms, the copy is still Meta-flavoured.
 *
 * TENANT-SCOPABLE — and that is the whole point. This flag changes the STRATEGY,
 * PRODUCTION and PUBLISH prompts, and those prompts are built per run from the
 * one global process env. A plain global `true` would therefore rewrite tenant
 * 15's prompts (live weekly queue) in the same cycle as a tenant-70 canary, so
 * "canary tenant 70, watch tenant 15 is unchanged" would not be guaranteed by
 * construction, only by hope. Accepting a tenant-ID allowlist makes the canary
 * genuinely dark for everyone else.
 *
 * Accepted values:
 *   - unset / `0` / `false` / `no` / `off`  → OFF everywhere (the default).
 *   - `1` / `true` / `yes` / `on`           → ON for EVERY tenant (fleet-wide).
 *   - a CSV of tenant IDs, e.g. `70` or `70,71` → ON for exactly those tenants.
 *
 * `tenantId` is REQUIRED for the allowlist form to match: a caller that cannot
 * name a tenant gets OFF, never "on because the var is non-empty". Note the one
 * ambiguity, deliberately resolved in favour of the repo's flag idiom: the value
 * `1` means fleet-wide, so tenant id 1 cannot be allowlisted on its own (list it
 * alongside another id, or enable fleet-wide).
 */
export function isPlatformNativeContentEnabled(
  env: NodeJS.ProcessEnv = process.env,
  tenantId?: number | string | null,
): boolean {
  const raw = env.ARIES_PLATFORM_NATIVE_CONTENT_ENABLED?.trim().toLowerCase() ?? '';
  if (!raw) return false;
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;

  // Tenant-ID allowlist. Compared as normalized decimal strings so '70', ' 70 '
  // and the numeric 70 all match the same entry.
  const wanted = normalizeTenantIdToken(tenantId);
  if (wanted === null) return false;
  return raw
    .split(',')
    .map((token) => normalizeTenantIdToken(token))
    .some((token) => token !== null && token === wanted);
}

/** Normalize a tenant id (number | numeric string) to its decimal string, or null. */
function normalizeTenantIdToken(value: number | string | null | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/** The per-platform rollout flag that gates each crosspost target. */
export function isCrosspostPlatformFlagEnabled(
  platform: CrosspostPlatform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (platform) {
    case 'x':
      return isXEnabled(env);
    case 'linkedin':
      return isLinkedInEnabled(env);
    case 'reddit':
      return isRedditEnabled(env);
  }
}

/**
 * Config completeness per crosspost platform — the second gate alongside the
 * rollout flag.
 *
 * Reddit publish REQUIRES an explicit target subreddit: the publisher refuses
 * up-front with a `ComposioCapabilityMissingError` when
 * COMPOSIO_REDDIT_TARGET_SUBREDDIT is unset (composio-publisher-provider.ts,
 * the reddit branch). There is deliberately NO `u_<username>` profile fallback
 * — Reddit's `sr` field addresses COMMUNITY names only, so a profile target
 * fails with SUBREDDIT_NOEXIST.
 *
 * Synthesizing reddit rows with no subreddit configured therefore manufactures
 * posts that are GUARANTEED to fail at dispatch: a terminal failure per post,
 * per week, forever. Skipping reddit at the producer instead means no row, no
 * scheduled_posts entry, and no failed-dispatch noise. The same reasoning is
 * why the AA-217 publish gate must not count reddit for an unconfigured
 * deployment: a reddit-only tenant would otherwise pass the gate and every
 * synthesized row would fail terminally.
 *
 * THE REQUIRED ACTION SLUGS ARE THE SAME CLASS OF REQUIREMENT. Composio action
 * slugs are never guessed (see composio-config.ts):
 * they come from `COMPOSIO_<PLATFORM>_PUBLISH_POST_ACTION`, which
 * docker-compose.yml declares with an EMPTY default and `actionSlug()` gives no
 * code fallback. With the slug unset the publisher's `requireSlug` throws
 * `ComposioCapabilityMissingError` on EVERY dispatch — so a deployment that
 * flips `ARIES_LINKEDIN_ENABLED=true` without setting the slug would, under
 * AA-217, let a LinkedIn-only tenant pass the publish gate, synthesize a full
 * week, and have every one of those posts fail terminally. That is precisely
 * the outcome the reddit rationale above calls unacceptable, so the slug is
 * required here rather than only at dispatch time. (Connect-time preflight —
 * capability-preflight.ts `computeCapabilities` — only WARNS about a missing
 * slug; it does not prevent the connection, so slug-less connected rows are
 * reachable state, not a hypothetical.)
 *
 * X additionally needs `COMPOSIO_X_UPLOAD_MEDIA_ACTION`: this eligibility
 * predicate serves the weekly producer, whose X rows always carry a feed image.
 * Counting an X connection
 * without that slug would open the gate onto rows the publisher must reject.
 */
export function isCrosspostPlatformConfigured(
  platform: CrosspostPlatform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (actionSlug(platform, 'publish_post', env) === null) return false;
  if (platform === 'x') return actionSlug(platform, 'upload_media', env) !== null;
  if (platform !== 'reddit') return true;
  return redditTargetSubreddit(env) !== null;
}

/**
 * The crosspost platforms this deployment can deliver to at all: rollout flag ON
 * AND Composio enabled AND required config present. Tenant connection state is
 * NOT considered here — that is the caller's per-tenant query
 * (`resolveCrosspostPlatforms`).
 */
export function eligibleCrosspostPlatforms(
  env: NodeJS.ProcessEnv = process.env,
): CrosspostPlatform[] {
  if (!isComposioEnabled(env)) return [];
  return CROSSPOST_PLATFORMS.filter(
    (p) => isCrosspostPlatformFlagEnabled(p, env) && isCrosspostPlatformConfigured(p, env),
  );
}

/**
 * Every platform a weekly run can actually deliver posts to right now: Meta
 * always, plus each eligible crosspost platform.
 *
 * This is the list the AA-217 publish gate counts connections against, and it
 * is derived from the very same predicates the synthesis fan-out uses — so
 * "the gate passed but nothing could be produced" is structurally impossible.
 * `meta_ads` is deliberately absent (not an organic publish target) and so is
 * `youtube` (no caption adapter and no still→video weekly path; see AA-217).
 */
export function publishablePlatforms(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...META_PUBLISH_PLATFORMS, ...eligibleCrosspostPlatforms(env)];
}

/**
 * Platforms an operator can actually connect right now. The single dormancy
 * chokepoint for flag-gated platforms: when `ARIES_X_ENABLED` is OFF, `'x'` is
 * filtered out everywhere (connect/capabilities/disconnect gate + the UI list),
 * so the platform is byte-for-byte invisible until the flag flips on.
 */
export function connectablePlatforms(
  env: NodeJS.ProcessEnv = process.env,
): readonly IntegrationPlatform[] {
  const excluded = new Set<IntegrationPlatform>();
  if (!isXEnabled(env)) excluded.add('x');
  return INTEGRATION_PLATFORMS.filter((p) => !excluded.has(p));
}

export function publishProviderSelector(env: NodeJS.ProcessEnv = process.env): ProviderSelector {
  return parseSelector(env.PUBLISH_PROVIDER, 'composio');
}

export function analyticsProviderSelector(env: NodeJS.ProcessEnv = process.env): ProviderSelector {
  return parseSelector(env.ANALYTICS_PROVIDER, 'composio');
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
    youtube: env.COMPOSIO_YOUTUBE_AUTH_CONFIG_ID,
    linkedin: env.COMPOSIO_LINKEDIN_AUTH_CONFIG_ID,
    reddit: env.COMPOSIO_REDDIT_AUTH_CONFIG_ID,
    x: env.COMPOSIO_X_AUTH_CONFIG_ID,
  };
  const specific = perPlatform[platform]?.trim();
  if (specific) return specific;
  // reddit + x are toolkit-specific (reddit provisions Composio-managed auth;
  // x needs its own custom OAuth app), so neither may inherit
  // COMPOSIO_DEFAULT_AUTH_CONFIG_ID (typically a Meta-family config) or a
  // connect attempt would target the wrong toolkit (#690).
  if (platform === 'reddit' || platform === 'x') return null;
  return composioDefaultAuthConfigId(env);
}

/**
 * The shared default Composio auth-config id (COMPOSIO_DEFAULT_AUTH_CONFIG_ID),
 * trimmed and normalized to null when unset/blank. This is the auth config that
 * Meta-family platforms (facebook/instagram/meta_ads) fall back to when they
 * have no per-platform id, so several platforms can share it. Single source of
 * truth — the per-platform `composioAuthConfigId` fallback reuses this, and the
 * reconcile path uses it to tell "shared default" (ambiguous, can't disambiguate
 * by auth config) from a "platform-scoped" (toolkit-bound) auth config.
 */
export function composioDefaultAuthConfigId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.COMPOSIO_DEFAULT_AUTH_CONFIG_ID?.trim() || null;
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
