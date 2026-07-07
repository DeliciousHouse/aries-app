/**
 * Composio PublisherProvider (Phase 7).
 *
 * Hard rules enforced here:
 *  - Ads/campaigns are ALWAYS created PAUSED/draft. publishAd forces a PAUSED
 *    status argument and never reports anything but `paused`/`draft`.
 *  - Organic posts support dry-run-first (no side effect) and refuse a live
 *    post unless `approved: true` was set by an already-cleared Aries approval.
 *  - Operations whose action slug is not configured are refused with a clear
 *    capability error — never executed against a guessed slug.
 */

import type { PublisherProvider } from '../providers/interfaces';
import {
  isIntegrationPlatform,
  type GetPublishStatusInput,
  type IntegrationPlatform,
  type PublishAdInput,
  type PublishPostInput,
  type PublishResult,
  type UploadMediaInput,
  type UploadMediaResult,
} from '../providers/types';
import { PublishGuardError } from '../providers/errors';
import { redditTargetSubreddit } from '../providers/integration-config';
import type { ComposioConfig, ComposioOperation } from './composio-config';
import type { ComposioFileDescriptor, ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
} from './errors';
import { resolveFacebookManagedPage } from './facebook-page-resolver';
import { resolveInstagramAccount } from './instagram-account-resolver';
import { synthesizeStillToVideo, type StillToVideoResult } from '../still-to-video';
import { MetaPublishError } from '../meta-publishing';
import {
  validateMediaForSurface,
  type MediaMetadata,
  type MediaSurface,
  type MediaType,
} from '../meta-media-validation';
import pool from '@/lib/db';

function pickId(data: unknown, keys: string[]): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  // Some tools nest the payload under data/response/result, and Reddit nests the
  // created object under `json` (data.json.data.name → the t3_ fullname).
  // YouTube nests the created object under `video` (data.video.id → the videoId).
  for (const nestKey of ['data', 'response', 'result', 'json', 'video']) {
    const nested = obj[nestKey];
    if (nested && typeof nested === 'object') {
      const found = pickId(nested, keys);
      if (found) return found;
    }
  }
  return null;
}

function pickUrl(data: unknown): string | null {
  return pickId(data, ['permalink', 'permalink_url', 'url', 'link']);
}

/** The id keys used for the shared post-id extraction unless a branch overrides. */
const DEFAULT_POST_ID_KEYS = ['post_id', 'id', 'media_id'];

const REDDIT_TITLE_MAX = 300;
const REDDIT_FALLBACK_TITLE = 'New post';

/**
 * Reddit requires a non-empty `title` (it rejects an empty one) ≤ 300 chars. Take
 * the first non-empty line of the post content, collapse internal whitespace, and
 * truncate with an ellipsis. Falls back to a stable label when content is empty.
 * Pure — no I/O — so it is trivially unit-testable.
 */
function redditTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const collapsed = (firstLine ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return REDDIT_FALLBACK_TITLE;
  if (collapsed.length <= REDDIT_TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, REDDIT_TITLE_MAX - 1)}…`;
}

/**
 * Stable, permanent Reddit broker-error code tokens. A `successful:false`
 * verdict whose error string contains one of these can ONLY ever fail the same
 * way on a retry (the community does not exist / is not allowed / the post kind
 * is forbidden), so the failure must self-terminate rather than have the standing
 * worker re-claim and re-fail it every tick forever. Anything NOT matched here
 * DEFAULTS TO RETRYABLE (fail-safe: an unrecognized/transient error is retried,
 * never wrongly buried). Matched case-insensitively as a substring so the exact
 * Reddit tuple wrapping (`[['SUBREDDIT_NOEXIST', "...", 'sr']]`) still classifies.
 */
const PERMANENT_REDDIT_ERROR_TOKENS = [
  'SUBREDDIT_NOEXIST',
  'SUBREDDIT_NOTALLOWED',
  'SUBREDDIT_REQUIRED',
  'NO_SELFS',
  'NO_LINKS',
] as const;

function isPermanentBrokerError(error: string | null | undefined): boolean {
  if (!error) return false;
  const upper = error.toUpperCase();
  return PERMANENT_REDDIT_ERROR_TOKENS.some((token) => upper.includes(token));
}

const LINKEDIN_COMMENTARY_MAX = 3000;

/**
 * LinkedIn's `commentary` is REQUIRED and capped at 3000 chars. Truncate with the
 * existing ellipsis idiom (single `…` glyph counted within the cap). Unlike the
 * Reddit title this preserves the full body (newlines included) — it is the post
 * text, not a one-line title. Pure — no I/O — so it is trivially unit-testable.
 */
function linkedinCommentary(content: string): string {
  const text = content ?? '';
  if (text.length <= LINKEDIN_COMMENTARY_MAX) return text;
  return `${text.slice(0, LINKEDIN_COMMENTARY_MAX - 1)}…`;
}

const YOUTUBE_TITLE_MAX = 100; // YouTube hard-limits a video title to 100 chars.
const YOUTUBE_DESCRIPTION_MAX = 5000;
const YOUTUBE_FALLBACK_TITLE = 'New post';
const YOUTUBE_DEFAULT_CATEGORY_ID = '22'; // People & Blogs — a safe general default.

/**
 * The YouTube Data API rejects `<`/`>` anywhere in snippet.title/description
 * (HTTP 400 invalidVideoMetadata). Strip them so a caption like "buy 1 get 1 <3"
 * cannot turn into a deterministically-failing payload (which would re-fail on
 * every worker re-claim → a poison-retry loop, since the failure is classified
 * never-posted). Removed, not escaped — YouTube has no entity decoding here.
 */
function stripYouTubeAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, '');
}

/**
 * YouTube `title` is REQUIRED and ≤ 100 chars. Take the first non-empty line of
 * the content, collapse internal whitespace, strip forbidden angle brackets, and
 * truncate with the shared `…` idiom. Pure — no I/O — so it is unit-testable.
 */
function youtubeTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const collapsed = stripYouTubeAngleBrackets((firstLine ?? '').replace(/\s+/g, ' ')).trim();
  if (!collapsed) return YOUTUBE_FALLBACK_TITLE;
  if (collapsed.length <= YOUTUBE_TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, YOUTUBE_TITLE_MAX - 1)}…`;
}

/** YouTube `description` is REQUIRED, ≤5000 chars, no angle brackets (full body kept). */
function youtubeDescription(content: string): string {
  const text = stripYouTubeAngleBrackets(content ?? '');
  if (text.length <= YOUTUBE_DESCRIPTION_MAX) return text;
  return `${text.slice(0, YOUTUBE_DESCRIPTION_MAX - 1)}…`;
}

/** YouTube `categoryId` is REQUIRED — operator-overridable, defaults to '22'. */
function youtubeCategoryId(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPOSIO_YOUTUBE_CATEGORY_ID?.trim() || YOUTUBE_DEFAULT_CATEGORY_ID;
}

/**
 * YouTube `privacyStatus` is REQUIRED. Defaults to `public` (parity with how the
 * other platforms publish live); an operator can set `unlisted`/`private` via
 * COMPOSIO_YOUTUBE_PRIVACY_STATUS (recommended for first live verification).
 * Any unrecognized value falls back to `public`.
 */
function youtubePrivacyStatus(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COMPOSIO_YOUTUBE_PRIVACY_STATUS?.trim().toLowerCase();
  if (raw === 'public' || raw === 'private' || raw === 'unlisted') return raw;
  return 'public';
}

