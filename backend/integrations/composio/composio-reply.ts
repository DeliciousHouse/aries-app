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
import { resolveComposioConfig, type ComposioConfig } from './composio-config';
import { createComposioGateway, type ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import { resolveFacebookManagedPage } from './facebook-page-resolver';
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

  // Build the gateway early — needed for both optional page-resolution and the
  // actual reply tool call below.
  const gateway = deps.gateway ?? createComposioGateway(config);

  // FACEBOOK_CREATE_COMMENT requires an explicit `page_id` so Composio knows
  // which Page identity is posting the reply. Without it Composio tries to
  // derive the page id from `object_id`, which it misparses against the
  // comment-id digits and produces the wrong (hyphenated comment-id-as-page-id)
  // value — root cause of #621 502s. Use the tenant's stored connected-account
  // page id; fall back to a live FACEBOOK_LIST_MANAGED_PAGES call when the row
  // was created before connect-time page-resolution was added.
  let fbPageId: string | null = null;
  if (provider === 'facebook') {
    fbPageId = conn.externalAccountId ?? null;
    if (!fbPageId) {
      // externalAccountId not populated at connect time — resolve it now.
      try {
        const page = await resolveFacebookManagedPage(gateway, config, conn.connectedAccountId!);
        fbPageId = page?.pageId ?? null;
      } catch {
        // fall through to the guard below
      }
    }
    if (!fbPageId) {
      throw new MetaPublishError(
        'fb_page_id_missing',
        'Could not resolve the connected Facebook Page id. Reconnect the Facebook account to refresh the page.',
        { status: 409 },
      );
    }
  }

  let result;
  try {
    result = await gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId,
      // object_id = the stored comment's full graph id (pageId_postId_commentId);
      // FACEBOOK_CREATE_COMMENT replies to a comment when given a comment id.
      // page_id = the tenant's connected FB Page — required so Composio posts
      // the reply as the Page, not a personal profile, and does not misparse
      // the comment id as a page id (see #621).
      arguments: {
        object_id: req.externalCommentId,
        message,
        ...(fbPageId ? { page_id: fbPageId } : {}),
      },
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
