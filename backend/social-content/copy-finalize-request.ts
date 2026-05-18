import type { MarketingJobRuntimeDocument, MarketingStage } from '@/backend/marketing/runtime-state';
import {
  redactTokenLikeString,
  sanitizeWeeklySocialContentPayload,
} from '@/backend/social-content/payload';
import {
  buildBrandKitPayload,
  type SocialContentBrandPayload,
  type SocialContentObjectivePayload,
} from '@/backend/social-content/brand-kit-payload';

import { SOCIAL_COPY_FINALIZE_WORKFLOW_KEY } from './defaults';

type UnknownRecord = Record<string, unknown>;
type MarketingDocWithSocialRuntime = MarketingJobRuntimeDocument & {
  social_content_runtime?: unknown;
};

type SocialCopyFinalizeChannel =
  | 'instagram_feed'
  | 'facebook_feed'
  | 'linkedin_feed'
  | 'x_feed'
  | 'tiktok_feed'
  | 'youtube_feed'
  | 'social_feed';

export type SocialCopyFinalizeApprovedImage = {
  id: string;
  post_id: string | null;
  url: string;
  alt_text: string;
  title: string;
  prompt: string;
  status: string;
};

export type SocialCopyFinalizeApprovedVideo = {
  id: string;
  post_id: string | null;
  url: string;
  title: string;
  script_markdown: string;
  status: string;
};

export type SocialCopyFinalizeInputPost = {
  id: string;
  creative_brief_id: string;
  channel: SocialCopyFinalizeChannel;
  title: string;
  draft_caption: string;
  day: string;
  status: string;
  platforms: string[];
  approved_image: SocialCopyFinalizeApprovedImage | null;
  approved_video: SocialCopyFinalizeApprovedVideo | null;
};

export type SocialCopyFinalizeRequest = {
  workflow_key: string;
  aries_run_id: string;
  tenant_id: string;
  job_id: string;
  callback_url: string;
  input: {
    brand: SocialContentBrandPayload;
    objective: SocialContentObjectivePayload;
    onboarding: {
      marketing_focus: string;
      goal: string;
      audience: string;
      tone_of_voice: string;
      offer: string;
      channels: string[];
    };
    approved_images: SocialCopyFinalizeApprovedImage[];
    approved_videos: SocialCopyFinalizeApprovedVideo[];
    posts: SocialCopyFinalizeInputPost[];
    output_contract: {
      version: 'v1';
      generated_at: 'ISO-8601 timestamp';
      posts: {
        id: 'string — must exactly echo input.posts[].id from weekly-plan.json';
        channel: 'string — must exactly echo input.posts[].channel';
        caption: 'string — final image-aware caption';
        hashtags: 'string[] — channel-safe hashtags only';
        cta: 'string — explicit call to action';
        warnings: 'string[] — non-fatal validator or asset-fit warnings; [] when none';
      };
    };
    constraints: {
      preserve_input_post_order: true;
      preserve_input_post_ids: true;
      require_warnings_array: true;
      do_not_invent_missing_posts: true;
      do_not_reassign_channels: true;
    };
  };
};

export type SocialCopyFinalizeRequestBuildResult =
  | {
      kind: 'build';
      request: SocialCopyFinalizeRequest;
      postCount: number;
      approvedImageCount: number;
      approvedVideoCount: number;
    }
  | {
      kind: 'skip';
      workflow_key: string;
      reason: 'no_weekly_plan_posts' | 'no_approved_images';
      postCount: number;
      approvedImageCount: number;
      approvedVideoCount: number;
    };

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function recordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is UnknownRecord => !!entry);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? redactTokenLikeString(value).trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => redactTokenLikeString(entry).trim())
    .filter((entry) => entry.length > 0);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function requestRecord(doc: MarketingJobRuntimeDocument): UnknownRecord {
  const value = doc.inputs.request;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? sanitizeWeeklySocialContentPayload(value as UnknownRecord)
    : {};
}

