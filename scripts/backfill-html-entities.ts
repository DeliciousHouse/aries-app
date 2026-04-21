// scripts/backfill-html-entities.ts
//
// ISSUE-W2-M1 — Backfill: re-decode HTML entity artifacts in legacy campaign
// workspace records (Nike + any pre-PR-#159 tenant).
//
// Background
// ----------
// PR #159 landed `decodeHtmlEntities` in backend/marketing/brand-kit.ts and
// `decodeEntities` in backend/marketing/real-artifacts.ts, fixing the
// extractor for NEW scrapes. Campaign workspaces created BEFORE that ship
// still have persisted text containing:
//
//   - `&#x27;`         (raw HTML hex entity for apostrophe)
//   - `& x27;`         (same token, but '#' stripped by an earlier sanitizer)
//   - `&#039;`         (decimal variant of apostrophe)
//   - `&amp;amp;`      (double-escaped ampersand)
//   - `&amp;#x27;`     (entity escaped inside another entity)
//
// These surface in the Nike workspace Brand voice / Revision notes /
// Campaign brief panels on /dashboard/campaigns/<id>?view=brand.
//
// This script re-runs the same decoder used by the live extractor against
// the persisted records, so what's on disk matches what a fresh scrape
// would produce today.
//
// Persistence
// -----------
// Campaign workspace records live on disk as JSON, one file per job, under
// `<data-root>/generated/draft/marketing-workspaces/<jobId>/workspace.json`.
// The text fields we touch:
//   brief.brandVoice, brief.notes, brief.mustUseCopy, brief.mustAvoidAesthetics
//   brief.goal, brief.offer, brief.businessName, brief.businessType,
//   brief.approverName, brief.styleVibe
//   stage_reviews.<stage>.latestNote   (the "revision notes" surface)
//   creative_asset_reviews.<id>.latestNote
//   status_history[*].note
//
// Runbook
// -------
//   # 1. Dry run against the live data directory (default — NO writes):
//   npx tsx scripts/backfill-html-entities.ts
//
//   # 2. Apply in place (writes workspace.json with decoded fields):
//   npx tsx scripts/backfill-html-entities.ts --apply
//
//   # 3. Point at a specific root (e.g. staging copy before prod):
//   ARIES_DATA_ROOT=/tmp/aries-snapshot npx tsx scripts/backfill-html-entities.ts
//
//   # 4. Operate on a single job id:
//   npx tsx scripts/backfill-html-entities.ts --job <jobId>
//
// Safety
// ------
// - Default is DRY RUN. A summary + per-field before/after diff is logged.
// - `--apply` is required to mutate anything on disk.
// - The decoder is idempotent: running it twice on already-decoded text is a
//   no-op (plain apostrophes don't match the entity regex).
// - DO NOT run this against prod without a backup of the data root.
//
// Test
// ----
//   npx tsx --test tests/backfill-html-entities.test.ts

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { decodeHtmlEntities } from '../backend/marketing/brand-kit';

// ---------------------------------------------------------------------------
// Core decoder: wraps decodeHtmlEntities with pre-passes that also catch the
// mangled `& x27;` (space-not-hash) artifact and doubly-escaped entities.
// ---------------------------------------------------------------------------

// Matches `& x27;`, `& X27;`, `& #39;`, etc. — entity with the `#` replaced by
// a stray space. We rebuild the `&#...;` form and hand it back to the real
// decoder.
//
// NOTE: two constants on purpose. A `/g`-flagged regex shares `lastIndex`
// state across calls, so reusing the same instance for both `.test()` and
// `.replace()` produces alternating true/false for identical input. Keep
// the non-global instance for tests and the global one for replace-all.
const SPACE_NOT_HASH_ENTITY_TEST = /&\s+(x[0-9a-f]+|[0-9]+);/i;
const SPACE_NOT_HASH_ENTITY_REPLACE = /&\s+(x[0-9a-f]+|[0-9]+);/gi;

export function fixArtifacts(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  let next = value;

  // Step 1: repair `& x27;` -> `&#x27;`, `& 39;` -> `&#39;`.
  next = next.replace(SPACE_NOT_HASH_ENTITY_REPLACE, (_m, body) => `&#${body};`);

  // Step 2: unwrap double-escapes like `&amp;#x27;` or `&amp;amp;`. We run
  // the decoder up to 3 times so that fully-wrapped `&amp;amp;#x27;` unravels
  // without looping forever on benign strings.
  for (let i = 0; i < 3; i += 1) {
    const decoded = decodeHtmlEntities(next);
    if (decoded === next) break;
    next = decoded;
  }

  return next;
}

export function hasArtifact(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return (
    /&#x[0-9a-f]+;/i.test(value) ||
    /&#[0-9]+;/.test(value) ||
    SPACE_NOT_HASH_ENTITY_TEST.test(value) ||
    /&amp;/i.test(value) ||
    /&[a-z]+[0-9]?;/i.test(value)
  );
}

// ---------------------------------------------------------------------------
// Record walker: operates on a generic CampaignWorkspaceRecord-shaped object.
// Kept untyped-at-the-boundary so we can also feed it raw in-memory records
// from tests / callers that don't use the on-disk JSON layout.
// ---------------------------------------------------------------------------

