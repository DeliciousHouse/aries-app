import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from '../helpers/project-root';
import {
  creativeReviewLearningLabel,
  marketingReviewLabelIdempotencyKey,
  recordMarketingReviewLearningLabel,
} from '../../backend/marketing/review-learning-labels';

/**
 * S4-6 / AA-109 (gap C4) — the marketing review tray as the second writer of
 * campaign_learning_labels, so "Working with Aries" (approval-flow bar +
 * learning curve) shows real data without manual labeling.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/review-learning-labels.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...segments: string[]): string =>
  readFileSync(path.join(PROJECT_ROOT, '..', ...segments), 'utf8');

function recordingQuery(impl?: () => Promise<{ rows: unknown[] }>) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return impl ? impl() : { rows: [] };
    },
  };
}

const CREATIVE_ITEM = { reviewType: 'creative', assetId: 'img_1' };

// ── Action → label mapping ───────────────────────────────────────────────────

test('maps the three review actions onto the labels the builder reads', () => {
  assert.equal(creativeReviewLearningLabel(CREATIVE_ITEM, 'approve'), 'approved');
  assert.equal(creativeReviewLearningLabel(CREATIVE_ITEM, 'reject'), 'rejected');
  assert.equal(creativeReviewLearningLabel(CREATIVE_ITEM, 'changes_requested'), 'needs_changes');
});

test('changes_requested stays DISTINCT from reject', () => {
  // The taste producer next door collapses changes_requested into 'rejected'
  // because it has only two outcomes. Doing that here would erase the approval
  // bar's EDITED bucket: deriveFlowBuckets reads 'needs_changes' as edited and
  // 'rejected' as rebuilt. This is the regression that would silently flatten
  // the section back toward useless.
  const changes = creativeReviewLearningLabel(CREATIVE_ITEM, 'changes_requested');
  const rejected = creativeReviewLearningLabel(CREATIVE_ITEM, 'reject');
  assert.notEqual(changes, rejected);
  assert.equal(changes, 'needs_changes');
});

test('an unknown action produces no label', () => {
  assert.equal(creativeReviewLearningLabel(CREATIVE_ITEM, 'snoozed'), null);
  assert.equal(creativeReviewLearningLabel(CREATIVE_ITEM, ''), null);
});

// ── Double-count discrimination ──────────────────────────────────────────────

test('only a per-asset creative decision is labeled', () => {
  for (const reviewType of ['brand', 'strategy', 'workflow_approval']) {
    assert.equal(
      creativeReviewLearningLabel({ reviewType, assetId: 'img_1' }, 'approve'),
      null,
      `${reviewType} must not write a learning label`,
    );
  }
});

test('a publish-gate creative item (no assetId) is not labeled', () => {
  // The launch-gate item also carries reviewType 'creative' but no assetId.
  // Labeling it would count the same creative twice — once in the review tray
  // and again at the publish gate — inflating the bar and flattening the curve.
  assert.equal(creativeReviewLearningLabel({ reviewType: 'creative' }, 'approve'), null);
  assert.equal(
    creativeReviewLearningLabel({ reviewType: 'creative', assetId: '' }, 'approve'),
    null,
  );
  assert.equal(
    creativeReviewLearningLabel({ reviewType: 'creative', assetId: null }, 'approve'),
    null,
  );
});

// ── Idempotency key ──────────────────────────────────────────────────────────

test('idempotency key is deterministic per (job, asset, label)', () => {
  const a = marketingReviewLabelIdempotencyKey('job-1', 'img_1', 'approved');
  const b = marketingReviewLabelIdempotencyKey('job-1', 'img_1', 'approved');
  assert.equal(a, b, 'a re-delivered decision must collapse onto one row');

  // A genuine change of mind is a SECOND attempt and must record separately —
  // that is what the learning curve measures (2 rows => 2.0 attempts).
  const changed = marketingReviewLabelIdempotencyKey('job-1', 'img_1', 'needs_changes');
  assert.notEqual(a, changed);

  // Different asset / different job never collide.
  assert.notEqual(a, marketingReviewLabelIdempotencyKey('job-1', 'img_2', 'approved'));
  assert.notEqual(a, marketingReviewLabelIdempotencyKey('job-2', 'img_1', 'approved'));
});

// ── Writer ───────────────────────────────────────────────────────────────────

test('writes a marketing-sourced row with the review_decision basis', async () => {
  const rec = recordingQuery();
  const ok = await recordMarketingReviewLearningLabel(
    { tenantId: '7', jobId: 'job-1', assetId: 'img_1', label: 'approved', note: ' looks good ' },
    { query: rec.query },
  );

  assert.equal(ok, true);
  assert.equal(rec.calls.length, 1);

  const { text, values } = rec.calls[0];
  assert.match(text, /INSERT INTO campaign_learning_labels/);
  // Re-delivery safety: never a duplicate row for the same decision.
  assert.match(text, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
  // The two origins must stay distinguishable from the manual tool's rows.
  assert.match(text, /'marketing_review', 'review_decision'/);

  assert.deepEqual(values, [
    7, // coerced to the INTEGER the column is
    'marketing-review:job-1:img_1:approved',
    'approved',
    'job-1',
    'img_1',
    'looks good', // trimmed
  ]);
});

test('an empty note is stored as NULL, not an empty string', async () => {
  const rec = recordingQuery();
  await recordMarketingReviewLearningLabel(
    { tenantId: 7, jobId: 'job-1', assetId: 'img_1', label: 'rejected', note: '   ' },
    { query: rec.query },
  );
  assert.equal(rec.calls[0].values[5], null);
});

test('unusable input is dropped without touching the database', async () => {
  // tenant_id is INTEGER REFERENCES organizations(id) — a non-numeric tenant
  // would fail the insert, so it is refused here rather than logged per click.
  for (const bad of [
    { tenantId: 'not-a-number', jobId: 'job-1', assetId: 'img_1' },
    { tenantId: 0, jobId: 'job-1', assetId: 'img_1' },
    { tenantId: 7, jobId: '', assetId: 'img_1' },
    { tenantId: 7, jobId: 'job-1', assetId: '   ' },
  ] as const) {
    const rec = recordingQuery();
    const ok = await recordMarketingReviewLearningLabel(
      { ...bad, label: 'approved' },
      { query: rec.query },
    );
    assert.equal(ok, false, `${JSON.stringify(bad)} must not write`);
    assert.equal(rec.calls.length, 0, `${JSON.stringify(bad)} must not query`);
  }
});

test('a write failure is swallowed so it can never break the operator decision', async () => {
  const rec = recordingQuery(async () => {
    throw new Error('db down');
  });
  const ok = await recordMarketingReviewLearningLabel(
    { tenantId: 7, jobId: 'job-1', assetId: 'img_1', label: 'approved' },
    { query: rec.query },
  );
  assert.equal(ok, false);
  assert.equal(rec.calls.length, 1, 'it did attempt the write');
});

// ── Cross-module contracts ───────────────────────────────────────────────────

test('the labels written are exactly the vocabulary the insights builder reads', () => {
  // Drift guard: a label this writer emits that the builder does not FILTER on
  // is a silently dropped row — the section would stay dead with the table full.
  const builder = read('backend', 'insights', 'aries', 'aries-builder.ts');
  for (const label of ['approved', 'rejected', 'needs_changes'] as const) {
    assert.match(
      builder,
      new RegExp(`label = '${label}'`),
      `aries-builder must count '${label}'`,
    );
  }
  assert.match(
    builder,
    /label IN \('approved', 'rejected', 'needs_changes'\)/,
    'the learning-curve query must read the same three labels',
  );
});

test('the review decision call site invokes the writer after the taste producer', () => {
  const source = read('backend', 'marketing', 'runtime-views.ts');
  assert.match(source, /creativeReviewLearningLabel\(item, input\.action\)/);
  assert.match(source, /recordMarketingReviewLearningLabel\(/);
});

test('the manual Creative Memory tool is untouched and still writes its own rows', () => {
  // The ticket keeps the manual labeler as an ADDITIONAL writer; it must not be
  // rerouted or have its provenance changed.
  const manual = read('backend', 'creative-memory', 'learningEvents.ts');
  assert.match(manual, /INSERT INTO campaign_learning_labels/);
  assert.match(manual, /'manual_label'/);
  assert.match(manual, /input\.source \?\? 'operator'/);
});

// ── Schema (two-place rule) ──────────────────────────────────────────────────

test('init-db and the migration both carry the marketing columns + widened CHECK', () => {
  const ddl = read('scripts', 'init-db.js');
  const migration = read(
    'migrations',
    '20260805000000_campaign_learning_labels_marketing_source.sql',
  );

  for (const source of [ddl, migration]) {
    assert.match(source, /marketing_job_id/);
    assert.match(source, /marketing_asset_id/);
  }

  // The target CHECK must accept a marketing-sourced row. Without the third
  // alternative every insert from the review tray violates the constraint.
  const widened =
    /prompt_recipe_id IS NOT NULL OR generated_asset_id IS NOT NULL OR marketing_job_id IS NOT NULL/;
  assert.match(ddl, widened, 'init-db.js must allow a marketing-only target');
  assert.match(migration, widened, 'the migration must allow a marketing-only target');

  // Fresh databases get the columns from CREATE TABLE; existing ones from the
  // ALTERs. Both paths have to exist or one deployment shape breaks.
  assert.match(
    ddl,
    /ALTER TABLE campaign_learning_labels ADD COLUMN IF NOT EXISTS marketing_job_id TEXT/,
  );
});
