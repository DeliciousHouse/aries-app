import type { Pool } from 'pg';

import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { isNativeReplyEnabled } from '@/backend/integrations/meta-reply-env';
import { replyToComment, type MetaReplyRequest, type MetaReplySuccess } from '@/backend/integrations/meta-reply';
import {
  replyToCommentViaComposio,
  replyToCommentViaComposioForPlatform,
  shouldUseComposioReply,
  isComposioReplyPlatform,
} from '@/backend/integrations/composio/composio-reply';
import {
  classifyMetaPublishFailure,
  classifyMetaPublishFailureKind,
  isMetaProvider,
  MetaPublishError,
} from '@/backend/integrations/meta-publishing';

/**
 * POST /api/insights/comments/[commentId]/reply
 *
 * Post an operator reply to a stored social comment. `[commentId]` is the
 * internal `insights_comments.id` returned by the comments list endpoint.
 *
 * Flag-gated behind ARIES_NATIVE_REPLY_ENABLED (default OFF → a real 404).
 * Tenant-isolated and idempotent: the row is claimed (is_replied false->true)
 * BEFORE the Graph call so a concurrent/duplicate request never double-posts,
 * and the claim is rolled back only when the reply definitely never posted —
 * exactly the publish path's claim/rollback/outcome-unknown semantics. The
 * Graph call runs OUTSIDE any held pool client (independent pool.query before
 * and after). Responses are frontend-safe only (never the token or raw Graph
 * error body).
 */

type ReplyBody = { reply_text?: string };

type ReplyDeps = {
  tenantContextLoader?: TenantContextLoader;
  db?: Pool;
  fetchImpl?: typeof fetch;
  env?: Partial<Record<string, string | undefined>>;
  /** Test seam for the Composio reply path (default: replyToCommentViaComposio). */
  composioReply?: (req: MetaReplyRequest) => Promise<MetaReplySuccess>;
};

// Generous ceiling — IG/FB comment bodies are far shorter, but reject obviously
// abusive payloads before the Graph round-trip.
const MAX_REPLY_LENGTH = 8000;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readReplyBody(req: Request): Promise<ReplyBody> {
  try {
    return (await req.json()) as ReplyBody;
  } catch {
    return {};
  }
}

