import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSocialCopyConstraintFeedback,
  normalizeSocialCopyFinalizeArtifact,
  SocialCopyFinalizeHandlerError,
  validateSocialCopyFinalizeArtifact,
} from '../../backend/social-content/copy-finalize-handler';
import type { SocialCopyArtifact } from '../../backend/social-content/types';

function artifact(posts: SocialCopyArtifact['posts']): SocialCopyArtifact {
  return {
    version: '2026-05-social-copy-v1',
    generated_at: '2026-05-18T00:00:00.000Z',
    posts,
  };
}

const canonicalPosts = [
  { id: 'post-1', channel: 'instagram_feed' },
  { id: 'post-2', channel: 'facebook_feed' },
] as const;

test('normalizeSocialCopyFinalizeArtifact unwraps nested social_copy payloads', () => {
  const normalized = normalizeSocialCopyFinalizeArtifact({
    social_copy: artifact([
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Final caption',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
    ]),
  });

  assert.equal(normalized.posts[0]?.id, 'post-1');
  assert.equal(normalized.posts[0]?.caption, 'Final caption');
});

test('normalizeSocialCopyFinalizeArtifact fails loudly when required envelope fields are missing', () => {
  assert.throws(
    () => normalizeSocialCopyFinalizeArtifact({ posts: [] }),
    (error: unknown) => error instanceof SocialCopyFinalizeHandlerError
      && error.code === 'social_copy_finalize_output_invalid',
  );
});

test('validateSocialCopyFinalizeArtifact reorders posts into canonical weekly-plan order', () => {
  const result = validateSocialCopyFinalizeArtifact({
    artifact: artifact([
      {
        id: 'post-2',
        channel: 'facebook_feed',
        caption: 'Facebook proof',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Instagram proof',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
    ]),
    canonicalPosts: [...canonicalPosts],
  });

  assert.deepEqual(result.artifact.posts.map((post) => post.id), ['post-1', 'post-2']);
  assert.equal(result.invalidPosts.length, 0);
});

test('validateSocialCopyFinalizeArtifact reports Instagram hashtag cap violations', () => {
  const result = validateSocialCopyFinalizeArtifact({
    artifact: artifact([
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Instagram proof',
        hashtags: Array.from({ length: 31 }, (_, index) => `#tag${index}`),
        cta: 'Book now',
        warnings: [],
      },
      {
        id: 'post-2',
        channel: 'facebook_feed',
        caption: 'Facebook proof',
        hashtags: [],
        cta: 'Book now',
        warnings: [],
      },
    ]),
    canonicalPosts: [...canonicalPosts],
  });

  assert.deepEqual(result.invalidPosts.map((post) => post.id), ['post-1']);
  assert.deepEqual(result.invalidPosts[0]?.validationErrors, ['too_many_hashtags']);
});

test('validateSocialCopyFinalizeArtifact reports Facebook caption length violations', () => {
  const result = validateSocialCopyFinalizeArtifact({
    artifact: artifact([
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Instagram proof',
        hashtags: [],
        cta: 'Book now',
        warnings: [],
      },
      {
        id: 'post-2',
        channel: 'facebook_feed',
        caption: 'x'.repeat(63207),
        hashtags: ['#ok'],
        cta: 'Book now',
        warnings: [],
      },
    ]),
    canonicalPosts: [...canonicalPosts],
  });

  assert.deepEqual(result.invalidPosts.map((post) => post.id), ['post-2']);
  assert.deepEqual(result.invalidPosts[0]?.validationErrors, ['caption_too_long']);
});

test('validateSocialCopyFinalizeArtifact skips validation for unsupported channels and records a warning instead', () => {
  const result = validateSocialCopyFinalizeArtifact({
    artifact: artifact([
      {
        id: 'post-3',
        channel: 'linkedin_feed',
        caption: 'LinkedIn proof',
        hashtags: ['#Leadership'],
        cta: 'Book now',
        warnings: [],
      },
    ]),
    canonicalPosts: [{ id: 'post-3', channel: 'linkedin_feed' }],
  });

  assert.equal(result.invalidPosts.length, 0);
  assert.deepEqual(result.validatedPosts[0]?.warnings, ['validation_skipped_unsupported_channel:linkedin_feed']);
});

test('validateSocialCopyFinalizeArtifact fails loudly on duplicate or unexpected post ids', () => {
  assert.throws(
    () => validateSocialCopyFinalizeArtifact({
      artifact: artifact([
        {
          id: 'post-1',
          channel: 'instagram_feed',
          caption: 'Instagram proof',
          hashtags: [],
          cta: 'Book now',
          warnings: [],
        },
        {
          id: 'post-1',
          channel: 'instagram_feed',
          caption: 'Duplicate proof',
          hashtags: [],
          cta: 'Book now',
          warnings: [],
        },
      ]),
      canonicalPosts: [...canonicalPosts],
    }),
    (error: unknown) => error instanceof SocialCopyFinalizeHandlerError
      && error.code === 'social_copy_finalize_post_id_mismatch',
  );
});

test('validateSocialCopyFinalizeArtifact fails loudly on channel mismatches', () => {
  assert.throws(
    () => validateSocialCopyFinalizeArtifact({
      artifact: artifact([
        {
          id: 'post-1',
          channel: 'facebook_feed',
          caption: 'Wrong channel',
          hashtags: [],
          cta: 'Book now',
          warnings: [],
        },
        {
          id: 'post-2',
          channel: 'facebook_feed',
          caption: 'Right channel',
          hashtags: [],
          cta: 'Book now',
          warnings: [],
        },
      ]),
      canonicalPosts: [...canonicalPosts],
    }),
    (error: unknown) => error instanceof SocialCopyFinalizeHandlerError
      && error.code === 'social_copy_finalize_channel_mismatch',
  );
});

test('buildSocialCopyConstraintFeedback spells out validator caps for retry prompts', () => {
  const feedback = buildSocialCopyConstraintFeedback([
    {
      id: 'post-1',
      channel: 'instagram_feed',
      caption: 'Instagram proof',
      hashtags: Array.from({ length: 31 }, (_, index) => `#tag${index}`),
      cta: 'Book now',
      warnings: [],
      validationErrors: ['too_many_hashtags', 'caption_too_long'],
    },
  ]);

  assert.match(feedback, /Keep every post id and channel exactly unchanged/);
  assert.match(feedback, /Instagram allows at most 30 hashtags/);
  assert.match(feedback, /Instagram allows at most 2200 characters/);
});