export type FieldChange = {
  path: string;
  before: string;
  after: string;
};

const BRIEF_TEXT_FIELDS = [
  'brandVoice',
  'notes',
  'mustUseCopy',
  'mustAvoidAesthetics',
  'goal',
  'offer',
  'businessName',
  'businessType',
  'approverName',
  'styleVibe',
] as const;

export function decodeWorkspaceRecord(
  record: Record<string, any>,
): { record: Record<string, any>; changes: FieldChange[] } {
  const changes: FieldChange[] = [];

  const tryFix = (owner: Record<string, any>, key: string, logPath: string): void => {
    const before = owner?.[key];
    if (typeof before !== 'string') return;
    const after = fixArtifacts(before);
    if (after !== before) {
      owner[key] = after;
      changes.push({ path: logPath, before, after });
    }
  };

  // brief.*
  const brief = record?.brief;
  if (brief && typeof brief === 'object') {
    for (const field of BRIEF_TEXT_FIELDS) {
      tryFix(brief, field, `brief.${field}`);
    }
  }

  // stage_reviews.<stage>.latestNote
  const stageReviews = record?.stage_reviews;
  if (stageReviews && typeof stageReviews === 'object') {
    for (const stageKey of Object.keys(stageReviews)) {
      const stage = stageReviews[stageKey];
      if (stage && typeof stage === 'object') {
        tryFix(stage, 'latestNote', `stage_reviews.${stageKey}.latestNote`);
      }
    }
  }

  // creative_asset_reviews.<assetId>.latestNote
  const creative = record?.creative_asset_reviews;
  if (creative && typeof creative === 'object') {
    for (const assetId of Object.keys(creative)) {
      const review = creative[assetId];
      if (review && typeof review === 'object') {
        tryFix(review, 'latestNote', `creative_asset_reviews.${assetId}.latestNote`);
      }
    }
  }

  // status_history[*].note
  const history = record?.status_history;
  if (Array.isArray(history)) {
    history.forEach((entry, idx) => {
      if (entry && typeof entry === 'object') {
        tryFix(entry, 'note', `status_history[${idx}].note`);
      }
    });
  }

  return { record, changes };
}

// ---------------------------------------------------------------------------
// Filesystem driver — only used when invoked as a CLI.
// ---------------------------------------------------------------------------

function resolveDataRoot(): string {
  const envRoot = process.env.ARIES_DATA_ROOT;
  if (envRoot) return envRoot;
  // Match backend/lib/runtime-paths layout at repo root.
  return path.resolve(process.cwd(), 'data');
}

function workspacesRoot(dataRoot: string): string {
  return path.join(dataRoot, 'generated', 'draft', 'marketing-workspaces');
}

function listWorkspaceFiles(root: string, onlyJobId: string | null): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    if (onlyJobId && entry !== onlyJobId) continue;
    const jobDir = path.join(root, entry);
    let stat;
    try { stat = statSync(jobDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const wsFile = path.join(jobDir, 'workspace.json');
    if (existsSync(wsFile)) results.push(wsFile);
  }
  return results;
}

function parseArgs(argv: string[]): { apply: boolean; jobId: string | null } {
  let apply = false;
  let jobId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--job' || arg === '--job-id') {
      jobId = argv[i + 1] || null;
      i += 1;
    }
  }
  return { apply, jobId };
}

async function main(): Promise<void> {
  const { apply, jobId } = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot();
  const root = workspacesRoot(dataRoot);

  // eslint-disable-next-line no-console
  console.log(
    `[backfill-html-entities] mode=${apply ? 'APPLY' : 'DRY-RUN'} root=${root}` +
      (jobId ? ` job=${jobId}` : ''),
  );

  const files = listWorkspaceFiles(root, jobId);
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[backfill-html-entities] no workspace.json files found — nothing to do.');
    return;
  }

  let totalFilesChanged = 0;
  let totalFieldChanges = 0;

  for (const file of files) {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[backfill-html-entities] SKIP ${file} (invalid JSON):`, err);
      continue;
    }

    const { record, changes } = decodeWorkspaceRecord(parsed);
    if (changes.length === 0) continue;

    totalFilesChanged += 1;
    totalFieldChanges += changes.length;

    // eslint-disable-next-line no-console
    console.log(`\n--- ${file} (${changes.length} field(s)) ---`);
    for (const ch of changes) {
      // eslint-disable-next-line no-console
      console.log(`  ${ch.path}`);
      // eslint-disable-next-line no-console
      console.log(`    -  ${JSON.stringify(ch.before)}`);
      // eslint-disable-next-line no-console
      console.log(`    +  ${JSON.stringify(ch.after)}`);
    }

    if (apply) {
      writeFileSync(file, JSON.stringify(record, null, 2));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n[backfill-html-entities] files_with_changes=${totalFilesChanged} ` +
      `field_changes=${totalFieldChanges} applied=${apply}`,
  );
  if (!apply && totalFilesChanged > 0) {
    // eslint-disable-next-line no-console
    console.log('[backfill-html-entities] re-run with --apply to persist.');
  }
}

// Run when invoked directly (tsx / node ESM).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry.endsWith('backfill-html-entities.ts') ||
      entry.endsWith('backfill-html-entities.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backfill-html-entities] FAILED:', err);
    process.exit(1);
  });
}