export async function handleReplyToComment(
  req: Request,
  commentIdRaw: string,
  deps: ReplyDeps = {},
): Promise<Response> {
  // (a) Flag gate FIRST. When OFF the route is invisible — a real 404, with no
  // DB and no Graph traffic. Do not touch deps.db / deps.fetchImpl here.
  if (!isNativeReplyEnabled(deps.env)) {
    return json({ status: 'error', reason: 'not_found' }, 404);
  }

  // (b) Tenant context (403 on no membership).
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = Number(tenantResult.tenantContext.tenantId);

  const commentId = Number.parseInt(commentIdRaw, 10);
  if (!Number.isFinite(commentId) || commentId < 1) {
    // A non-numeric comment id can never match a row — treat as not-found.
    return json({ status: 'error', reason: 'not_found' }, 404);
  }

  // (c) Body + reply-text validation.
  const body = await readReplyBody(req);
  const message = (body.reply_text ?? '').trim();
  if (message.length === 0) {
    return json(
      { status: 'error', reason: 'missing_reply_text', message: '`reply_text` is required.' },
      400,
    );
  }
  if (message.length > MAX_REPLY_LENGTH) {
    return json(
      {
        status: 'error',
        reason: 'reply_too_long',
        message: `Reply text exceeds the ${MAX_REPLY_LENGTH}-character limit.`,
      },
      422,
    );
  }

  const db = deps.db ?? pool;

  // (d) Load the comment tenant-scoped. 0 rows covers BOTH not-found and
  // cross-tenant (tenant isolation) — never disclose another tenant's comment.
  const loaded = await db.query<{
    id: string | number;
    platform: string;
    external_comment_id: string;
    external_post_id: string;
    is_replied: boolean;
  }>(
    // INNER JOIN insights_posts to also pull the parent post's external id. Every
    // comment has a NOT NULL post_id -> insights_posts(id), so the join never
    // drops a row. external_post_id is the LinkedIn reply `object` (share/ugcPost
    // URN); harmless/ignored for FB/IG/X/YouTube/Reddit.
    `SELECT c.id, c.platform, c.external_comment_id, c.is_replied, p.external_post_id
     FROM insights_comments c
     INNER JOIN insights_posts p ON p.id = c.post_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [commentId, tenantId],
  );
  const comment = loaded.rows[0];
  if (!comment) {
    return json({ status: 'error', reason: 'not_found' }, 404);
  }
  if (comment.is_replied) {
    // Already replied — idempotent no-op, no Graph call.
    return json({ status: 'already_replied', comment_id: commentId }, 200);
  }

  // (e) Provider guard — Meta (IG/FB) on the direct/Composio-FB path, or one of
  // the new Composio-only platforms (X/YouTube/Reddit/LinkedIn) when ITS rollout
  // flag is on. Each new platform stays invisible (422 reply_not_supported,
  // byte-identical to a Meta-platform reject) until its ARIES_<P>_ENABLED flips.
  const platform = comment.platform;
  if (!isMetaProvider(platform) && !isComposioReplyPlatform(platform, deps.env)) {
    return json(
      {
        status: 'error',
        reason: 'reply_not_supported',
        message: `Replies are not supported for platform '${platform}'.`,
      },
      422,
    );
  }

  // (f) Pre-claim (concurrency idempotency): atomically flip is_replied
  // false->true BEFORE the Graph call, mirroring the publish path's
  // consume-before-publish. A lost race (0 rows) means another request already
  // claimed it — return already_replied rather than double-posting.
  const claim = await db.query<{ id: string | number }>(
    `UPDATE insights_comments
     SET is_replied = true
     WHERE id = $1 AND tenant_id = $2 AND is_replied = false
     RETURNING id`,
    [commentId, tenantId],
  );
  if (claim.rows.length === 0) {
    return json({ status: 'already_replied', comment_id: commentId }, 200);
  }

  // (g) Graph call OUTSIDE any held pool client (the queries above/below are
  // independent pool.query calls — no client is checked out across the Graph
  // round-trip).
  //
  // `replySucceeded` latches the instant the reply is live on the platform
  // (mirrors publish-instagram's `publishSucceeded`). Once true, the claim must
  // NEVER be rolled back: the pre-claim already set is_replied=true, so undoing
  // it would falsely un-reply a live reply and a retry would double-post.
  // Provider routing: post via Composio when the active publish provider is
  // Composio (FB only — the verified Composio reply action), which needs no Meta
  // App Review; otherwise the existing direct-Graph path. Both surface the same
  // MetaReplySuccess / MetaPublishError contract so the claim/rollback/
  // outcome-unknown handling below is identical.
  const replyRequest: MetaReplyRequest = {
    tenantId: String(tenantId),
    provider: platform,
    externalCommentId: comment.external_comment_id,
    externalPostId: comment.external_post_id,
    message,
  };
  const useComposioReply = shouldUseComposioReply(platform, deps.env);

  let replySucceeded = false;
  try {
    // New Composio-only platforms (X/YouTube/Reddit/LinkedIn) route through the
    // per-platform Composio reply; the FB/IG branch below is UNCHANGED. Every
    // path returns a { platformReplyId } and throws the same MetaPublishError
    // taxonomy, so the claim/rollback/outcome-unknown handling is identical.
    const published = isComposioReplyPlatform(platform, deps.env)
      ? await replyToCommentViaComposioForPlatform(replyRequest, platform, deps.env, { db: deps.db })
      : useComposioReply
        ? await (deps.composioReply
            ? deps.composioReply(replyRequest)
            : replyToCommentViaComposio(replyRequest, deps.env, { db: deps.db }))
        : await replyToComment({ ...replyRequest, fetchImpl: deps.fetchImpl });
    replySucceeded = true;

    // (h) Confirmed success — record the platform reply id + delivery stamp.
    // Best-effort: the reply is already live and is_replied is already true (the
    // no-duplicate invariant holds), so a stamp failure must NOT roll the claim
    // back. We just couldn't persist the reply id — report success regardless.
    let repliedAt = new Date().toISOString();
    try {
      const stamped = await db.query<{ replied_at: string | Date }>(
        `UPDATE insights_comments
         SET platform_reply_id = $1, replied_at = now()
         WHERE id = $2 AND tenant_id = $3
         RETURNING replied_at`,
        [published.platformReplyId, commentId, tenantId],
      );
      const repliedAtRaw = stamped.rows[0]?.replied_at;
      if (repliedAtRaw) {
        repliedAt = repliedAtRaw instanceof Date ? repliedAtRaw.toISOString() : String(repliedAtRaw);
      }
    } catch (stampError) {
      // The reply IS live; we only failed to record its id/timestamp. Leave
      // is_replied=true and surface success — never roll back here.
      console.warn('[insights-reply] reply posted but recording its id failed (is_replied stays true)', {
        commentId,
        tenantId,
        error: String((stampError as Error)?.message ?? stampError),
      });
    }

    return json(
      {
        status: 'replied',
        comment_id: commentId,
        platform_reply_id: published.platformReplyId,
        replied_at: repliedAt,
      },
      200,
    );
  } catch (error) {
    // Two outcome classes need opposite handling (mirrors publish-instagram):
    //
    //   "Outcome unknown" — *_reply_missing_id: the Graph reply was accepted
    //   (2xx) but Aries got no reply id back. The reply MAY be live. LEAVE the
    //   claim (is_replied=true) in place, surface needs_manual_reconciliation,
    //   and NEVER auto-retry — a retry of a reply that secretly succeeded is a
    //   duplicate reply.
    //
    //   "Definitely never posted" — a network/HTTP/4xx failure. The reply never
    //   posted, so roll back the claim and let a retry re-attempt it.
    const outcomeUnknown = classifyMetaPublishFailure(error) === 'outcome_unknown';

    if (outcomeUnknown) {
      const metaErr = error as MetaPublishError;
      console.warn('[insights-reply] reply outcome unknown — needs manual reconciliation', {
        commentId,
        tenantId,
        code: metaErr.code,
      });
      return json(
        {
          status: 'needs_manual_reconciliation',
          code: metaErr.code,
          reason: metaErr.code,
          message: `${metaErr.message} The reply was accepted but its id could not be confirmed; verify on the platform before any retry — Aries will not auto-retry this reply.`,
          retryable: false,
        },
        502,
      );
    }

    // Definitely never posted — roll back the claim so a retry can re-attempt.
    // Guarded by !replySucceeded: a confirmed-live reply is never un-claimed
    // (a stamp failure is handled in the success branch and never reaches here,
    // so this is defense in depth against any future code between post + return).
    if (!replySucceeded) {
      try {
        await db.query(
          `UPDATE insights_comments
           SET is_replied = false, platform_reply_id = NULL
           WHERE id = $1 AND tenant_id = $2`,
          [commentId, tenantId],
        );
      } catch (rollbackError) {
        // Best-effort rollback; surface the original error regardless. Log loudly
        // — a swallowed failure here leaves the comment falsely marked replied.
        console.warn('[insights-reply] reply claim rollback failed', {
          commentId,
          tenantId,
          error: String((rollbackError as Error)?.message ?? rollbackError),
        });
      }
    }

    if (error instanceof MetaPublishError && classifyMetaPublishFailureKind(error) === 'auth') {
      // The tenant's Meta connection is missing/expired — operator-actionable.
      return json(
        {
          status: 'error',
          reason: 'needs_reconnect',
          code: error.code,
          message: `${error.message} Reconnect your Instagram/Meta account to resume replying.`,
          retryable: false,
        },
        error.status,
      );
    }

    if (error instanceof MetaPublishError) {
      return json(
        {
          status: 'error',
          code: error.code,
          reason: error.code,
          message: error.message,
          retryable: error.retryable,
        },
        error.status,
      );
    }

    return json(
      {
        status: 'error',
        code: 'reply_failed',
        reason: 'reply_failed',
        message: 'An unexpected error occurred',
        retryable: false,
      },
      500,
    );
  }
}
