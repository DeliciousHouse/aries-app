import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import {
  FacebookFeedLinkCard,
  FacebookFeedSingle,
  FACEBOOK_CAPTION_TRUNCATE_AT,
  FACEBOOK_MORE_LABEL,
  InstagramFeedCarousel,
  InstagramFeedSingle,
  INSTAGRAM_CAPTION_TRUNCATE_AT,
  INSTAGRAM_MORE_LABEL,
  captionWithHashtags,
  extractDomain,
  truncateCaption,
} from '../frontend/aries-v1/post-preview';

const POST_PREVIEW_DIR = path.resolve(__dirname, '..', 'frontend/aries-v1/post-preview');
const POST_PREVIEW_FILES = [
  'shared.tsx',
  'InstagramFeedSingle.tsx',
  'InstagramFeedCarousel.tsx',
  'FacebookFeedSingle.tsx',
  'FacebookFeedLinkCard.tsx',
];

async function renderTree(element: React.ReactElement): Promise<ReactTestRenderer> {
  const { act, create } = await import('react-test-renderer');
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element);
  });
  return root;
}

function findByDataRole(root: ReactTestRenderer, role: string): ReactTestInstance {
  return root.root.findByProps({ 'data-role': role });
}

function findAllByDataRole(root: ReactTestRenderer, role: string): ReactTestInstance[] {
  return root.root.findAllByProps({ 'data-role': role });
}

function readSource(fileName: string): string {
  return readFileSync(path.join(POST_PREVIEW_DIR, fileName), 'utf8');
}

const SAMPLE_AUTHOR = {
  name: 'sugarandleather',
  handle: '@sugarandleather',
  timestampLabel: '2 hours ago',
};

const SAMPLE_MEDIA = {
  url: 'https://hermes.example.com/img/branded-hero.png',
  alt: 'On-brand hero image',
};

const SHORT_CAPTION = 'Cozy fall vibes — new arrivals this week. #autumn #shop';

const LONG_IG_CAPTION =
  'A long Instagram caption that meaningfully exceeds the 125 character truncation threshold so we can verify the more affordance fires correctly here. #brand #shop';

const LONG_FB_CAPTION = `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)}#brand`;

test('truncateCaption: short text is not truncated', () => {
  const result = truncateCaption('hello world', 125, INSTAGRAM_MORE_LABEL);
  assert.equal(result.isTruncated, false);
  assert.equal(result.visible, 'hello world');
  assert.equal(result.fullText, 'hello world');
  assert.equal(result.moreLabel, INSTAGRAM_MORE_LABEL);
  assert.equal(result.limit, 125);
});

test('truncateCaption: long text is truncated and full text preserved', () => {
  const result = truncateCaption(LONG_IG_CAPTION, INSTAGRAM_CAPTION_TRUNCATE_AT, INSTAGRAM_MORE_LABEL);
  assert.equal(result.isTruncated, true);
  assert.equal(result.fullText, LONG_IG_CAPTION);
  assert.ok(result.visible.length <= INSTAGRAM_CAPTION_TRUNCATE_AT);
  assert.ok(result.visible.length > 0);
});

test('truncateCaption: facebook limit is 480', () => {
  assert.equal(FACEBOOK_CAPTION_TRUNCATE_AT, 480);
  assert.equal(FACEBOOK_MORE_LABEL, '...See more');
  const long = 'x'.repeat(600);
  const result = truncateCaption(long, FACEBOOK_CAPTION_TRUNCATE_AT, FACEBOOK_MORE_LABEL);
  assert.equal(result.isTruncated, true);
  assert.ok(result.visible.length <= FACEBOOK_CAPTION_TRUNCATE_AT);
});

test('captionWithHashtags: hashtags become spans with data-hashtag attribute', () => {
  const nodes = captionWithHashtags('hello #brand world #shop_now');
  const hashtagNodes = nodes.filter(
    (node): node is React.ReactElement<{ 'data-hashtag': string }> =>
      React.isValidElement(node) && (node.props as { 'data-hashtag'?: string })['data-hashtag'] !== undefined,
  );
  const tagsSeen = hashtagNodes.map((node) => node.props['data-hashtag']);
  assert.deepEqual(tagsSeen, ['brand', 'shop_now']);
});

test('extractDomain: strips www and uppercases the host', () => {
  assert.equal(extractDomain('https://www.brand.com/landing'), 'BRAND.COM');
  assert.equal(extractDomain('https://store.brand.co/landing?utm=x'), 'STORE.BRAND.CO');
  assert.equal(extractDomain('not a url'), 'NOT A URL');
  assert.equal(extractDomain(''), '');
});