function socialRuntimeRecord(doc: MarketingJobRuntimeDocument): UnknownRecord | null {
  return asRecord((doc as MarketingDocWithSocialRuntime).social_content_runtime);
}

function stageOutputRecords(doc: MarketingJobRuntimeDocument): UnknownRecord[] {
  const sources: UnknownRecord[] = [];

  const socialRuntime = socialRuntimeRecord(doc);
  const stageOrder = Array.isArray(socialRuntime?.stageOrder)
    ? socialRuntime.stageOrder
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : [];
  const socialStages = asRecord(socialRuntime?.stages);

  for (const stage of stageOrder) {
    const stageRecord = asRecord(socialStages?.[stage]);
    const output = asRecord(stageRecord?.output);
    if (output) sources.push(output);
  }

  const marketingStages: MarketingStage[] = ['research', 'strategy', 'production', 'publish'];
  for (const stage of marketingStages) {
    const stageRecord = asRecord(doc.stages[stage]);
    const output = asRecord(stageRecord?.primary_output);
    if (output) sources.push(output);
  }

  return sources;
}

function latestWeeklyPlanRaw(doc: MarketingJobRuntimeDocument): {
  posts: UnknownRecord[];
  imageCreatives: UnknownRecord[];
  videoScripts: UnknownRecord[];
} {
  let posts: UnknownRecord[] = [];
  let imageCreatives: UnknownRecord[] = [];
  let videoScripts: UnknownRecord[] = [];

  for (const source of stageOutputRecords(doc)) {
    const plan = asRecord(source.weekly_content_plan ?? source.weeklyPlan);
    if (!plan) continue;

    const nextPosts = recordArray(plan.posts);
    if (nextPosts.length > 0) posts = nextPosts;

    const nextImages = recordArray(plan.image_creatives);
    if (nextImages.length > 0) imageCreatives = nextImages;

    const nextVideos = recordArray(plan.video_scripts);
    if (nextVideos.length > 0) videoScripts = nextVideos;
  }

  return { posts, imageCreatives, videoScripts };
}

function normalizePostId(post: UnknownRecord, index: number): string {
  return firstString(post.id, post.post_id, post.postId, post.creative_brief_id) || `social-post-${index + 1}`;
}

function normalizeCreativeBriefId(post: UnknownRecord, fallbackPostId: string): string {
  return firstString(post.creative_brief_id, post.creativeBriefId, post.image_id, post.imageId, fallbackPostId);
}

function normalizePostPlatforms(post: UnknownRecord): string[] {
  const directPlatforms = stringArray(post.platforms);
  if (directPlatforms.length > 0) return directPlatforms;

  const channel = firstString(post.channel, post.platform);
  return channel ? [channel] : [];
}

function normalizePostChannel(post: UnknownRecord): SocialCopyFinalizeChannel {
  const platform = (normalizePostPlatforms(post)[0] || '').toLowerCase();
  if (platform === 'instagram' || platform === 'instagram_feed') return 'instagram_feed';
  if (platform === 'meta' || platform === 'facebook' || platform === 'facebook_feed') return 'facebook_feed';
  if (platform === 'linkedin' || platform === 'linkedin_feed') return 'linkedin_feed';
  if (platform === 'x' || platform === 'twitter' || platform === 'x_feed') return 'x_feed';
  if (platform === 'tiktok' || platform === 'tiktok_feed') return 'tiktok_feed';
  if (platform === 'youtube' || platform === 'youtube_feed') return 'youtube_feed';
  return 'social_feed';
}

function normalizeImageUrl(image: UnknownRecord): string {
  return firstString(image.artifact_url, image.url, image.preview_url, image.previewUrl, image.filePath, image.path);
}

function normalizeVideoUrl(video: UnknownRecord): string {
  const renderedVideo = asRecord(video.rendered_video);
  const render = asRecord(video.render);
  const asset = asRecord(video.asset);
  return firstString(
    video.artifact_url,
    video.url,
    video.rendered_video_url,
    video.rendered_video_path,
    video.video_url,
    video.video_path,
    renderedVideo?.artifact_url,
    renderedVideo?.url,
    renderedVideo?.rendered_video_url,
    renderedVideo?.rendered_video_path,
    renderedVideo?.video_url,
    renderedVideo?.video_path,
    render?.artifact_url,
    render?.url,
    asset?.artifact_url,
    asset?.url,
    asset?.path,
  );
}

