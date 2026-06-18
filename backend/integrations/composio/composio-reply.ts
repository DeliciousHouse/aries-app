/**
 * Composio-routed native comment reply (#598 / gate-5).
 *
 * Avoids Meta App Review (the direct-Graph reply needs pages_manage_engagement /
 * instagram_manage_comments, which are App-Review-gated) by posting the reply
 * through Composio's verified FACEBOOK_CREATE_COMMENT action — "Creates a comment
 * on a Facebook post or replies to an existing comment" — passing the stored
 * comment's full graph id as `object_id` and the operator text as `message`.
 *
 * This is the Composio counterpart of backend/integrations/meta-reply.ts. It
 * returns the SAME `MetaReplySuccess` shape and throws the SAME `MetaPublishError`
 * taxonomy so the reply handler's claim/rollback/outcome-unknown logic is reused
 * unchanged:
 *   - Composio success (successful + comment id) -> { platformReplyId } (stamp).
 *   - Composio explicit failure (successful:false) -> MetaPublishError (definite
 *     never-created) -> handler rolls the claim back, safe to retry.
 *   - transport/unknown OR 2xx-without-id -> MetaPublishError{outcomeUnknown}
 *     -> handler leaves the claim, surfaces needs_manual_reconciliation, NEVER
 *     auto-retries (a retry of a reply that secretly posted is a duplicate).
 *
 * Routing: only Facebook is wired here (the verified Composio action). Instagram
 * comment-reply via Composio has no verified action, so an IG reply stays on the
 * direct path even under PUBLISH_PROVIDER=composio (see shouldUseComposioReply).
 */