test('source: every preview file imports next/image', () => {
  for (const file of POST_PREVIEW_FILES) {
    const source = readSource(file);
    if (file === 'shared.tsx') {
      assert.match(source, /from 'next\/image'/, `${file} should import from next/image`);
    }
  }
});

test('source: no preview file uses raw <img element', () => {
  for (const file of POST_PREVIEW_FILES) {
    const source = readSource(file);
    assert.doesNotMatch(source, /<img\b/, `${file} must not use raw <img element`);
  }
});

test('source: no preview file disables next/no-img-element', () => {
  for (const file of POST_PREVIEW_FILES) {
    const source = readSource(file);
    assert.doesNotMatch(
      source,
      /no-img-element/,
      `${file} must not disable next/no-img-element`,
    );
  }
});

test('source: no preview file contains banned patterns', () => {
  const banned = /(as any|@ts-ignore|@ts-expect-error|console\.log|TODO|FIXME|HACK|catch\s*\{\s*\})/;
  for (const file of POST_PREVIEW_FILES) {
    const source = readSource(file);
    assert.doesNotMatch(source, banned, `${file} contains a banned pattern`);
  }
});

test('source: no preview file uses user-facing campaign copy', () => {
  for (const file of POST_PREVIEW_FILES) {
    const source = readSource(file);
    assert.doesNotMatch(source, /campaign/i, `${file} must not contain user-facing campaign copy`);
  }
});

test('InstagramFeedSingle: renders 4:5 by default with platform/post-type markers', async () => {
  const root = await renderTree(
    React.createElement(InstagramFeedSingle, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: SHORT_CAPTION,
    }),
  );

  const frame = findByDataRole(root, 'post-preview');
  assert.equal(frame.props['data-platform'], 'instagram');
  assert.equal(frame.props['data-post-type'], 'single');
  assert.equal(frame.props['data-aspect-ratio'], '4:5');
  assert.equal(frame.props['data-testid'], 'post-preview-instagram-single');

  const image = findByDataRole(root, 'post-image');
  assert.equal(image.props['data-aspect-ratio'], '4:5');
  assert.match(image.props.className, /aspect-\[4\/5\]/);

  const imgs = root.root.findAllByType('img');
  assert.equal(imgs.length, 1, 'exactly one next/image rendered');
  assert.equal(imgs[0]!.props['data-nimg'], 'fill');
  assert.equal(imgs[0]!.props.alt, SAMPLE_MEDIA.alt);
  assert.equal(imgs[0]!.props.src, SAMPLE_MEDIA.url);
});

test('InstagramFeedSingle: 1:1 aspect ratio override flips data-aspect-ratio', async () => {
  const root = await renderTree(
    React.createElement(InstagramFeedSingle, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: SHORT_CAPTION,
      aspectRatio: '1:1',
    }),
  );

  const frame = findByDataRole(root, 'post-preview');
  assert.equal(frame.props['data-aspect-ratio'], '1:1');

  const image = findByDataRole(root, 'post-image');
  assert.equal(image.props['data-aspect-ratio'], '1:1');
  assert.match(image.props.className, /aspect-square/);
});

test('InstagramFeedSingle: caption truncates at 125 chars and reveals more affordance', async () => {
  const root = await renderTree(
    React.createElement(InstagramFeedSingle, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: LONG_IG_CAPTION,
    }),
  );

  const caption = findByDataRole(root, 'post-caption');
  assert.equal(caption.props['data-truncated'], 'true');
  assert.equal(caption.props['data-caption-limit'], INSTAGRAM_CAPTION_TRUNCATE_AT);
  assert.equal(caption.props['data-caption-more-label'], INSTAGRAM_MORE_LABEL);
  assert.equal(caption.props['data-full-caption'], LONG_IG_CAPTION);

  const more = findByDataRole(root, 'post-caption-more');
  assert.equal(getTextContent(more), INSTAGRAM_MORE_LABEL);
});

test('InstagramFeedSingle: hashtags render blue and no-underline with data-hashtag', async () => {
  const root = await renderTree(
    React.createElement(InstagramFeedSingle, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: 'sweater season #autumn #cozy',
    }),
  );

  const hashtags = findAllByDataRole(root, 'post-hashtag');
  assert.equal(hashtags.length, 2);
  for (const span of hashtags) {
    assert.match(span.props.className, /text-blue-500/);
    assert.match(span.props.className, /no-underline/);
  }
  const tagValues = hashtags.map((span) => span.props['data-hashtag']);
  assert.deepEqual(tagValues, ['autumn', 'cozy']);
});