function normalizeImageAltText(image: UnknownRecord, fallbackTitle: string): string {
  return firstString(
    image.alt_text,
    image.altText,
    image.alt,
    image.caption,
    image.summary,
    image.title,
    image.prompt,
    fallbackTitle,
  );
}

function normalizeApprovedImages(rawImages: UnknownRecord[], rawPosts: UnknownRecord[]): SocialCopyFinalizeApprovedImage[] {
  const postIdByCreativeBriefId = new Map<string, string>();
  for (let index = 0; index < rawPosts.length; index += 1) {
    const post = rawPosts[index];
    const postId = normalizePostId(post, index);
    const creativeBriefId = normalizeCreativeBriefId(post, postId);
    if (creativeBriefId) postIdByCreativeBriefId.set(creativeBriefId, postId);
  }

  return rawImages
    .map((image, index) => {
      const url = normalizeImageUrl(image);
      if (!url) return null;

      const imageId = firstString(image.id, image.image_id, image.imageId, image.creative_brief_id) || `approved-image-${index + 1}`;
      const title = firstString(image.title, image.name) || `Approved image ${index + 1}`;
      return {
        id: imageId,
        post_id: postIdByCreativeBriefId.get(imageId) ?? null,
        url,
        alt_text: normalizeImageAltText(image, title),
        title,
        prompt: firstString(image.prompt),
        status: firstString(image.status) || 'approved',
      } satisfies SocialCopyFinalizeApprovedImage;
    })
    .filter((image): image is SocialCopyFinalizeApprovedImage => image !== null);
}

function normalizeApprovedVideos(rawVideos: UnknownRecord[], rawPosts: UnknownRecord[]): SocialCopyFinalizeApprovedVideo[] {
  const postIdByCreativeBriefId = new Map<string, string>();
  for (let index = 0; index < rawPosts.length; index += 1) {
    const post = rawPosts[index];
    const postId = normalizePostId(post, index);
    const creativeBriefId = normalizeCreativeBriefId(post, postId);
    if (creativeBriefId) postIdByCreativeBriefId.set(creativeBriefId, postId);
  }

  return rawVideos
    .map((video, index) => {
      const url = normalizeVideoUrl(video);
      if (!url) return null;

      const videoId = firstString(video.id, video.video_id, video.videoId) || `approved-video-${index + 1}`;
      return {
        id: videoId,
        post_id: postIdByCreativeBriefId.get(videoId) ?? null,
        url,
        title: firstString(video.title, video.name) || `Approved video ${index + 1}`,
        script_markdown: firstString(video.script_markdown, video.scriptMarkdown),
        status: firstString(video.status) || 'approved',
      } satisfies SocialCopyFinalizeApprovedVideo;
    })
    .filter((video): video is SocialCopyFinalizeApprovedVideo => video !== null);
}

function buildInputPosts(
  rawPosts: UnknownRecord[],
  approvedImages: SocialCopyFinalizeApprovedImage[],
  approvedVideos: SocialCopyFinalizeApprovedVideo[],
): SocialCopyFinalizeInputPost[] {
  const imageByPostId = new Map<string, SocialCopyFinalizeApprovedImage>();
  for (const image of approvedImages) {
    if (image.post_id && !imageByPostId.has(image.post_id)) imageByPostId.set(image.post_id, image);
  }

  const videoByPostId = new Map<string, SocialCopyFinalizeApprovedVideo>();
  for (const video of approvedVideos) {
    if (video.post_id && !videoByPostId.has(video.post_id)) videoByPostId.set(video.post_id, video);
  }

  return rawPosts.map((post, index) => {
    const id = normalizePostId(post, index);
    return {
      id,
      creative_brief_id: normalizeCreativeBriefId(post, id),
      channel: normalizePostChannel(post),
      title: firstString(post.title) || `Weekly post ${index + 1}`,
      draft_caption: firstString(post.caption, post.caption_text, post.summary),
      day: firstString(post.day),
      status: firstString(post.status) || 'approved',
      platforms: normalizePostPlatforms(post),
      approved_image: imageByPostId.get(id) ?? null,
      approved_video: videoByPostId.get(id) ?? null,
    } satisfies SocialCopyFinalizeInputPost;
  });
}

