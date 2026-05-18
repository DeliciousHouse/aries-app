import { validateCaption, type Channel } from './caption-validator';
import { writeSocialCopyArtifact, type WriteSocialCopyArtifactResult } from './social-copy-store';
import type { SocialCopyArtifact } from './types';
import type { SocialCopyFinalizeInputPost } from './copy-finalize-request';

type UnknownRecord = Record<string, unknown>;

type SupportedValidationChannel = Extract<SocialCopyFinalizeInputPost['channel'], Channel>;

export type SocialCopyFinalizeCanonicalPost = Pick<SocialCopyFinalizeInputPost, 'id' | 'channel'>;

export type SocialCopyFinalizeRetryInvalidPost = {
  id: string;
  channel: string;
  caption: string;
  hashtags: string[];
  cta: string;
  warnings: string[];
  validationErrors: string[];
};

export type SocialCopyFinalizeRetryRequest = {
  attempt: number;
  constraintFeedback: string;
  invalidPosts: SocialCopyFinalizeRetryInvalidPost[];
  artifact: SocialCopyArtifact;
};

export type SocialCopyFinalizeRetryFn = (
  input: SocialCopyFinalizeRetryRequest,
) => Promise<unknown>;

export type SocialCopyFinalizeHandleResult =
  | {
      status: 'completed';
      artifact: SocialCopyArtifact;
      persisted: WriteSocialCopyArtifactResult;
      invalidPostCount: 0;
      retrySubmitted: false;
      constraintFeedback: null;
    }
  | {
      status: 'retry_submitted';
      artifact: SocialCopyArtifact;
      persisted: WriteSocialCopyArtifactResult | null;
      invalidPostCount: number;
      retrySubmitted: true;
      constraintFeedback: string;
    }
  | {
      status: 'completed_with_warnings';
      artifact: SocialCopyArtifact;
      persisted: WriteSocialCopyArtifactResult;
      invalidPostCount: number;
      retrySubmitted: false;
      constraintFeedback: null;
    };

export class SocialCopyFinalizeHandlerError extends Error {
  readonly code:
    | 'social_copy_finalize_output_invalid'
    | 'social_copy_finalize_post_id_mismatch'
    | 'social_copy_finalize_channel_mismatch';

  readonly details: Record<string, unknown>;

  constructor(
    code: SocialCopyFinalizeHandlerError['code'],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SocialCopyFinalizeHandlerError';
    this.code = code;
    this.details = details;
  }
}

type NormalizedSocialCopyPost = SocialCopyArtifact['posts'][number];