export class ComposioPublisherProvider implements PublisherProvider {
  readonly kind = 'composio' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
    // Still→video synthesis for YouTube publish. Injected (defaults to the real
    // ffmpeg-backed helper) so unit tests can fake it without a binary on CI.
    private readonly synthesizeVideo: typeof synthesizeStillToVideo = synthesizeStillToVideo,
  ) {}

  supports(platform: IntegrationPlatform): boolean {
    return isIntegrationPlatform(platform);
  }

  private async requireActiveConnection(input: { tenantId: string; platform: IntegrationPlatform }) {
    const conn = await getConnectionRow(input.tenantId, input.platform, this.db);
    if (!conn || conn.status !== 'connected' || !conn.connectedAccountId) {
      throw new ComposioConnectionMissingError(input.platform);
    }
    return conn;
  }

  private requireSlug(platform: IntegrationPlatform, op: ComposioOperation, capability: string): string {
    const slug = this.config.actionSlugFor(platform, op);
    if (!slug) throw new ComposioCapabilityMissingError(platform, capability);
    return slug;
  }

  /**
   * Per-surface media validation for a video/Story/Reel publish, run BEFORE any
   * `gateway.executeTool` so nothing is ever posted on a malformed payload.
   *
   * SAFETY (double-post guard): `validateMediaForSurface` throws a
   * `MetaPublishError`, which is NOT in `publishNeverReachedPlatform`'s recognized
   * set (publish-outcome.ts). If that raw error escaped `publishPost`,
   * `dispatchPublish`'s catch would fail the `publishNeverReachedPlatform` check
   * and re-wrap it as `provider_publish_outcome_unknown` (`outcomeUnknown:true`) —
   * surfacing a post that PROVABLY never reached the platform as
   * needs_manual_reconciliation. Since validation runs before any tool call, the
   * post definitely never posted, so we rethrow as `ComposioToolError` — a
   * recognized never-posted verdict — exactly as the X/LinkedIn/YouTube
   * pre-publish staging failures are surfaced. A validation failure is therefore
   * unambiguously definitely-never-posted (safe to roll back the claim).
   */
  private validateMediaSurfaceOrNeverPosted(
    input: PublishPostInput,
    surface: MediaSurface,
    mediaType: MediaType,
    slug: string,
  ): void {
    const media: MediaMetadata[] = input.mediaUrls.map((url, i) => ({
      url,
      widthPx: input.mediaMetadata?.[i]?.widthPx ?? null,
      heightPx: input.mediaMetadata?.[i]?.heightPx ?? null,
      durationSeconds: input.mediaMetadata?.[i]?.durationSeconds ?? null,
    }));
    try {
      validateMediaForSurface({ media, surface, mediaType, scheduledFor: input.scheduledFor ?? null });
    } catch (error) {
      if (error instanceof MetaPublishError) {
        throw new ComposioToolError(slug, `${error.code}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * The IG user id (numeric) the container/publish actions need as `ig_user_id`.
   * `connected_accounts.external_account_id` is null for IG (it is not in the
   * connection metadata), so fall back to the verified INSTAGRAM_GET_USER_INFO
   * resolver, then to `'me'` (the actions accept the literal `'me'`). The resolver
   * is a read-only pre-publish call that never creates a post.
   */
  private async resolveInstagramUserId(connectedAccountId: string, externalAccountId: string | null): Promise<string> {
    const stored = externalAccountId?.trim();
    if (stored) return stored;
    const resolved = await resolveInstagramAccount(this.gateway, this.config, connectedAccountId);
    return resolved?.igUserId ?? 'me';
  }

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    // Dry-run never touches Composio.
    if (input.dryRun) {
      return {
        provider: 'composio',
        platform: input.platform,
        externalPostId: null,
        externalCampaignId: null,
        externalAdId: null,
        status: 'preview',
        url: null,
        rawResponse: {
          previewed: true,
          platform: input.platform,
          mediaCount: input.mediaUrls.length,
          hasCaption: input.content.trim().length > 0,
        },
      };
    }
    if (!input.approved) throw new PublishGuardError();

    const conn = await this.requireActiveConnection({ tenantId: input.tenantId, platform: input.platform });

    // ── Action slug + argument selection (#627) ────────────────────────────
    //
    // Facebook has two distinct action slugs with incompatible parameter schemas:
    //
    //   FACEBOOK_CREATE_PHOTO_POST (`upload_media` op slot)
    //     Required: url (signed public image URL), message, page_id
    //     Used for: image posts (mediaUrls.length > 0)
    //     FACEBOOK_CREATE_POST ignores media_urls entirely, so image posts MUST
    //     route here — confirmed live via FACEBOOK_GET_POST (full_picture present).
    //
    //   FACEBOOK_CREATE_POST (`publish_post` op slot)
    //     Required: message, page_id
    //     Used for: text/link-only posts (no media)
    //
    // Instagram: single `publish_post` slug via caption + media_urls + placement.
    //
    // The page_id for Facebook is stored at connect-time in
    // connected_accounts.external_account_id. When null (OAuth callback race),
    // resolveFacebookManagedPage is called as a fallback.
    let slug: string;
    let toolArgs: Record<string, unknown>;
    // The created post id lives at different keys per platform; a branch may
    // override before the shared extraction at the end of publishPost.
    let idKeys = DEFAULT_POST_ID_KEYS;

    if (input.platform === 'facebook') {
      let pageId = conn.externalAccountId ?? null;
      if (!pageId) {
        const page = await resolveFacebookManagedPage(
          this.gateway,
          this.config,
          conn.connectedAccountId!,
        );
        pageId = page?.pageId ?? null;
      }
      if (!pageId) {
        throw new ComposioCapabilityMissingError(
          'facebook',
          'identify the posting Page — reconnect your Facebook account to resolve this',
        );
      }

      if (input.mediaType === 'video') {
        // Video post: FACEBOOK_CREATE_VIDEO_POST via the `publish_video` op slot
        // (COMPOSIO_FACEBOOK_PUBLISH_VIDEO_ACTION). The raw mp4 file_url is posted
        // directly — no pre-stage. Composio has NO distinct FB Reel/Story video
        // action, so a reel/story video collapses to a Page (feed) video; validate
        // it against feed-video constraints accordingly.
        slug = this.requireSlug(input.platform, 'publish_video', 'publish videos');
        this.validateMediaSurfaceOrNeverPosted(input, 'feed', 'video', slug);
        toolArgs = {
          page_id: pageId,
          file_url: input.mediaUrls[0],
          description: input.content,
          // Scheduling requires `published:false` AND `scheduled_publish_time`
          // TOGETHER (a `scheduled_publish_time` without `published:false` would
          // publish immediately — the latent bug in the photo/text branch above
          // is deliberately NOT copied here).
          ...(input.scheduledFor
            ? { published: false, scheduled_publish_time: input.scheduledFor }
            : { published: true }),
        };
      } else {
        const hasImage = input.mediaUrls.length > 0;
        if (hasImage) {
          // Photo post: FACEBOOK_CREATE_PHOTO_POST via the `upload_media` op slot
          // (COMPOSIO_FACEBOOK_UPLOAD_MEDIA_ACTION=FACEBOOK_CREATE_PHOTO_POST).
          // Only the first image is posted; multi-image carousel is a future feature.
          slug = this.requireSlug(input.platform, 'upload_media', 'publish photo posts');
          toolArgs = {
            url: input.mediaUrls[0],
            message: input.content,
            page_id: pageId,
            ...(input.scheduledFor ? { scheduled_publish_time: input.scheduledFor } : {}),
          };
        } else {
          // Text-only post: FACEBOOK_CREATE_POST via the `publish_post` op slot.
          slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
          toolArgs = {
            message: input.content,
            page_id: pageId,
            ...(input.scheduledFor ? { scheduled_publish_time: input.scheduledFor } : {}),
          };
        }
      }
    } else if (input.platform === 'x') {
      // X (Twitter): a text post, optionally with a single image. Unlike
      // Facebook's photo post (which accepts an image URL), TWITTER_UPLOAD_MEDIA's
      // `media` is a `file_uploadable` field that needs a staged S3 descriptor —
      // the gateway constructs the SDK WITHOUT auto-upload, so a raw URL would be
      // rejected ("Following fields are missing: {'media'}"). An image post is
      // therefore a pre-publish UPLOAD (stage bytes → register the Twitter media)
      // followed by the create-post call.
      //
      // The whole upload runs BEFORE any tweet exists, so every failure here is
      // surfaced as a ComposioToolError → the dispatcher classifies it
      // definitely-never-posted (safe to roll back the claim + retry). ONLY the
      // final TWITTER_CREATION_OF_A_POST executed via the shared call below is the
      // outcome-unknown boundary (a transport drop after that may have posted).
      //
      // X has no Page-id (resolves through the default connectedAccountId path)
      // and no native scheduling here, so `scheduledFor` is ignored and the
      // status resolves to `published`.
      let mediaId: string | null = null;
      if (input.mediaUrls.length > 0) {
        const uploadSlug = this.requireSlug(input.platform, 'upload_media', 'upload media for X posts');
        const toolkitSlug = this.config.toolkitSlugFor(input.platform);
        let descriptor: ComposioFileDescriptor;
        try {
          descriptor = await this.gateway.uploadFile({
            file: input.mediaUrls[0],
            toolSlug: uploadSlug,
            toolkitSlug,
          });
        } catch (error) {
          // Staging to S3 never created a tweet — definitely-never-posted.
          throw new ComposioToolError(
            uploadSlug,
            error instanceof Error ? error.message : 'failed to stage media for upload',
          );
        }
        const uploaded = await this.gateway.executeTool(uploadSlug, {
          connectedAccountId: conn.connectedAccountId!,
          arguments: { media: descriptor, media_category: 'tweet_image' },
        });
        if (!uploaded.successful) {
          throw new ComposioToolError(uploadSlug, uploaded.error ?? 'media upload reported unsuccessful');
        }
        // The Twitter media id comes back nested (commonly data.data.id) and must
        // be a numeric-string for media_media_ids; never use media_key.
        mediaId = pickId(uploaded.data, ['media_id_string', 'media_id', 'id']);
        if (!mediaId) {
          throw new ComposioToolError(uploadSlug, 'media upload returned no media id');
        }
      }
      slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
      toolArgs = {
        text: input.content,
        ...(mediaId ? { media_media_ids: [mediaId] } : {}),
      };
    } else if (input.platform === 'reddit') {
      // Reddit: a SINGLE REDDIT_CREATE_REDDIT_POST call. There is NO media-upload
      // action — an image is posted as a `kind='link'` whose url IS the image
      // (Reddit fetches it), never a pre-staged upload. So unlike X, there is no
      // pre-publish step: this is exactly the FB-style single-call,
      // outcome-unknown boundary (a transport drop after dispatch may have
      // posted). Every PRE-call failure here (no subreddit, no slug, no
      // connection) throws BEFORE the shared executeTool below → classified
      // definitely-never-posted → safe rollback + worker re-claim. Reddit is
      // rate-limited and posts can be silently automod-removed; we deliberately
      // do NOT retry-loop a create — a rate-limited create surfaces as
      // never-posted and the standing worker re-claims the row.
      //
      // Subreddit target (never guessed): an explicit
      // COMPOSIO_REDDIT_TARGET_SUBREDDIT is REQUIRED. There is NO `u_<username>`
      // profile fallback — Reddit's `sr` field resolves COMMUNITY names only, so
      // a user-profile target (`u_<name>` in any prefix form) is not addressable
      // this way and deterministically fails with SUBREDDIT_NOEXIST. When the env
      // is unset, refuse up-front with a capability error (never-posted AND
      // non-retryable → fails terminal + clean, no retry-spam). Normalize the env
      // value: strip a leading `r/` or `/r/` so the bare community name is sent
      // (Reddit's `sr` wants the bare name, not the `r/` display prefix).
      const rawSubreddit = redditTargetSubreddit();
      if (!rawSubreddit) {
        throw new ComposioCapabilityMissingError(
          'reddit',
          'publish requires a target subreddit — set COMPOSIO_REDDIT_TARGET_SUBREDDIT to a community name',
        );
      }
      const subreddit = rawSubreddit.replace(/^\/?r\//i, '');

      slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
      // Reddit returns a fullname id (`t3_<base36>`) at data.json.data.name — NOT
      // in the shared default keys (and under a `json` nest), so override here.
      idKeys = ['name', 'id', 'post_id'];

      const title = redditTitleFromContent(input.content);
      const flairId = process.env.COMPOSIO_REDDIT_FLAIR_ID?.trim();
      if (input.mediaUrls.length > 0) {
        // Image post: the image IS the link target (kind='link'); not dropped,
        // not pre-uploaded.
        toolArgs = {
          subreddit,
          title,
          kind: 'link',
          url: input.mediaUrls[0],
          ...(flairId ? { flair_id: flairId } : {}),
        };
      } else {
        // Text post: kind='self' with the body as `text`.
        toolArgs = {
          subreddit,
          title,
          kind: 'self',
          text: input.content,
          ...(flairId ? { flair_id: flairId } : {}),
        };
      }
    } else if (input.platform === 'linkedin') {
      // LinkedIn: a SINGLE LINKEDIN_CREATE_LINKED_IN_POST call.
      //
      // author (the linkedin_profile_missing fix — FIRST, before slug/staging):
      // the urn:li:person:<id> author URN is resolved + persisted at connect
      // (#645) into connected_accounts.external_account_id; read it straight
      // here. NEVER send a publish with a missing/placeholder author — a missing
      // URN is a capability error (reconnect to resolve the profile), classified
      // definitely-never-posted so the row is safely re-claimed.
      const author = conn.externalAccountId?.trim() || null;
      if (!author) {
        throw new ComposioCapabilityMissingError(
          'linkedin',
          'reconnect LinkedIn to resolve your author profile',
        );
      }

      // Single publish slug (never guessed — capability-missing when unset).
      slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
      // LinkedIn returns a share / ugcPost urn, not the shared default keys.
      idKeys = ['id', 'share_id', 'ugcPostUrn', 'activity_urn', 'urn'];

      // Unlike X, LinkedIn has NO separate upload action: an image is staged to
      // Composio's S3 via gateway.uploadFile and the returned
      // {name,mimetype,s3key} descriptor is pushed DIRECTLY into
      // `images:[descriptor]` of THIS one publish call (the `images` input is a
      // `file_uploadable`, so a bare URL would be rejected — same as X media).
      // Staging runs BEFORE any post exists, so every failure here is a
      // ComposioToolError → definitely-never-posted (safe rollback + re-claim).
      // ONLY the LINKEDIN_CREATE_LINKED_IN_POST executed via the shared call
      // below is the outcome-unknown boundary. A text-only post (no mediaUrls)
      // OMITS `images` entirely — author + commentary alone are a valid post.
      //
      // LinkedIn has no native scheduling, so `scheduledFor` is ignored and the
      // status resolves to `published`.
      let descriptor: ComposioFileDescriptor | null = null;
      if (input.mediaUrls.length > 0) {
        try {
          descriptor = await this.gateway.uploadFile({
            file: input.mediaUrls[0],
            toolSlug: slug,
            toolkitSlug: this.config.toolkitSlugFor(input.platform),
          });
        } catch (error) {
          // Staging to S3 never created a post — definitely-never-posted.
          throw new ComposioToolError(
            slug,
            error instanceof Error ? error.message : 'failed to stage media for upload',
          );
        }
      }

      toolArgs = {
        author,
        commentary: linkedinCommentary(input.content),
        ...(descriptor ? { images: [descriptor] } : {}),
      };
    } else if (input.platform === 'youtube') {
      // YouTube: the native post is a VIDEO upload, but the Aries pipeline emits
      // a single still image. We synthesize a short Ken-Burns MP4 from the still
      // (backend/integrations/still-to-video.ts), stage it to Composio's S3 (the
      // `videoFile`/`videoFilePath` input is a file_uploadable, so a bare path is
      // rejected unless pre-staged — same as X media / LinkedIn images), then
      // upload via YOUTUBE_UPLOAD_VIDEO / YOUTUBE_MULTIPART_UPLOAD_VIDEO.
      //
      // Synthesis + staging both run BEFORE any video exists on the channel, so
      // every failure here is a ComposioToolError → definitely-never-posted
      // (safe rollback + worker re-claim). ONLY the final executeTool below is
      // the outcome-unknown boundary. YouTube has no native scheduling here, so
      // `scheduledFor` is ignored and the status resolves to `published`.
      if (input.mediaUrls.length === 0) {
        // Nothing to make a video from — refuse rather than upload an empty clip.
        throw new ComposioCapabilityMissingError(
          'youtube',
          'a creative image is required to synthesize the YouTube video',
        );
      }
      slug = this.requireSlug(input.platform, 'publish_post', 'publish videos');

      let synthesized: StillToVideoResult;
      try {
        synthesized = await this.synthesizeVideo({ image: input.mediaUrls[0] });
      } catch (error) {
        // Synthesis never created a video — definitely-never-posted.
        throw new ComposioToolError(
          slug,
          error instanceof Error ? error.message : 'failed to synthesize video from image',
        );
      }

      let descriptor: ComposioFileDescriptor;
      try {
        descriptor = await this.gateway.uploadFile({
          file: synthesized.path,
          toolSlug: slug,
          toolkitSlug: this.config.toolkitSlugFor(input.platform),
        });
      } catch (error) {
        // Staging to S3 never created a video — definitely-never-posted.
        await synthesized.cleanup();
        throw new ComposioToolError(
          slug,
          error instanceof Error ? error.message : 'failed to stage video for upload',
        );
      }
      // Composio holds the bytes in its S3 once staged; drop the local temp file
      // before the (slower) upload call so a failure there never leaks it.
      await synthesized.cleanup();

      // The two YouTube upload actions name the file arg differently but take the
      // same {name,mimetype,s3key} descriptor:
      //   YOUTUBE_UPLOAD_VIDEO           → videoFilePath
      //   YOUTUBE_MULTIPART_UPLOAD_VIDEO → videoFile
      // Key off the configured slug so either works via
      // COMPOSIO_YOUTUBE_PUBLISH_POST_ACTION.
      const videoArgKey = slug.toUpperCase().includes('MULTIPART') ? 'videoFile' : 'videoFilePath';
      // The created videoId comes back nested (commonly data.video.id) — covered
      // by the `video` nest key added to pickId above.
      idKeys = ['videoId', 'video_id', 'id'];
      toolArgs = {
        [videoArgKey]: descriptor,
        title: youtubeTitleFromContent(input.content),
        description: youtubeDescription(input.content),
        // `tags` is required by YOUTUBE_UPLOAD_VIDEO (optional for multipart); an
        // empty array satisfies the schema without inventing keywords.
        tags: [],
        categoryId: youtubeCategoryId(),
        privacyStatus: youtubePrivacyStatus(),
      };
    } else if (input.platform === 'instagram') {
      // Instagram: a TWO-STEP publish — create a media container, then publish it.
      //   1. INSTAGRAM_POST_IG_USER_MEDIA          (`upload_media` op) → creation_id
      //   2. INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH  (`publish_post` op) → ig_media_id
      // Image and video share the same container action; the surface selects the
      // container's media_type. A single clean public URL is posted per call
      // (multi-image carousel is a future feature). The previous single-call shape
      // matched no real Composio action and never published live, so this is a
      // ground-up rewrite, not a regression of working behaviour.
      if (input.mediaUrls.length === 0) {
        throw new ComposioCapabilityMissingError('instagram', 'publish a post — an image or video is required');
      }
      const surface: MediaSurface = input.placement ?? 'feed';
      const isVideo = input.mediaType === 'video';

      // Resolve BOTH slugs (capability-missing — definitely-never-posted — when unset).
      const containerSlug = this.requireSlug(input.platform, 'upload_media', 'create a media container');
      const publishSlug = this.requireSlug(input.platform, 'publish_post', 'publish posts');

      // Fail-closed media validation BEFORE the container is created — nothing is
      // posted on a malformed payload and a validation failure is never-posted.
      // An IG feed VIDEO publishes as a REELS container, which Meta requires to be
      // vertical 9:16, so validate it against reel constraints (not the laxer feed
      // rules) — catch a non-9:16 clip at Aries rather than at the Meta container.
      const validationSurface: MediaSurface = isVideo && surface === 'feed' ? 'reel' : surface;
      this.validateMediaSurfaceOrNeverPosted(input, validationSurface, isVideo ? 'video' : 'image', containerSlug);

      const igUserId = await this.resolveInstagramUserId(conn.connectedAccountId!, conn.externalAccountId ?? null);

      // ── Step 1: create the media container (single clean public URL) ──────
      const containerArgs: Record<string, unknown> = {
        ig_user_id: igUserId,
        caption: input.content,
      };
      if (isVideo) {
        containerArgs.video_url = input.mediaUrls[0];
        // surface → IG container media_type. reel → REELS; story → STORIES;
        // feed video → REELS + share_to_feed (a Reel that also lands in the feed).
        if (surface === 'story') {
          containerArgs.media_type = 'STORIES';
        } else {
          containerArgs.media_type = 'REELS';
          if (surface === 'feed') containerArgs.share_to_feed = true;
        }
      } else {
        // Feed image: image_url, no media_type (IG defaults to a single IMAGE).
        containerArgs.image_url = input.mediaUrls[0];
      }

      const container = await this.gateway.executeTool(containerSlug, {
        connectedAccountId: conn.connectedAccountId!,
        arguments: containerArgs,
      });
      if (!container.successful) {
        // The broker explicitly rejected the container — no container, no post.
        throw new ComposioToolError(containerSlug, container.error ?? 'media container create reported unsuccessful');
      }
      const creationId = pickId(container.data, ['id', 'creation_id']);
      if (!creationId) {
        throw new ComposioToolError(containerSlug, 'media container create returned no creation id');
      }

      // ── Step 2: publish the container (executed by the shared call below) ──
      // This is the ONLY outcome-unknown boundary for IG: a transport drop after
      // this call may have published. A failed container above is never-posted.
      slug = publishSlug;
      toolArgs = {
        ig_user_id: igUserId,
        creation_id: creationId,
        // Bounded server-side poll for the container to finish processing (<=300).
        max_wait_seconds: 300,
        poll_interval_seconds: 5,
      };
      // The published media id comes back as ig_media_id (or id).
      idKeys = ['ig_media_id', 'id', 'media_id'];
    } else {
      // Unknown / unhandled platform — refuse explicitly rather than silently
      // falling through to an Instagram payload on the wrong network.
      throw new ComposioToolError(
        'publish_post',
        `${input.platform} is not a supported publish target`,
      );
    }

    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: toolArgs,
    });

    if (!result.successful) {
      // Classify the broker verdict: a PERMANENT Reddit error code (e.g.
      // SUBREDDIT_NOEXIST/NOTALLOWED) can only ever fail the same way, so mark it
      // terminal (non-retryable) — the row fails clean instead of the worker
      // re-claiming and re-failing it every tick. Scoped to reddit: the token
      // list is Reddit's API vocabulary, and a generic-looking token appearing in
      // another broker's error text must not bury a retryable post. Anything
      // unrecognized defaults to retryable (fail-safe).
      throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful', {
        terminal: input.platform === 'reddit' && isPermanentBrokerError(result.error),
      });
    }

    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: pickId(result.data, idKeys),
      externalCampaignId: null,
      externalAdId: null,
      status: input.scheduledFor ? 'scheduled' : 'published',
      url: pickUrl(result.data),
      rawResponse: result.data,
    };
  }

  async publishAd(input: PublishAdInput): Promise<PublishResult> {
    const conn = await this.requireActiveConnection({ tenantId: input.tenantId, platform: input.platform });
    const slug = this.requireSlug(input.platform, 'create_ad', 'create ads');

    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: {
        name: input.name,
        ad_account_id: input.adAccountId,
        campaign: input.campaign,
        ad_set: input.adSet,
        creative: input.creative,
        // Non-negotiable: never create an active ad. Force PAUSED on every axis
        // a Meta-family tool might read.
        status: 'PAUSED',
        effective_status: 'PAUSED',
        campaign_status: 'PAUSED',
        adset_status: 'PAUSED',
      },
    });

    if (!result.successful) {
      throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    }

    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: null,
      externalCampaignId: pickId(result.data, ['campaign_id', 'campaignId']),
      externalAdId: pickId(result.data, ['ad_id', 'adId', 'id']),
      // Created PAUSED — surfaced as `paused`, never `published`.
      status: 'paused',
      url: pickUrl(result.data),
      rawResponse: result.data,
    };
  }

  async uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    const conn = await this.requireActiveConnection({ tenantId: input.tenantId, platform: input.platform });
    const slug = this.config.actionSlugFor(input.platform, 'upload_media');
    if (!slug) {
      // No standalone upload configured: report a no-op preview rather than
      // guessing a slug. Inline upload happens during publishPost where supported.
      return {
        provider: 'composio',
        platform: input.platform,
        mediaHandle: null,
        status: 'preview',
        rawResponse: { reason: `No upload_media action configured for ${input.platform}.` },
      };
    }
    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: { media_url: input.mediaUrl, media_type: input.mediaType },
    });
    if (!result.successful) throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    return {
      provider: 'composio',
      platform: input.platform,
      mediaHandle: pickId(result.data, ['media_id', 'id', 'handle', 'creation_id']),
      status: 'uploaded',
      rawResponse: result.data,
    };
  }

  async getPublishStatus(input: GetPublishStatusInput): Promise<PublishResult> {
    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: input.externalPostId ?? null,
      externalCampaignId: null,
      externalAdId: input.externalAdId ?? null,
      status: 'pending',
      url: null,
      rawResponse: { reason: 'Status polling is read from analytics; no dedicated status tool configured.' },
    };
  }
}