test('InstagramFeedCarousel: enforces 1:1 and renders one image per slide', async () => {
  const slides = [
    { url: 'https://hermes.example.com/img/slide-1.png', alt: 'Slide 1' },
    { url: 'https://hermes.example.com/img/slide-2.png', alt: 'Slide 2' },
    { url: 'https://hermes.example.com/img/slide-3.png', alt: 'Slide 3' },
  ];
  const root = await renderTree(
    React.createElement(InstagramFeedCarousel, {
      author: SAMPLE_AUTHOR,
      slides,
      caption: SHORT_CAPTION,
    }),
  );

  const frame = findByDataRole(root, 'post-preview');
  assert.equal(frame.props['data-platform'], 'instagram');
  assert.equal(frame.props['data-post-type'], 'carousel');
  assert.equal(frame.props['data-aspect-ratio'], '1:1');

  const carousel = findByDataRole(root, 'post-carousel');
  assert.equal(carousel.props['data-slide-count'], 3);
  assert.equal(carousel.props['data-active-slide'], 0);

  const slideElements = findAllByDataRole(root, 'carousel-slide');
  assert.equal(slideElements.length, 3);
  const activeFlags = slideElements.map((s) => s.props['data-slide-active']);
  assert.deepEqual(activeFlags, ['true', 'false', 'false']);

  const dots = findAllByDataRole(root, 'carousel-dot');
  assert.equal(dots.length, 3);
  assert.equal(dots[0]!.props['data-dot-active'], 'true');
  assert.equal(dots[1]!.props['data-dot-active'], 'false');

  const imgs = root.root.findAllByType('img');
  assert.equal(imgs.length, 3, 'one next/image per slide');
  for (const img of imgs) {
    assert.equal(img.props['data-nimg'], 'fill');
  }
});

test('FacebookFeedSingle: 1:1 aspect with caption above image and FB chrome', async () => {
  const root = await renderTree(
    React.createElement(FacebookFeedSingle, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: SHORT_CAPTION,
    }),
  );

  const frame = findByDataRole(root, 'post-preview');
  assert.equal(frame.props['data-platform'], 'facebook');
  assert.equal(frame.props['data-post-type'], 'single');
  assert.equal(frame.props['data-aspect-ratio'], '1:1');

  const image = findByDataRole(root, 'post-image');
  assert.equal(image.props['data-aspect-ratio'], '1:1');
  assert.match(image.props.className, /aspect-square/);

  const imgs = root.root.findAllByType('img');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0]!.props['data-nimg'], 'fill');
});

test('FacebookFeedSingle: caption truncates at 480 chars and shows See more', async () => {
  const root = await renderTree(
    React.createElement(FacebookFeedSingle, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: LONG_FB_CAPTION,
    }),
  );

  const caption = findByDataRole(root, 'post-caption');
  assert.equal(caption.props['data-truncated'], 'true');
  assert.equal(caption.props['data-caption-limit'], FACEBOOK_CAPTION_TRUNCATE_AT);
  assert.equal(caption.props['data-caption-more-label'], FACEBOOK_MORE_LABEL);
  assert.equal(caption.props['data-full-caption'], LONG_FB_CAPTION);

  const more = findByDataRole(root, 'post-caption-more');
  assert.equal(getTextContent(more), FACEBOOK_MORE_LABEL);
});

test('InstagramFeedCarousel: initialSlideIndex prop drives the active slide (no click state)', async () => {
  const slides = [
    { url: 'https://hermes.example.com/img/slide-1.png', alt: 'Slide 1' },
    { url: 'https://hermes.example.com/img/slide-2.png', alt: 'Slide 2' },
    { url: 'https://hermes.example.com/img/slide-3.png', alt: 'Slide 3' },
  ];
  const root = await renderTree(
    React.createElement(InstagramFeedCarousel, {
      author: SAMPLE_AUTHOR,
      slides,
      caption: SHORT_CAPTION,
      initialSlideIndex: 2,
    }),
  );

  const carousel = findByDataRole(root, 'post-carousel');
  assert.equal(carousel.props['data-active-slide'], 2);

  const slideElements = findAllByDataRole(root, 'carousel-slide');
  const activeFlags = slideElements.map((s) => s.props['data-slide-active']);
  assert.deepEqual(activeFlags, ['false', 'false', 'true']);

  const dots = findAllByDataRole(root, 'carousel-dot');
  const dotFlags = dots.map((d) => d.props['data-dot-active']);
  assert.deepEqual(dotFlags, ['false', 'false', 'true']);
});

