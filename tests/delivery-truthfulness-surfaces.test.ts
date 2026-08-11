/**
 * Deliverable A (AA-217 v2) — the UI surfaces that must state what a tenant's
 * platforms actually deliver.
 *
 * Every assertion here is one of two kinds:
 *   (a) FLAG-OFF / META PARITY — the surface is byte-identical for the tenants
 *       publishing today. These are the load-bearing ones: merge auto-deploys.
 *   (b) TRUTHFULNESS — with a real non-Meta composition the surface names THIS
 *       tenant's platforms and no others.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCaption, weightedCaptionLengthForX } from '@/backend/social-content/caption-validator';
import { captionChannelForReviewItem } from '@/backend/marketing/runtime-views';
import { weightedXLength } from '@/backend/marketing/weekly-crosspost';
import { evaluateGenerateThisWeekGate } from '@/frontend/aries-v1/generate-this-week';
import { formatPlatformLabel } from '@/frontend/aries-v1/labels';
import { createCalendarViewModel } from '@/frontend/aries-v1/view-models/calendar';
import { resolveWeeklyDeliverySurfaces } from '@/frontend/social-content/delivery-surfaces';
import type { IntegrationCard } from '@/lib/api/integrations';

// ---------------------------------------------------------------------------
// The weekly intake form's honesty rule.
// ---------------------------------------------------------------------------

test('unknown connections render the unchanged form — never a fabricated restriction', () => {
  for (const input of [null, undefined, [], ['openai'], ['meta_ads']]) {
    const surfaces = resolveWeeklyDeliverySurfaces(input as string[] | null | undefined);
    assert.equal(surfaces.known, false, `input ${JSON.stringify(input)} must read as unknown`);
    assert.equal(surfaces.feedOnly, false, 'an unknown tenant must not have stories/reels disabled');
    assert.equal(surfaces.notice, null);
  }
});

test('a Meta-connected tenant keeps stories and reels (parity)', () => {
  for (const connected of [['facebook'], ['instagram'], ['facebook', 'instagram', 'linkedin']]) {
    const surfaces = resolveWeeklyDeliverySurfaces(connected);
    assert.equal(surfaces.hasMetaSurface, true);
    assert.equal(surfaces.feedOnly, false);
    assert.equal(surfaces.notice, null, 'no notice at all for a Meta tenant — the form is untouched');
  }
});

test('a LinkedIn-only tenant is told it is feed-only, and only about LinkedIn', () => {
  const surfaces = resolveWeeklyDeliverySurfaces(['linkedin']);
  assert.equal(surfaces.feedOnly, true);
  assert.deepEqual(surfaces.platforms, ['linkedin']);
  assert.ok(surfaces.notice);
  assert.match(surfaces.notice, /Facebook and Instagram only/);
  assert.match(surfaces.notice, /LinkedIn receives feed posts/);
  assert.match(surfaces.notice, /feed-only/);
  // Reviewer-required change 3: no hardcoded "(LinkedIn, X, Reddit)".
  assert.doesNotMatch(surfaces.notice, /Reddit/);
  assert.doesNotMatch(surfaces.notice, /\bX\b/);
});

test('a multi-platform non-Meta tenant is told about exactly its own platforms', () => {
  const surfaces = resolveWeeklyDeliverySurfaces(['reddit', 'linkedin']);
  assert.deepEqual(surfaces.platforms, ['linkedin', 'reddit'], 'canonical order, not input order');
  assert.ok(surfaces.notice);
  assert.match(surfaces.notice, /LinkedIn and Reddit receive feed posts/);
  assert.doesNotMatch(surfaces.notice, /\bX\b/);
});

test('non-platform integration cards cannot leak into the notice', () => {
  const surfaces = resolveWeeklyDeliverySurfaces(['linkedin', 'openai', '<script>alert(1)</script>']);
  assert.deepEqual(surfaces.platforms, ['linkedin']);
  assert.ok(surfaces.notice);
  assert.doesNotMatch(surfaces.notice, /script/);
});

// ---------------------------------------------------------------------------
// The weekly intake screen actually renders it.
// ---------------------------------------------------------------------------

async function renderNewJobScreen(connectedPlatforms: string[] | null | undefined) {
  const React = (await import('react')).default;
  const { act, create } = await import('react-test-renderer');
  const { SocialContentNewJobScreenContent } = await import('@/frontend/social-content/new-job');

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(SocialContentNewJobScreenContent, {
        embedded: true,
        router: { push() {} },
        connectedPlatforms,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return root;
}

test('intake screen: a LinkedIn-only tenant sees the feed-only notice and cannot request stories', async () => {
  const root = await renderNewJobScreen(['linkedin']);
  const json = JSON.stringify(root.toJSON());

  assert.match(json, /Stories and reels publish to Facebook and Instagram only/);
  assert.match(json, /LinkedIn receives feed posts/);
  assert.doesNotMatch(json, /Reddit/, 'a LinkedIn-only tenant is never told about Reddit');

  // The story input is clamped AND disabled, so the form cannot post a request
  // for a surface that will be dropped.
  const storyNotice = root.root.findAllByProps({ 'data-testid': 'story-feed-only-notice' });
  assert.ok(storyNotice.length > 0);
  const reelNotice = root.root.findAllByProps({ 'data-testid': 'reel-feed-only-notice' });
  assert.ok(reelNotice.length > 0);
  const chips = root.root.findAllByProps({ 'data-testid': 'connected-platform-chips' });
  assert.ok(chips.length > 0, 'the Meta/Instagram checkboxes are replaced by read-only chips');
  assert.doesNotMatch(json, /Enable rendered video output[\s\S]{0,200}Reel audio/);
});

test('intake screen: a Meta tenant and an unknown tenant both get the unchanged form (parity)', async () => {
  for (const connected of [['facebook', 'instagram'], null]) {
    const root = await renderNewJobScreen(connected as string[] | null);
    const json = JSON.stringify(root.toJSON());
    assert.doesNotMatch(json, /Stories and reels publish to/, `unexpected notice for ${JSON.stringify(connected)}`);
    assert.equal(root.root.findAllByProps({ 'data-testid': 'story-feed-only-notice' }).length, 0);
    assert.equal(root.root.findAllByProps({ 'data-testid': 'connected-platform-chips' }).length, 0);
    // The Meta/Instagram checkboxes are still the platform control.
    assert.match(json, /Instagram/);
  }
});

// ---------------------------------------------------------------------------
// The dashboard Generate-this-week gate.
// ---------------------------------------------------------------------------

function card(platform: string, state: IntegrationCard['connection_state'] = 'connected'): IntegrationCard {
  return { platform, connection_state: state } as unknown as IntegrationCard;
}

const READY_PROFILE = { incomplete: false } as never;

test('gate: flag OFF keeps the legacy Meta-only verdict and copy (parity)', () => {
  const linkedInOnly = evaluateGenerateThisWeekGate({
    profile: READY_PROFILE,
    integrationCards: [card('linkedin')],
    posts: [],
  });
  assert.equal(linkedInOnly.gate, 'no_meta_connection');
  assert.equal(linkedInOnly.enabled, false);
  assert.equal(
    linkedInOnly.disabledReason,
    'Connect a Facebook or Instagram account before generating this week’s posts.',
  );

  const metaTenant = evaluateGenerateThisWeekGate({
    profile: READY_PROFILE,
    integrationCards: [card('facebook')],
    posts: [],
  });
  assert.equal(metaTenant.gate, 'ready');
  assert.equal(metaTenant.enabled, true);
});

test('gate: flag ON, a connected LinkedIn unblocks generation', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: READY_PROFILE,
    integrationCards: [card('linkedin')],
    posts: [],
    anyPlatformEnabled: true,
    publishablePlatforms: ['facebook', 'instagram', 'linkedin'],
  });
  assert.equal(state.gate, 'ready');
  assert.equal(state.enabled, true);
});

test('gate: flag ON with nothing connected says "a social account", not "Facebook or Instagram"', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: READY_PROFILE,
    integrationCards: [card('linkedin', 'not_connected')],
    posts: [],
    anyPlatformEnabled: true,
    publishablePlatforms: ['facebook', 'instagram', 'linkedin'],
  });
  assert.equal(state.gate, 'channel_not_connected');
  assert.equal(state.enabled, false);
  assert.equal(state.disabledReason, 'Connect a social account before generating this week’s posts.');
});

test('gate: flag ON is a strict superset — every Meta tenant still passes', () => {
  for (const platform of ['facebook', 'instagram']) {
    const state = evaluateGenerateThisWeekGate({
      profile: READY_PROFILE,
      integrationCards: [card(platform)],
      posts: [],
      anyPlatformEnabled: true,
      publishablePlatforms: ['facebook', 'instagram', 'x', 'linkedin', 'reddit'],
    });
    assert.equal(state.gate, 'ready', `${platform} must still pass with the flag on`);
  }
});

test('gate: a platform this deployment cannot publish to does not unblock', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: READY_PROFILE,
    integrationCards: [card('youtube')],
    posts: [],
    anyPlatformEnabled: true,
    publishablePlatforms: ['facebook', 'instagram', 'linkedin'],
  });
  assert.equal(state.gate, 'channel_not_connected');
});

// ---------------------------------------------------------------------------
// Calendar: the degenerate row no longer claims to be Meta.
// ---------------------------------------------------------------------------

function scheduledPost(overrides: Record<string, unknown>) {
  return {
    id: 'sp_1',
    postId: 'p_1',
    jobId: 'j_1',
    title: 'A post',
    platform: '',
    targetPlatforms: [],
    scheduledFor: '2026-08-12T15:00:00.000Z',
    dispatchStatus: 'pending',
    dispatches: [],
    ...overrides,
  } as never;
}

test('calendar: a row that names no platform is neutral, not "meta"', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [scheduledPost({})],
    posts: [],
    timeZone: 'UTC',
  });
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].platform, 'social');
  // Reviewer-required change 5: the neutral value must RENDER, not leak raw.
  assert.equal(formatPlatformLabel(model.events[0].platform), 'Social');
});

test('calendar: a row that does name a platform is unchanged (parity)', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [
      scheduledPost({ platform: 'facebook' }),
      scheduledPost({ id: 'sp_2', postId: 'p_2', platform: '', targetPlatforms: ['linkedin'] }),
    ],
    posts: [],
    timeZone: 'UTC',
  });
  assert.deepEqual(model.events.map((e) => e.platform), ['facebook', 'linkedin']);
});

test('formatPlatformLabel covers every platform the calendar can carry', () => {
  assert.equal(formatPlatformLabel('meta'), 'Meta');
  assert.equal(formatPlatformLabel('facebook'), 'Facebook');
  assert.equal(formatPlatformLabel('instagram'), 'Instagram');
  assert.equal(formatPlatformLabel('linkedin'), 'LinkedIn');
  assert.equal(formatPlatformLabel('x'), 'X');
  assert.equal(formatPlatformLabel('reddit'), 'Reddit');
  assert.equal(formatPlatformLabel('youtube'), 'YouTube');
  assert.equal(formatPlatformLabel('social'), 'Social');
  assert.equal(formatPlatformLabel(''), 'Social', 'empty never renders as blank');
  assert.equal(formatPlatformLabel(null), 'Social');
  assert.equal(formatPlatformLabel('threads'), 'Threads', 'an unknown future platform still title-cases');
});

test('every surface spells a platform the same way (one label map, not four)', async () => {
  const { deliveryPlatformLabel } = await import('@/backend/marketing/delivery-composition');
  const { deliveryPlatformLabel: formLabel } = await import('@/frontend/social-content/delivery-surfaces');
  const { KNOWN_PROMPT_PLATFORMS } = await import('@/backend/social-content/platform-copy-directives');

  for (const platform of KNOWN_PROMPT_PLATFORMS) {
    const report = deliveryPlatformLabel(platform);
    assert.equal(formLabel(platform), report, `intake form disagrees on ${platform}`);
    assert.equal(formatPlatformLabel(platform), report, `calendar/dashboard disagrees on ${platform}`);
  }
});

// ---------------------------------------------------------------------------
// Review tray: the three networks that used to be validated against nothing.
// ---------------------------------------------------------------------------

test('caption validator: Meta branches are unchanged (parity)', () => {
  assert.deepEqual(validateCaption({ channel: 'instagram_feed', text: 'ok' }), { ok: true, errors: [] });
  assert.deepEqual(
    validateCaption({ channel: 'instagram_feed', text: 'x'.repeat(2201) }).errors,
    ['caption_too_long'],
  );
  assert.deepEqual(
    validateCaption({ channel: 'instagram_feed', text: 'ok', hashtags: Array(31).fill('#a') }).errors,
    ['too_many_hashtags'],
  );
  assert.deepEqual(validateCaption({ channel: 'facebook_feed', text: 'x'.repeat(63206) }), { ok: true, errors: [] });
});

test('caption validator: LinkedIn is held to the limit the publisher enforces', () => {
  assert.equal(validateCaption({ channel: 'linkedin_feed', text: 'x'.repeat(2900) }).ok, true);
  assert.deepEqual(validateCaption({ channel: 'linkedin_feed', text: 'x'.repeat(2901) }).errors, ['caption_too_long']);
  assert.deepEqual(
    validateCaption({ channel: 'linkedin_feed', text: 'ok', hashtags: Array(6).fill('#a') }).errors,
    ['too_many_hashtags'],
  );
});

test('caption validator: X counts weighted characters, not code points', () => {
  assert.equal(validateCaption({ channel: 'x_feed', text: 'x'.repeat(270) }).ok, true);
  assert.deepEqual(validateCaption({ channel: 'x_feed', text: 'x'.repeat(271) }).errors, ['caption_too_long']);
  // A short URL still costs 23, so a caption that "fits" by length does not fit.
  const withUrl = `${'x'.repeat(255)} https://a.co`;
  assert.ok(withUrl.length <= 270, 'the raw string is inside the naive limit');
  assert.deepEqual(validateCaption({ channel: 'x_feed', text: withUrl }).errors, ['caption_too_long']);
  assert.deepEqual(validateCaption({ channel: 'x_feed', text: 'ok', hashtags: ['#a', '#b'] }).errors, ['too_many_hashtags']);
});

test('the tray weight counter agrees with the dispatch adapter it predicts', () => {
  for (const sample of [
    'plain text',
    'https://example.com/a/very/long/path?with=query',
    'emoji 😀 and 中文 characters',
    'two https://a.co links https://b.co here',
    '',
  ]) {
    assert.equal(
      weightedCaptionLengthForX(sample),
      weightedXLength(sample),
      `weight must match the adapter for: ${JSON.stringify(sample)}`,
    );
  }
});

test('caption validator: Reddit governs the title line and rejects hashtags', () => {
  const longTitle = `${'t'.repeat(281)}\n\nbody`;
  assert.deepEqual(validateCaption({ channel: 'reddit_post', text: longTitle }).errors, ['title_too_long']);
  const longBody = `${'t'.repeat(200)}\n\n${'b'.repeat(5000)}`;
  assert.equal(validateCaption({ channel: 'reddit_post', text: longBody }).ok, true, 'the body is not the title');
  assert.deepEqual(
    validateCaption({ channel: 'reddit_post', text: 'A title', hashtags: ['#a'] }).errors,
    ['hashtags_not_supported'],
  );
});

test('review items on non-Meta networks now resolve a channel instead of null', () => {
  const item = (channel: string, placement = '') =>
    ({ channel, placement, workflowStage: '' }) as never;
  assert.equal(captionChannelForReviewItem(item('instagram')), 'instagram_feed');
  assert.equal(captionChannelForReviewItem(item('facebook')), 'facebook_feed');
  assert.equal(captionChannelForReviewItem(item('meta')), 'facebook_feed');
  assert.equal(captionChannelForReviewItem(item('linkedin')), 'linkedin_feed');
  assert.equal(captionChannelForReviewItem(item('reddit')), 'reddit_post');
  assert.equal(captionChannelForReviewItem(item('x')), 'x_feed');
  assert.equal(captionChannelForReviewItem(item('twitter')), 'x_feed');
});

test('"x" is matched as a token, never as a substring', () => {
  const item = (channel: string, placement = '') =>
    ({ channel, placement, workflowStage: '' }) as never;
  // These all contain the letter x and must NOT be read as the X network.
  assert.equal(captionChannelForReviewItem(item('export')), null);
  assert.equal(captionChannelForReviewItem(item('next_stage')), null);
  assert.equal(captionChannelForReviewItem(item('xl_banner')), null);
});