export function buildSocialCopyFinalizeRequest(input: {
  doc: MarketingJobRuntimeDocument;
  ariesRunId: string;
  callbackUrl: string;
}): SocialCopyFinalizeRequestBuildResult {
  const req = requestRecord(input.doc);
  const brandKitPayload = buildBrandKitPayload(input.doc, input.doc.brand_kit ?? null, req);
  const latestPlan = latestWeeklyPlanRaw(input.doc);
  const approvedImages = normalizeApprovedImages(latestPlan.imageCreatives, latestPlan.posts);
  const approvedVideos = normalizeApprovedVideos(latestPlan.videoScripts, latestPlan.posts);

  if (latestPlan.posts.length === 0) {
    return {
      kind: 'skip',
      workflow_key: SOCIAL_COPY_FINALIZE_WORKFLOW_KEY,
      reason: 'no_weekly_plan_posts',
      postCount: 0,
      approvedImageCount: approvedImages.length,
      approvedVideoCount: approvedVideos.length,
    };
  }

  if (approvedImages.length === 0) {
    return {
      kind: 'skip',
      workflow_key: SOCIAL_COPY_FINALIZE_WORKFLOW_KEY,
      reason: 'no_approved_images',
      postCount: latestPlan.posts.length,
      approvedImageCount: 0,
      approvedVideoCount: approvedVideos.length,
    };
  }

  const posts = buildInputPosts(latestPlan.posts, approvedImages, approvedVideos);
  const onboardingChannels = stringArray(req.channels);
  const marketingFocus = firstString(req.marketingFocus, req.marketing_focus, req.primaryGoal, req.goal);
  const toneOfVoice = firstString(req.toneOfVoice, req.tone_of_voice, req.brandVoice);
  const offer = firstString(req.offer, brandKitPayload.objective.offer, brandKitPayload.brand.offer);

  return {
    kind: 'build',
    postCount: posts.length,
    approvedImageCount: approvedImages.length,
    approvedVideoCount: approvedVideos.length,
    request: {
      workflow_key: SOCIAL_COPY_FINALIZE_WORKFLOW_KEY,
      aries_run_id: input.ariesRunId,
      tenant_id: input.doc.tenant_id,
      job_id: input.doc.job_id,
      callback_url: input.callbackUrl,
      input: {
        brand: brandKitPayload.brand,
        objective: brandKitPayload.objective,
        onboarding: {
          marketing_focus: marketingFocus,
          goal: firstString(req.primaryGoal, req.goal),
          audience: firstString(req.audience, brandKitPayload.objective.audience),
          tone_of_voice: toneOfVoice,
          offer,
          channels: onboardingChannels,
        },
        approved_images: approvedImages,
        approved_videos: approvedVideos,
        posts,
        output_contract: {
          version: 'v1',
          generated_at: 'ISO-8601 timestamp',
          posts: {
            id: 'string — must exactly echo input.posts[].id from weekly-plan.json',
            channel: 'string — must exactly echo input.posts[].channel',
            caption: 'string — final image-aware caption',
            hashtags: 'string[] — channel-safe hashtags only',
            cta: 'string — explicit call to action',
            warnings: 'string[] — non-fatal validator or asset-fit warnings; [] when none',
          },
        },
        constraints: {
          preserve_input_post_order: true,
          preserve_input_post_ids: true,
          require_warnings_array: true,
          do_not_invent_missing_posts: true,
          do_not_reassign_channels: true,
        },
      },
    },
  };
}
