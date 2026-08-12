import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEW_SAMPLE_MAX,
  REVIEW_SAMPLE_SQL,
  REVIEW_SUMMARY_SQL,
  assessLabels,
  loadClassifiedSample,
  shapeSummary,
  type ClassificationQueryable,
  type ClassificationSummary,
} from '../backend/insights/sync/classification-review';
import { parseArgs } from '../scripts/insights/review-comment-classifications';

/**
 * AA-90 (S1-11, gap B1) — the label-quality gate.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-classification-review.test.ts
 */

function summary(over: Partial<ClassificationSummary> = {}): ClassificationSummary {
  return {
    commentsTotal: 10,
    classifiedTotal: 10,
    sentiment: { positive: 4, neutral: 3, negative: 3, unlabelled: 0 },
    category: { question: 3, compliment: 3, complaint: 2, spam: 1, other: 1, unlabelled: 0 },
    leads: 2,
    versionCount: 1,
    ...over,
  };
}

// ── The verdict vocabulary ───────────────────────────────────────────────────

test('the best verdict is "needs_review" — a script never certifies labels as good', () => {
  // The gate is a human reading labels beside their comment text. A tool that
  // said "good" would defeat the purpose of the ticket.
  const clean = assessLabels(summary());
  assert.equal(clean.verdict, 'needs_review');
  assert.deepEqual(clean.warnings, []);
});

test('the exact AA-90 production signature is called out by name', () => {
  // Comments exist, zero classified — what the fleet looked like for weeks
  // while the flag was ON and the gateway was unreachable.
  const out = assessLabels(summary({ classifiedTotal: 0, commentsTotal: 9 }));
  assert.equal(out.verdict, 'no_labels');
  assert.match(out.warnings[0], /9 comments exist but NONE are classified/);
  assert.match(out.warnings[0], /insights_classifier_preflight/, 'must point at the diagnostic');
});

test('an empty tenant is distinguished from a broken classifier', () => {
  // Nothing fetched yet is not the same failure as fetched-but-unclassified,
  // and conflating them would send someone debugging the wrong system.
  const out = assessLabels(summary({ classifiedTotal: 0, commentsTotal: 0 }));
  assert.equal(out.verdict, 'no_labels');
  assert.match(out.warnings[0], /No comments have been fetched/);
});

// ── Mechanical smells ────────────────────────────────────────────────────────

test('a uniform sentiment is flagged — the broken-prompt signature', () => {
  // The model answered, so nothing errored and the table has rows. It just is
  // not discriminating, which no error path would ever reveal.
  const out = assessLabels(
    summary({ sentiment: { positive: 10, neutral: 0, negative: 0, unlabelled: 0 } }),
  );
  assert.equal(out.verdict, 'suspect');
  assert.ok(out.warnings.some((w) => /SAME sentiment/.test(w)));
});

test('a uniform category is flagged', () => {
  const out = assessLabels(
    summary({
      category: { question: 0, compliment: 0, complaint: 0, spam: 0, other: 10, unlabelled: 0 },
    }),
  );
  assert.equal(out.verdict, 'suspect');
  assert.ok(out.warnings.some((w) => /SAME category/.test(w)));
});

test('a single classified comment is NOT flagged as uniform', () => {
  // One row is trivially "all the same"; flagging it would cry wolf on the very
  // first batch this gate exists to inspect.
  const out = assessLabels(
    summary({
      classifiedTotal: 1,
      commentsTotal: 1,
      sentiment: { positive: 1, neutral: 0, negative: 0, unlabelled: 0 },
      category: { question: 1, compliment: 0, complaint: 0, spam: 0, other: 0, unlabelled: 0 },
      leads: 1,
    }),
  );
  assert.equal(out.verdict, 'needs_review', `unexpected warnings: ${out.warnings.join(' | ')}`);
});

test('majority-NULL labels are flagged as vocabulary drift', () => {
  const out = assessLabels(
    summary({ sentiment: { positive: 2, neutral: 0, negative: 0, unlabelled: 8 } }),
  );
  assert.equal(out.verdict, 'suspect');
  assert.ok(out.warnings.some((w) => /NO sentiment/.test(w) && /pinned vocabulary/.test(w)));
});

