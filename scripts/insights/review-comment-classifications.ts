/**
 * scripts/insights/review-comment-classifications.ts
 *
 * AA-90 (S1-11) — the label-quality gate, as a CLI.
 *
 * Prints the most recent classified comments beside their original text, plus
 * the label distribution, so a human can do the review AA-90 asks for before
 * five surfaces start treating machine labels as fact.
 *
 * READ-ONLY. It runs SELECTs and writes nothing — running it can never make the
 * label situation worse.
 *
 * Usage:
 *   npx tsx scripts/insights/review-comment-classifications.ts [--tenant N] [--limit 20] [--json]
 *
 * Reading the output: `needs_review` is the BEST verdict. This tool detects
 * mechanical smells (every label identical, labels outside the vocabulary,
 * everything flagged a lead); it cannot tell you whether the labels are RIGHT.
 * That is the part a person has to do, which is the whole point of the gate.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  REVIEW_SAMPLE_DEFAULT,
  assessLabels,
  loadClassificationSummary,
  loadClassifiedSample,
  type ClassifiedCommentRow,
} from '@/backend/insights/sync/classification-review';
import { CURRENT_CLASSIFIER_VERSION } from '@/backend/insights/sync/classify-comments';

interface Args {
  tenantId: number | null;
  limit: number;
  json: boolean;
}

export function parseArgs(argv: string[]): Args {
  let tenantId: number | null = null;
  let limit = REVIEW_SAMPLE_DEFAULT;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--tenant') {
      const parsed = Number(argv[i + 1]);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`--tenant needs a positive integer (got ${String(argv[i + 1])})`);
      }
      tenantId = parsed;
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      const parsed = Number(argv[i + 1]);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`--limit needs a positive integer (got ${String(argv[i + 1])})`);
      }
      limit = parsed;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { tenantId, limit, json };
}

function truncate(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderRow(row: ClassifiedCommentRow): string {
  const label = [
    row.sentiment ?? '—',
    row.category ?? '—',
    row.isLead ? 'LEAD' : '',
  ]
    .filter(Boolean)
    .join('/');
  return `  [${String(row.commentId).padStart(6)}] ${label.padEnd(28)} ${truncate(row.bodyText)}`;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[review-classifications] ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 1,
  });

  try {
    const summary = await loadClassificationSummary(pool, args.tenantId);
    const sample = await loadClassifiedSample(pool, args.tenantId, args.limit);
    const assessment = assessLabels(summary);

    if (args.json) {
      console.log(JSON.stringify({ summary, assessment, sample, currentVersion: CURRENT_CLASSIFIER_VERSION }, null, 2));
      return;
    }

    const scope = args.tenantId ? `tenant ${args.tenantId}` : 'ALL tenants';
    console.log(`\n[review-classifications] ${scope} — current version ${CURRENT_CLASSIFIER_VERSION}\n`);
    console.log(`  comments fetched   : ${summary.commentsTotal}`);
    console.log(`  comments classified: ${summary.classifiedTotal}`);
    console.log(
      `  sentiment          : +${summary.sentiment.positive} / =${summary.sentiment.neutral} / -${summary.sentiment.negative}` +
        (summary.sentiment.unlabelled ? ` / unlabelled ${summary.sentiment.unlabelled}` : ''),
    );
    console.log(
      `  category           : ${Object.entries(summary.category)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ') || '(none)'}`,
    );
    console.log(`  leads              : ${summary.leads}`);

    console.log(`\n  VERDICT: ${assessment.verdict}`);
    for (const warning of assessment.warnings) console.log(`   ! ${warning}`);
    if (assessment.verdict === 'needs_review') {
      console.log('   (no mechanical smells — a human still has to read the labels below)');
    }

    if (sample.length > 0) {
      console.log(`\n  Most recent ${sample.length} labels (sentiment/category/lead — comment):\n`);
      for (const row of sample) console.log(renderRow(row));
    }

    console.log(
      '\n  Labels are frozen once written (ON CONFLICT DO NOTHING on a pinned version).\n' +
        '  Turning the flag off does NOT roll them back — a bad batch needs a\n' +
        '  CURRENT_CLASSIFIER_VERSION bump to re-drive the re-classify sweep.\n',
    );
  } finally {
    await pool.end();
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('review-comment-classifications.ts') || entry.endsWith('review-comment-classifications.js');
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[review-classifications] FAILED', err);
    process.exit(1);
  });
}
