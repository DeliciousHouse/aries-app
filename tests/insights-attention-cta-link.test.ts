/**
 * tests/insights-attention-cta-link.test.ts
 *
 * Regression for S1-1 / AA-80: the Attention "NEEDS REPLY" card's primary CTA
 * must link to the real comments workspace (/dashboard/comments), NOT the
 * non-existent /conversations route (which 404s). Pure builder assertion — no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttentionCards } from '../backend/insights/attention/attention-card-builder';
import type { AttentionSnapshot } from '../backend/insights/attention/attention-snapshot-builder';

const unrepliedSnapshot: AttentionSnapshot = {
  unreplied: 3,
  unrepliedLeads: 1,
  unrepliedQuestions: 1,
  highPerformer: null,
  pattern: null,
  milestone: null,
  postCount: 5,
};

test('unreplied card CTA links to /dashboard/comments, not the 404 /conversations (S1-1/AA-80)', () => {
  const cards = buildAttentionCards(unrepliedSnapshot, 'all', '90day');
  const card = cards.find((c) => c.type === 'unreplied');
  assert.ok(card, 'expected an unreplied attention card when unreplied > 0');
  assert.equal(card.ctaPrimary?.href, '/dashboard/comments');
  assert.notEqual(card.ctaPrimary?.href, '/conversations');
});