test('a few NULLs are tolerated', () => {
  const out = assessLabels(
    summary({ sentiment: { positive: 5, neutral: 3, negative: 1, unlabelled: 1 } }),
  );
  assert.equal(out.verdict, 'needs_review');
});

test('everything-is-a-lead is flagged, because Goal leads would be noise', () => {
  const out = assessLabels(summary({ leads: 10 }));
  assert.equal(out.verdict, 'suspect');
  assert.ok(out.warnings.some((w) => /EVERY comment was marked a lead/.test(w)));
});

test('mixed classifier versions warn that labels are mid-migration', () => {
  const out = assessLabels(summary({ versionCount: 2 }));
  assert.equal(out.verdict, 'suspect');
  assert.ok(out.warnings.some((w) => /classifier versions/.test(w)));
});

// ── Shaping + queries ────────────────────────────────────────────────────────

test('summary shaping coerces missing/string counts without inventing data', () => {
  assert.deepEqual(shapeSummary(undefined), {
    commentsTotal: 0,
    classifiedTotal: 0,
    sentiment: { positive: 0, neutral: 0, negative: 0, unlabelled: 0 },
    category: { question: 0, compliment: 0, complaint: 0, spam: 0, other: 0, unlabelled: 0 },
    leads: 0,
    versionCount: 0,
  });
  // Postgres count() arrives as a string over the wire.
  assert.equal(shapeSummary({ classified_total: '7' }).classifiedTotal, 7);
});

test('the review is READ-ONLY and tenant-scopable', () => {
  for (const sql of [REVIEW_SAMPLE_SQL, REVIEW_SUMMARY_SQL]) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i, 'the gate must never mutate labels');
    assert.match(sql, /\$1::int IS NULL OR/, 'tenant filter must be parameterized and optional');
  }
  // Newest first — a review reads the most recent batch, not the oldest.
  assert.match(REVIEW_SAMPLE_SQL, /ORDER BY k\.classified_at DESC/);
});

test('the sample size is clamped however large a limit is asked for', async () => {
  const seen: unknown[][] = [];
  const db: ClassificationQueryable = {
    async query(_t: string, v?: unknown[]) {
      seen.push(v ?? []);
      return { rows: [] as never[] };
    },
  };
  await loadClassifiedSample(db, 7, 10_000);
  assert.deepEqual(seen[0], [7, REVIEW_SAMPLE_MAX]);

  await loadClassifiedSample(db, null, 5);
  assert.deepEqual(seen[1], [null, 5], 'a null tenant means all tenants');
});

test('sample rows keep the comment text beside its labels', async () => {
  const db: ClassificationQueryable = {
    async query() {
      return {
        rows: [
          {
            comment_id: '42',
            tenant_id: '7',
            platform: 'instagram',
            received_at: '2026-08-10T00:00:00Z',
            body_text: 'do you ship to canada?',
            sentiment: 'neutral',
            is_lead: true,
            category: 'question',
            classifier_version: 'hermes-comment-v1',
            classified_at: '2026-08-10T01:00:00Z',
          },
        ] as never[],
      };
    },
  };
  const rows = await loadClassifiedSample(db, 7, 20);
  assert.equal(rows[0].commentId, 42);
  assert.equal(rows[0].bodyText, 'do you ship to canada?', 'the text is what makes review possible');
  assert.equal(rows[0].isLead, true);
  assert.equal(rows[0].category, 'question');
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('CLI args parse, and junk is refused rather than silently defaulted', () => {
  assert.deepEqual(parseArgs([]), { tenantId: null, limit: 20, json: false });
  assert.deepEqual(parseArgs(['--tenant', '7', '--limit', '5', '--json']), {
    tenantId: 7,
    limit: 5,
    json: true,
  });
  for (const bad of [['--tenant', '0'], ['--tenant', 'abc'], ['--limit', '-1'], ['--nope']]) {
    assert.throws(() => parseArgs(bad), `${bad.join(' ')} should throw`);
  }
});