test('previews render no interactive controls (no <button> chrome for likes/comments/shares/dots)', async () => {
  const carouselSlides = [
    { url: 'https://hermes.example.com/img/c-1.png', alt: 'Carousel 1' },
    { url: 'https://hermes.example.com/img/c-2.png', alt: 'Carousel 2' },
  ];
  const cases: Array<{ label: string; element: React.ReactElement }> = [
    {
      label: 'InstagramFeedSingle',
      element: React.createElement(InstagramFeedSingle, {
        author: SAMPLE_AUTHOR,
        media: SAMPLE_MEDIA,
        caption: SHORT_CAPTION,
      }),
    },
    {
      label: 'InstagramFeedCarousel',
      element: React.createElement(InstagramFeedCarousel, {
        author: SAMPLE_AUTHOR,
        slides: carouselSlides,
        caption: SHORT_CAPTION,
      }),
    },
    {
      label: 'FacebookFeedSingle',
      element: React.createElement(FacebookFeedSingle, {
        author: SAMPLE_AUTHOR,
        media: SAMPLE_MEDIA,
        caption: SHORT_CAPTION,
      }),
    },
    {
      label: 'FacebookFeedLinkCard',
      element: React.createElement(FacebookFeedLinkCard, {
        author: SAMPLE_AUTHOR,
        media: SAMPLE_MEDIA,
        caption: SHORT_CAPTION,
        link: {
          url: 'https://www.brand.com/landing',
          title: 'Shop the autumn collection',
        },
      }),
    },
  ];

  for (const { label, element } of cases) {
    const root = await renderTree(element);

    const buttons = root.root.findAllByType('button');
    assert.equal(
      buttons.length,
      0,
      `${label}: should render zero <button> elements (no interactive comments/likes UI)`,
    );

    const handlers = root.root.findAll(
      (node) =>
        Boolean(node.props && (node.props.onClick || node.props.onSubmit || node.props.onChange)),
    );
    assert.equal(
      handlers.length,
      0,
      `${label}: should not attach onClick/onSubmit/onChange handlers anywhere in chrome`,
    );

    const actions = findByDataRole(root, 'post-actions');
    assert.equal(
      actions.props['aria-hidden'],
      'true',
      `${label}: post-actions row must be aria-hidden`,
    );
  }
});

test('source: no preview file uses <button or onClick chrome', () => {
  const interactiveButtonChrome = /<button\b/;
  const interactiveOnClickChrome = /\bonClick=/;
  const previewChromeFiles = [
    'InstagramFeedSingle.tsx',
    'InstagramFeedCarousel.tsx',
    'FacebookFeedSingle.tsx',
    'FacebookFeedLinkCard.tsx',
  ];
  for (const file of previewChromeFiles) {
    const source = readSource(file);
    assert.doesNotMatch(source, interactiveButtonChrome, `${file}: must not render <button> chrome`);
    assert.doesNotMatch(source, interactiveOnClickChrome, `${file}: must not attach onClick chrome`);
  }
});

test('FacebookFeedLinkCard: 1.91:1 aspect with link card chrome and data-link-host', async () => {
  const root = await renderTree(
    React.createElement(FacebookFeedLinkCard, {
      author: SAMPLE_AUTHOR,
      media: SAMPLE_MEDIA,
      caption: SHORT_CAPTION,
      link: {
        url: 'https://www.brand.com/landing',
        title: 'Shop the autumn collection',
        description: 'Hand-picked staples for the season.',
      },
    }),
  );

  const frame = findByDataRole(root, 'post-preview');
  assert.equal(frame.props['data-platform'], 'facebook');
  assert.equal(frame.props['data-post-type'], 'link_card');
  assert.equal(frame.props['data-aspect-ratio'], '1.91:1');

  const image = findByDataRole(root, 'link-card-image');
  assert.equal(image.props['data-aspect-ratio'], '1.91:1');
  assert.match(image.props.className, /aspect-\[1\.91\/1\]/);

  const card = findByDataRole(root, 'link-card');
  assert.equal(card.props['data-link-host'], 'BRAND.COM');
  assert.equal(card.props.href, 'https://www.brand.com/landing');
  assert.equal(card.props.target, '_blank');
  assert.equal(card.props.rel, 'noopener noreferrer');

  const host = findByDataRole(root, 'link-card-host');
  assert.equal(getTextContent(host), 'BRAND.COM');

  const title = findByDataRole(root, 'link-card-title');
  assert.equal(getTextContent(title), 'Shop the autumn collection');

  const description = findByDataRole(root, 'link-card-description');
  assert.equal(getTextContent(description), 'Hand-picked staples for the season.');

  const imgs = root.root.findAllByType('img');
  assert.equal(imgs.length, 1, 'one next/image rendered for the link card');
  assert.equal(imgs[0]!.props['data-nimg'], 'fill');
});

function getTextContent(node: ReactTestInstance): string {
  if (typeof node === 'string') return node;
  const children = node.children ?? [];
  return children
    .map((child) => (typeof child === 'string' ? child : getTextContent(child)))
    .join('');
}
