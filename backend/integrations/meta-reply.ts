/**
 * Native comment reply to Meta (qa-defect #598).
 *
 * Posts a PUBLIC operator reply to a stored social comment via the Meta Graph
 * API — Instagram `POST /{ig-comment-id}/replies`, Facebook
 * `POST /{comment-id}/comments`. This is the public-comment reply surface, NOT
 * the FB private_replies / Messenger path.
 *
 * The token retrieval, Graph transport (urlencoded POST + 429 backoff + network
 * /HTTP error taxonomy), and the outcome-unknown classification are reused from
 * `meta-publishing.ts` so a reply inherits the exact same claim/rollback and
 * never-auto-retry-an-unconfirmed-write semantics as the publish path: a 2xx
 * response with no reply id is `outcomeUnknown` (the reply MAY be live) and must
 * never be auto-retried.
 *
 * Requires the `instagram_manage_comments` (IG) / `pages_manage_engagement` (FB)
 * Graph scopes; those are requested in `provider-registry.ts` but inert until
 * App Review grants them.
 */
import {
  MetaPublishError,
  normalizeMetaProvider,
  requestGraphJson,
  requireStringField,
  type SupportedMetaProvider,
} from './meta-publishing';
import { getDecryptedAccessTokenContextForTenantProvider } from './oauth-credentials';

export type MetaReplyRequest = {
  tenantId: string;
  provider: string;
  externalCommentId: string;
  /**
   * The parent post's external id (insights_posts.external_post_id). Used ONLY by
   * the Composio LinkedIn reply path as the `object` (share/ugcPost URN) the reply
   * is attached to. The direct-Graph Meta reply (this module) and the other
   * Composio reply platforms ignore it. Optional + nullable so existing callers
   * are unaffected.
   */
  externalPostId?: string | null;
  message: string;
  fetchImpl?: typeof fetch;
};

export type MetaReplySuccess = {
  provider: SupportedMetaProvider;
  platformReplyId: string;
  connectionId: string;
};

/**
 * Post a public reply to a single Meta comment. Throws a `MetaPublishError` on
 * every failure path (unsupported provider, empty text, missing token, Graph
 * HTTP/network failure, or a 2xx with no reply id). Resolves only on a confirmed
 * reply id.
 */
export async function replyToComment(req: MetaReplyRequest): Promise<MetaReplySuccess> {
  // 1. Provider gate first — youtube/etc. throw `unsupported_provider` (400)
  //    before any token lookup or Graph call.
  const provider = normalizeMetaProvider(req.provider);

  // 2. Reply text is required.
  const message = req.message.trim();
  if (message.length === 0) {
    throw new MetaPublishError('missing_reply_text', '`reply_text` is required.', { status: 400 });
  }

  // 3. Resolve the tenant's connected token (access token only — a comment reply
  //    targets the stored comment id directly, so the page/account id is not
  //    needed).
  const handle = await getDecryptedAccessTokenContextForTenantProvider(req.tenantId, provider);
  if (!handle?.accessToken) {
    throw new MetaPublishError(
      'oauth_token_missing',
      `No connected ${provider} token is available for this tenant.`,
      { status: 409 },
    );
  }

  // 4. IG replies to a comment via /{comment}/replies; FB via /{comment}/comments.
  const pathname =
    provider === 'instagram'
      ? `${encodeURIComponent(req.externalCommentId)}/replies`
      : `${encodeURIComponent(req.externalCommentId)}/comments`;

  // 5. One-shot reply POST. Reuses the publish transport (429 backoff + error
  //    taxonomy). The reply endpoint has no idempotency key, so a 2xx with no id
  //    is outcome-unknown (see step 6).
  const resp = await requestGraphJson({
    pathname,
    params: { message },
    accessToken: handle.accessToken,
    fetchImpl: req.fetchImpl ?? globalThis.fetch,
    method: 'POST',
  });

  // 6. A 2xx with no reply id means the reply MAY be live but is unconfirmed —
  //    flag outcomeUnknown so the caller leaves the claim in place and never
  //    auto-retries (a retry of a reply that secretly succeeded is a duplicate).
  const platformReplyId = requireStringField(resp, 'id', `${provider}_reply_missing_id`, {
    outcomeUnknown: true,
  });

  return { provider, platformReplyId, connectionId: handle.connectionId };
}