type ValidatedSocialCopyPost = NormalizedSocialCopyPost & {
  validationErrors: string[];
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function payloadRecord(value: unknown): UnknownRecord {
  const root = asRecord(value);
  if (!root) {
    throw new SocialCopyFinalizeHandlerError(
      'social_copy_finalize_output_invalid',
      'Social-copy finalize output must be an object with version, generated_at, and posts.',
    );
  }

  const nested = asRecord(root.social_copy ?? root.socialCopy ?? root.result);
  return nested ?? root;
}

function isSupportedValidationChannel(channel: string): channel is SupportedValidationChannel {
  return channel === 'instagram_feed' || channel === 'facebook_feed';
}

function normalizePost(
  value: unknown,
  input: { index: number },
): NormalizedSocialCopyPost {
  const record = asRecord(value);
  if (!record) {
    throw new SocialCopyFinalizeHandlerError(
      'social_copy_finalize_output_invalid',
      `Social-copy finalize posts[${input.index}] must be an object.`,
      { index: input.index },
    );
  }

  const id = stringValue(record.id);
  const channel = stringValue(record.channel);
  const caption = stringValue(record.caption);
  const cta = stringValue(record.cta);
  const hashtags = stringArray(record.hashtags);
  const warnings = stringArray(record.warnings);

  if (!id || !channel || !caption || !cta || !Array.isArray(record.hashtags) || !Array.isArray(record.warnings)) {
    throw new SocialCopyFinalizeHandlerError(
      'social_copy_finalize_output_invalid',
      `Social-copy finalize posts[${input.index}] must include id, channel, caption, hashtags[], cta, and warnings[].`,
      { index: input.index, id, channel },
    );
  }

  return {
    id,
    channel,
    caption,
    hashtags,
    cta,
    warnings,
  };
}

export function normalizeSocialCopyFinalizeArtifact(output: unknown): SocialCopyArtifact {
  const record = payloadRecord(output);
  const version = stringValue(record.version);
  const generatedAt = stringValue(record.generated_at);
  const posts = Array.isArray(record.posts) ? record.posts : null;

  if (!version || !generatedAt || !posts) {
    throw new SocialCopyFinalizeHandlerError(
      'social_copy_finalize_output_invalid',
      'Social-copy finalize output must include non-empty version, generated_at, and posts[].',
    );
  }

  return {
    version,
    generated_at: generatedAt,
    posts: posts.map((post, index) => normalizePost(post, { index })),
  };
}

function canonicalMap(posts: SocialCopyFinalizeCanonicalPost[]): Map<string, SocialCopyFinalizeCanonicalPost> {
  return new Map(posts.map((post) => [post.id, post] as const));
}

function reorderAndValidateCanonicalPosts(
  artifact: SocialCopyArtifact,
  canonicalPosts: SocialCopyFinalizeCanonicalPost[],
): SocialCopyArtifact {
  const canonicalById = canonicalMap(canonicalPosts);
  const normalizedById = new Map<string, NormalizedSocialCopyPost>();
  const duplicateIds = new Set<string>();

  for (const post of artifact.posts) {
    if (normalizedById.has(post.id)) {
      duplicateIds.add(post.id);
      continue;
    }
    normalizedById.set(post.id, post);
  }

  const missingIds = canonicalPosts
    .map((post) => post.id)
    .filter((id) => !normalizedById.has(id));
  const unexpectedIds = artifact.posts
    .map((post) => post.id)
    .filter((id) => !canonicalById.has(id));

  if (duplicateIds.size > 0 || missingIds.length > 0 || unexpectedIds.length > 0 || artifact.posts.length !== canonicalPosts.length) {
    throw new SocialCopyFinalizeHandlerError(
      'social_copy_finalize_post_id_mismatch',
      'Social-copy finalize response post IDs did not exactly match the canonical weekly-plan post IDs.',
      {
        expected_ids: canonicalPosts.map((post) => post.id),
        received_ids: artifact.posts.map((post) => post.id),
        duplicate_ids: Array.from(duplicateIds),
        missing_ids: missingIds,
        unexpected_ids: unexpectedIds,
      },
    );
  }

  const orderedPosts = canonicalPosts.map((canonicalPost) => {
    const post = normalizedById.get(canonicalPost.id);
    if (!post) {
      throw new SocialCopyFinalizeHandlerError(
        'social_copy_finalize_post_id_mismatch',
        'Social-copy finalize response omitted a canonical post ID.',
        { missing_id: canonicalPost.id },
      );
    }

    if (post.channel !== canonicalPost.channel) {
      throw new SocialCopyFinalizeHandlerError(
        'social_copy_finalize_channel_mismatch',
        `Social-copy finalize response channel mismatch for post ${canonicalPost.id}: expected ${canonicalPost.channel}, received ${post.channel}.`,
        {
          post_id: canonicalPost.id,
          expected_channel: canonicalPost.channel,
          received_channel: post.channel,
        },
      );
    }

    return post;
  });

  return {
    version: artifact.version,
    generated_at: artifact.generated_at,
    posts: orderedPosts,
  };
}

function describeValidationError(post: NormalizedSocialCopyPost, error: string): string {
  switch (error) {
    case 'caption_empty':
      return `Post ${post.id} returned an empty caption. Provide a non-empty image-aware caption.`;
    case 'caption_too_long':
      if (post.channel === 'instagram_feed') {
        return `Post ${post.id} caption is ${post.caption.length} characters. Instagram allows at most 2200 characters.`;
      }
      if (post.channel === 'facebook_feed') {
        return `Post ${post.id} caption is ${post.caption.length} characters. Facebook allows at most 63206 characters.`;
      }
      return `Post ${post.id} caption exceeded the channel limit.`;
    case 'too_many_hashtags':
      return `Post ${post.id} has ${post.hashtags.length} hashtags. Instagram allows at most 30 hashtags.`;
    default:
      return `Post ${post.id} violated validator rule ${error}. Revise the copy to satisfy the channel constraints.`;
  }
}

function validatePost(post: NormalizedSocialCopyPost): ValidatedSocialCopyPost {
  if (!isSupportedValidationChannel(post.channel)) {
    return {
      ...post,
      validationErrors: [],
      warnings: [...post.warnings, `validation_skipped_unsupported_channel:${post.channel}`],
    };
  }

  const result = validateCaption({
    channel: post.channel,
    text: post.caption,
    hashtags: post.hashtags,
  });

  return {
    ...post,
    validationErrors: result.errors,
  };
}

function buildArtifact(
  base: Pick<SocialCopyArtifact, 'version' | 'generated_at'>,
  posts: ValidatedSocialCopyPost[],
  includeValidationWarnings: boolean,
): SocialCopyArtifact {
  return {
    version: base.version,
    generated_at: base.generated_at,
    posts: posts.map((post) => ({
      id: post.id,
      channel: post.channel,
      caption: post.caption,
      hashtags: post.hashtags,
      cta: post.cta,
      warnings: includeValidationWarnings
        ? [...post.warnings, ...post.validationErrors.map((error) => `validator:${error}`)]
        : [...post.warnings],
    })),
  };
}

export function buildSocialCopyConstraintFeedback(posts: SocialCopyFinalizeRetryInvalidPost[]): string {
  const header = [
    'Revise only the invalid posts below.',
    'Keep every post id and channel exactly unchanged.',
    'Return the full strict JSON envelope with version, generated_at, and posts[].',
    'Preserve warnings[] for non-fatal notes and return [] when there are none.',
  ];
  const lines = posts.flatMap((post) => [
    `- ${post.id} (${post.channel})`,
    ...post.validationErrors.map((error) => `  - ${describeValidationError(post, error)}`),
  ]);
  return [...header, ...lines].join('\n');
}

export function validateSocialCopyFinalizeArtifact(input: {
  artifact: SocialCopyArtifact;
  canonicalPosts: SocialCopyFinalizeCanonicalPost[];
}): {
  artifact: SocialCopyArtifact;
  validatedPosts: ValidatedSocialCopyPost[];
  invalidPosts: SocialCopyFinalizeRetryInvalidPost[];
} {
  const canonicalArtifact = reorderAndValidateCanonicalPosts(input.artifact, input.canonicalPosts);
  const validatedPosts = canonicalArtifact.posts.map((post) => validatePost(post));
  const invalidPosts = validatedPosts
    .filter((post) => post.validationErrors.length > 0)
    .map((post) => ({
      id: post.id,
      channel: post.channel,
      caption: post.caption,
      hashtags: post.hashtags,
      cta: post.cta,
      warnings: [...post.warnings],
      validationErrors: [...post.validationErrors],
    }));

  return {
    artifact: canonicalArtifact,
    validatedPosts,
    invalidPosts,
  };
}

export async function handleSocialCopyFinalizeOutput(input: {
  jobId: string;
  output: unknown;
  canonicalPosts: SocialCopyFinalizeCanonicalPost[];
  retry?: SocialCopyFinalizeRetryFn;
  attempt?: number;
}): Promise<SocialCopyFinalizeHandleResult> {
  const attempt = Math.max(0, input.attempt ?? 0);
  const artifact = normalizeSocialCopyFinalizeArtifact(input.output);
  const { artifact: canonicalArtifact, validatedPosts, invalidPosts } = validateSocialCopyFinalizeArtifact({
    artifact,
    canonicalPosts: input.canonicalPosts,
  });

  if (invalidPosts.length === 0) {
    const persisted = await writeSocialCopyArtifact(input.jobId, canonicalArtifact);
    return {
      status: 'completed',
      artifact: canonicalArtifact,
      persisted,
      invalidPostCount: 0,
      retrySubmitted: false,
      constraintFeedback: null,
    };
  }

  if (attempt < 1 && input.retry) {
    const validPosts = validatedPosts.filter((post) => post.validationErrors.length === 0);
    const persisted = validPosts.length > 0
      ? await writeSocialCopyArtifact(
          input.jobId,
          buildArtifact(canonicalArtifact, validPosts, false),
        )
      : null;
    const constraintFeedback = buildSocialCopyConstraintFeedback(invalidPosts);
    await input.retry({
      attempt: attempt + 1,
      constraintFeedback,
      invalidPosts,
      artifact: canonicalArtifact,
    });
    return {
      status: 'retry_submitted',
      artifact: canonicalArtifact,
      persisted,
      invalidPostCount: invalidPosts.length,
      retrySubmitted: true,
      constraintFeedback,
    };
  }

  const persisted = await writeSocialCopyArtifact(
    input.jobId,
    buildArtifact(canonicalArtifact, validatedPosts, true),
  );
  return {
    status: 'completed_with_warnings',
    artifact: persisted.artifact,
    persisted,
    invalidPostCount: invalidPosts.length,
    retrySubmitted: false,
    constraintFeedback: null,
  };
}
