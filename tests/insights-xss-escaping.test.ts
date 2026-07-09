/**
 * tests/insights-xss-escaping.test.ts
 *
 * Regression for S1-2 / AA-81 (stored XSS). An untrusted post title
 * (insights_posts.title — e.g. an attacker-controlled YouTube video title) that
 * flows into an insights card rendered via dangerouslySetInnerHTML must be
 * ESCAPED so injected markup is inert, while the card's intended app markup
 * (<em>, <strong>) still renders.
 *
 * Acceptance criterion: an injected <img onerror=…> / <script> in a title
 * renders inert / escaped in the built card output. Pure builder assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttentionCards } from '../backend/insights/attention/attention-card-builder';
import type { AttentionSnapshot } from '../backend/insights/attention/attention-snapshot-builder';
import { buildPatternCard } from '../backend/insights/top/top-template-builder';
import type { TopPost, TopSnapshot } from '../backend/insights/top/top-snapshot-builder';
import { escapeHtml } from '../backend/insights/escape-html';

const PAYLOADS = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>'];

function attentionSnapshotWithTitle(title: string): AttentionSnapshot {
  return {
    unreplied: 0,
    unrepliedLeads: 0,
    unrepliedQuestions: 0,
    highPerformer: { title, platform: 'youtube', multiplier: 4 } as any,
    pattern: null,
    milestone: null,
    postCount: 10,
  };
}

test('attention opportunity card escapes an injected post title (S1-2/AA-81)', () => {
  for (const payload of PAYLOADS) {
    const cards = buildAttentionCards(attentionSnapshotWithTitle(payload), 'all', '90day');
    const card = cards.find((c) => c.type === 'opportunity');
    assert.ok(card, 'expected an opportunity card when highPerformer is set');
    // No live tag survives — the '<' is escaped, so no parseable element. (The
    // literal text "onerror=" may remain; it is inert because the tag opener is
    // escaped. Escaping neutralizes injection without stripping text.)
    assert.doesNotMatch(card.title, /<img|<script/i);
    // The escaped form IS present (payload rendered as inert text).
    assert.match(card.title, /&lt;(img|script)/i);
    // Intended app markup still renders.
    assert.match(card.title, /<em>/);
  }
});

test('top pattern takeaway escapes a malicious content-type label (defense-in-depth)', () => {
  const posts = Array.from({ length: 3 }, (_, i) =>
    ({ contentType: '<script>alert(1)</script>', title: `p${i}`, platform: 'youtube' }) as unknown as TopPost,
  );
  const snap = { posts, avgReach: 100, postCount: 3, sortBy: 'reach' } as unknown as TopSnapshot;
  const card = buildPatternCard(snap);
  assert.doesNotMatch(card.takeaway, /<script/i);
  assert.match(card.takeaway, /&lt;script/i);
});

test('escapeHtml neutralizes the dangerous characters and coerces null', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`a & b "c" 'd'`), 'a &amp; b &quot;c&quot; &#39;d&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