import { MetaPublishError, normalizeMetaProvider } from '../meta-publishing';
import type { MetaReplyRequest, MetaReplySuccess } from '../meta-reply';
import { effectivePublishProvider } from '../providers/provider-factory';
import {
  isXEnabled,
  isYouTubeEnabled,
  isRedditEnabled,
  isLinkedInEnabled,
} from '../providers/integration-config';
import type { IntegrationPlatform } from '../providers/types';
import { resolveComposioConfig, type ComposioConfig } from './composio-config';
import { createComposioGateway, type ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import pool from '@/lib/db';

type Env = Partial<Record<string, string | undefined>>;

/** Verified default; overridable via COMPOSIO_FACEBOOK_REPLY_COMMENT_ACTION. */
export const DEFAULT_FB_CREATE_COMMENT_SLUG = 'FACEBOOK_CREATE_COMMENT';

export interface ComposioReplyDeps {
  gateway?: ComposioGateway;
  config?: ComposioConfig | null;
  db?: Queryable;
}

/**
 * True when an operator reply should be routed through Composio instead of the
 * direct Graph path. Mirrors how publishing chooses its provider
 * (effectivePublishProvider === 'composio', which already honors the
 * COMPOSIO_ENABLED master switch). Scoped to Facebook — the only platform with a
 * verified Composio reply action.
 */
export function shouldUseComposioReply(platform: string, env: Env = process.env): boolean {
  return platform === 'facebook' && effectivePublishProvider(env as NodeJS.ProcessEnv) === 'composio';
}

/** Created comment id lands at data.id (or one nested data wrap). */
function extractCreatedCommentId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const direct = obj.id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const nested = obj.data;
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

/**
 * Facebook comment ids stored by the sync adapter are in the compound format
 * "{post_story_fbid}_{comment_id}" returned by FACEBOOK_GET_COMMENTS. Composio's
 * FACEBOOK_CREATE_COMMENT derives the acting Page from the FIRST "_"-delimited
 * segment of object_id and ignores any explicit page_id argument. Passing the
 * compound id therefore causes it to misparse the post_story_fbid as the page id
 * (root cause of #621 502s). The correct object_id for a reply is just the
 * trailing comment-own id — the segment after the last "_". A single-segment
 * (non-compound) id is returned as-is.
 */
function replyTargetCommentId(externalCommentId: string): string {
  const lastUnderscore = externalCommentId.lastIndexOf('_');
  return lastUnderscore >= 0 ? externalCommentId.slice(lastUnderscore + 1) : externalCommentId;
}

/**
 * Post a public reply to a single comment via Composio. Resolves only on a
 * confirmed comment id; otherwise throws a MetaPublishError whose outcomeUnknown
 * flag drives the handler's rollback decision (see module header).
 */
export async function replyToCommentViaComposio(
  req: MetaReplyRequest,
  env: Env = process.env,
  deps: ComposioReplyDeps = {},
): Promise<MetaReplySuccess> {
  // Provider gate first (throws unsupported_provider for non-Meta).
  const provider = normalizeMetaProvider(req.provider);

  const message = req.message.trim();
  if (message.length === 0) {
    throw new MetaPublishError('missing_reply_text', '`reply_text` is required.', { status: 400 });
  }

  const config = deps.config !== undefined ? deps.config : resolveComposioConfig(env as NodeJS.ProcessEnv);
  if (!config) {
    throw new MetaPublishError('oauth_token_missing', 'Composio is not configured (no API key).', { status: 409 });
  }

  const db = deps.db ?? pool;
  const conn = await getConnectionRow(req.tenantId, provider, db);
  if (!conn || conn.status !== 'connected' || !conn.connectedAccountId) {
    // Definite never-created (auth) -> handler rolls back + surfaces reconnect.
    throw new MetaPublishError(
      'oauth_token_missing',
      `No connected ${provider} account is available for this tenant.`,
      { status: 409 },
    );
  }

  // Verified default applies to Facebook only; an env override can extend it.
  const slug =
    config.actionSlugFor(provider, 'reply_comment') ??
    (provider === 'facebook' ? DEFAULT_FB_CREATE_COMMENT_SLUG : null);
  if (!slug) {
    throw new MetaPublishError(
      'reply_not_supported',
      `Composio reply is not configured for ${provider}.`,
      { status: 422 },
    );
  }

  const gateway = deps.gateway ?? createComposioGateway(config);

  let result;
  try {
    result = await gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId,
      // object_id = the trailing comment-own id — NOT the compound form stored
      // in external_comment_id ("{post_story_fbid}_{comment_id}"). Composio
      // derives the acting Page from the first "_"-delimited segment of
      // object_id and ignores any explicit page_id argument, so passing the
      // compound id causes it to misparse the post_story_fbid as the page id
      // (root cause of #621). Stripping to the trailing segment is the correct
      // reply-target id for FACEBOOK_CREATE_COMMENT. See live probe notes in PR.
      arguments: { object_id: replyTargetCommentId(req.externalCommentId), message },
    });
  } catch (err) {
    // Transport/unknown: the reply MAY have reached Meta — treat as outcome
    // unknown so the handler keeps the claim and never auto-retries.
    throw new MetaPublishError(
      'composio_reply_unconfirmed',
      `Composio reply transport error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502, outcomeUnknown: true },
    );
  }

  if (!result.successful) {
    // Explicit tool failure -> the comment was not created -> safe to roll back.
    throw new MetaPublishError(
      'composio_reply_failed',
      result.error ?? 'Composio reply tool reported unsuccessful.',
      { status: 502, retryable: false },
    );
  }

  const platformReplyId = extractCreatedCommentId(result.data);
  if (!platformReplyId) {
    // 2xx with no id -> unconfirmed, never auto-retry.
    throw new MetaPublishError(
      'composio_reply_missing_id',
      'Composio accepted the reply but returned no comment id.',
      { status: 502, outcomeUnknown: true },
    );
  }

  return { provider, platformReplyId, connectionId: conn.connectedAccountId };
}

// ---------------------------------------------------------------------------
// New-platform native reply (#634: X / YouTube / Reddit / LinkedIn).
//
// These platforms have NO direct-Graph reply path — Composio is the only reply
// transport — so admission is gated solely by the platform's own rollout flag
// (ARIES_<P>_ENABLED) PLUS the master ARIES_NATIVE_REPLY_ENABLED gate in the
// route handler. They deliberately do NOT route through isMetaProvider /
// normalizeMetaProvider (those stay Facebook/Instagram-only); the connection is
// loaded by the RAW Aries platform key (e.g. 'x', whose Composio toolkit is
// 'twitter'). Every failure throws the SAME MetaPublishError taxonomy as the FB
// reply above so the route handler's claim/rollback/outcome-unknown logic is
// reused verbatim — see module header.
// ---------------------------------------------------------------------------

/** Result of a new-platform Composio reply. No `provider` field — the handler
 *  reads only `.platformReplyId` (and stamps `.connectionId` is unused here). */
export type ComposioPlatformReplyResult = {
  platformReplyId: string;
  connectionId: string;
};

/**
 * Verified-default reply action slug per non-Meta platform. Overridable via
 * COMPOSIO_<PLATFORM>_REPLY_COMMENT_ACTION (the generic actionEnvKey). Sourced
 * from the verified Composio catalog (2026-06-18):
 *   x        -> TWITTER_CREATION_OF_A_POST   (reply = create-post + in-reply-to)
 *   youtube  -> YOUTUBE_CREATE_COMMENT_REPLY (parentId + textOriginal)
 *   reddit   -> REDDIT_POST_REDDIT_COMMENT   (thing_id t1_<id> + text)
 *   linkedin -> LINKEDIN_CREATE_COMMENT_ON_POST (actor + object + message.text)
 */
export const DEFAULT_COMPOSIO_REPLY_SLUG: Readonly<Record<string, string>> = {
  x: 'TWITTER_CREATION_OF_A_POST',
  youtube: 'YOUTUBE_CREATE_COMMENT_REPLY',
  reddit: 'REDDIT_POST_REDDIT_COMMENT',
  linkedin: 'LINKEDIN_CREATE_COMMENT_ON_POST',
};

/** LinkedIn comment `message.text` cap (1250). Mirrors linkedinCommentary's
 *  ellipsis idiom (single `…` glyph counted within the cap). */
const LINKEDIN_COMMENT_MAX = 1250;
function clampLinkedIn(text: string, max: number = LINKEDIN_COMMENT_MAX): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Reddit's reply target `thing_id` must be a `t1_<base36>` comment fullname. The
 * adapter stores the fullname (`comment.name`, already `t1_<id>`) and falls back
 * to the bare base36 id only when `name` is absent — so prefix the bare form but
 * NEVER double-prefix an already-`t1_` id.
 */
function redditThingId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('t1_') ? trimmed : `t1_${trimmed}`;
}

/** A transport error that means Reddit rate-limited/cooled-down the write — the
 *  comment was DEFINITELY never created, so it is safe to roll back + re-attempt
 *  (unlike a generic transport drop, which is outcome-unknown). */
function isRedditRateLimit(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /\b429\b/.test(msg) ||
    msg.includes('rate limit') ||
    msg.includes('ratelimit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many requests') ||
    msg.includes('cooldown') ||
    msg.includes('try again later')
  );
}

/**
 * Pull a created-reply id from a loosely-typed tool result, trying each candidate
 * key in order and looking one `data` wrap deep (Composio sometimes nests the
 * payload under `data`). Shared shape — the per-platform `idKeys` differ.
 */
function pickId(data: unknown, keys: readonly string[]): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const nested = obj.data;
  if (nested && typeof nested === 'object') {
    const n = nested as Record<string, unknown>;
    for (const key of keys) {
      const v = n[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * True when an operator reply for one of the new (non-Meta) platforms should be
 * routed through Composio. Admission is the platform's OWN rollout flag only —
 * there is no direct path to fall back to, and the master ARIES_NATIVE_REPLY_ENABLED
 * gate is enforced earlier in the route handler. NOT a provider-selector check
 * (unlike shouldUseComposioReply for FB) — these platforms have no PUBLISH_PROVIDER
 * axis.
 */
export function isComposioReplyPlatform(platform: string, env: Env = process.env): boolean {
  const p = platform.trim().toLowerCase();
  const e = env as NodeJS.ProcessEnv;
  switch (p) {
    case 'x':
      return isXEnabled(e);
    case 'youtube':
      return isYouTubeEnabled(e);
    case 'reddit':
      return isRedditEnabled(e);
    case 'linkedin':
      return isLinkedInEnabled(e);
    default:
      return false;
  }
}

/**
 * Post a public reply to a stored comment on X / YouTube / Reddit / LinkedIn via
 * Composio. Mirrors replyToCommentViaComposio's dispatch structure (config →
 * connection → slug → executeTool, classified into the MetaPublishError taxonomy)
 * but with per-platform args + id-extraction keys. Resolves only on a confirmed
 * reply id; every other path throws — see module header for how each maps to the
 * handler's claim/rollback/outcome-unknown decision.
 */
export async function replyToCommentViaComposioForPlatform(
  req: MetaReplyRequest,
  platform: string,
  env: Env = process.env,
  deps: ComposioReplyDeps = {},
): Promise<ComposioPlatformReplyResult> {
  const p = platform.trim().toLowerCase();

  const message = req.message.trim();
  if (message.length === 0) {
    throw new MetaPublishError('missing_reply_text', '`reply_text` is required.', { status: 400 });
  }

  const config = deps.config !== undefined ? deps.config : resolveComposioConfig(env as NodeJS.ProcessEnv);
  if (!config) {
    throw new MetaPublishError('oauth_token_missing', 'Composio is not configured (no API key).', { status: 409 });
  }

  const db = deps.db ?? pool;
  // RAW Aries platform key — NO normalizeMetaProvider (these are non-Meta
  // toolkits; e.g. 'x' maps to the Composio 'twitter' toolkit internally).
  const conn = await getConnectionRow(req.tenantId, p as IntegrationPlatform, db);
  if (!conn || conn.status !== 'connected' || !conn.connectedAccountId) {
    // Definite never-created (auth) -> handler rolls back + surfaces reconnect.
    throw new MetaPublishError(
      'oauth_token_missing',
      `No connected ${p} account is available for this tenant.`,
      { status: 409 },
    );
  }

  // Env override wins; else the verified-default slug. Null => not configured.
  const slug =
    config.actionSlugFor(p as IntegrationPlatform, 'reply_comment') ??
    (DEFAULT_COMPOSIO_REPLY_SLUG[p] ?? null);
  if (!slug) {
    throw new MetaPublishError(
      'reply_not_supported',
      `Composio reply is not configured for ${p}.`,
      { status: 422 },
    );
  }

  const externalCommentId = req.externalCommentId;
  let args: Record<string, unknown>;
  let idKeys: readonly string[];
  switch (p) {
    case 'x':
      // Reply = create-post with in-reply-to (no separate reply action).
      args = { text: message, reply_in_reply_to_tweet_id: externalCommentId };
      idKeys = ['id'];
      break;
    case 'youtube':
      args = { parentId: externalCommentId, textOriginal: message };
      idKeys = ['id'];
      break;
    case 'reddit':
      // thing_id must be the t1_<id> comment fullname (never double-prefixed).
      args = { thing_id: redditThingId(externalCommentId), text: message };
      idKeys = ['name', 'id'];
      break;
    case 'linkedin': {
      // actor = the resolved author URN persisted at connect into
      // connected_accounts.external_account_id (#645). Missing => reconnect
      // (definitely-never-posted -> rollback), mirroring the publish path.
      const actor = conn.externalAccountId?.trim() || null;
      if (!actor) {
        throw new MetaPublishError(
          'oauth_token_missing',
          'No LinkedIn author URN is available for this tenant; reconnect LinkedIn.',
          { status: 409 },
        );
      }
      // object = the parent post's share/ugcPost URN (insights_posts.external_post_id,
      // threaded through req.externalPostId from the handler JOIN). Without it the
      // reply has no target -> reply_not_supported (definitely-never-posted).
      const object = req.externalPostId?.trim() || null;
      if (!object) {
        throw new MetaPublishError(
          'reply_not_supported',
          'No LinkedIn post URN is available for this comment.',
          { status: 422 },
        );
      }
      // parentComment nests the reply under the comment being replied to (its
      // URN = the stored external_comment_id). LinkedIn comments are not yet
      // ingested (#648), so in practice this path is dormant until they are.
      const commentUrn = externalCommentId?.trim() || null;
      args = {
        actor,
        object,
        message: { text: clampLinkedIn(message) },
        ...(commentUrn ? { parentComment: commentUrn } : {}),
      };
      idKeys = ['commentUrn', 'id', 'urn'];
      break;
    }
    default:
      // isComposioReplyPlatform admitted only x/youtube/reddit/linkedin; any
      // other value is a programming error, surfaced as not-supported.
      throw new MetaPublishError(
        'reply_not_supported',
        `Composio reply is not supported for ${p}.`,
        { status: 422 },
      );
  }

  const gateway = deps.gateway ?? createComposioGateway(config);

  let result;
  try {
    result = await gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId,
      arguments: args,
    });
  } catch (err) {
    // Reddit divergence: a rate-limit/cooldown/429 is the API REJECTING the write
    // — the comment was definitely never created, so roll back and allow a safe
    // re-attempt (retryable, NOT outcome-unknown). A successful:false rate-limit
    // is already handled as never-created below.
    if (p === 'reddit' && isRedditRateLimit(err)) {
      throw new MetaPublishError(
        'composio_reply_rate_limited',
        `Composio Reddit reply rate-limited: ${err instanceof Error ? err.message : String(err)}`,
        { status: 429, retryable: true },
      );
    }
    // Any other transport drop: the reply MAY have reached the platform — treat
    // as outcome unknown so the handler keeps the claim and never auto-retries.
    throw new MetaPublishError(
      'composio_reply_unconfirmed',
      `Composio reply transport error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502, outcomeUnknown: true },
    );
  }

  if (!result.successful) {
    // Explicit tool failure -> the reply was not created -> safe to roll back.
    throw new MetaPublishError(
      'composio_reply_failed',
      result.error ?? 'Composio reply tool reported unsuccessful.',
      { status: 502, retryable: false },
    );
  }

  const platformReplyId = pickId(result.data, idKeys);
  if (!platformReplyId) {
    // 2xx with no id -> unconfirmed, never auto-retry.
    throw new MetaPublishError(
      'composio_reply_missing_id',
      'Composio accepted the reply but returned no reply id.',
      { status: 502, outcomeUnknown: true },
    );
  }

  return { platformReplyId, connectionId: conn.connectedAccountId };
}
