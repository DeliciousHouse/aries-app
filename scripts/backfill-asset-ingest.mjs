#!/usr/bin/env node
/*
 * Backfill: rewrite host-side asset paths inside existing runtime docs.
 *
 * saveMarketingJobRuntime now runs asset-ingest on every write, but docs that
 * were persisted before this landed still carry raw host paths (the ones that
 * cause asset_file_missing 404s today). This one-shot pass loads each doc,
 * runs the same ingest, writes it back.
 *
 * Safe to run repeatedly: ingest is idempotent — paths already under DATA_ROOT
 * are left alone, and content-addressed copies dedupe.
 *
 * Usage:
 *   node scripts/backfill-asset-ingest.mjs              # dry-run against draft + validated
 *   node scripts/backfill-asset-ingest.mjs --write      # actually write changes back
 *   node scripts/backfill-asset-ingest.mjs --job mkt_x  # limit to one job
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function loadIngest() {
  // Load via tsx so we can `import` the TS module at runtime. Falls back to
  // asking the user to compile first if tsx isn't available.
  try {
    const { register } = await import('tsx/esm/api');
    register();
  } catch (err) {
    console.error('[backfill] tsx not available. Install it or run via: npx tsx scripts/backfill-asset-ingest.mjs');
    throw err;
  }
  const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'backend/marketing/asset-ingest.ts')).href;
  const mod = await import(moduleUrl);
  return mod.ingestRuntimeDocAssets;
}

function resolveDataRoot() {
  const explicit = process.env.DATA_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  for (const candidate of ['/home/node/data', '/tmp/aries-data', '/data']) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }
  return '/home/node/data';
}

function listJobDocs(dataRoot) {
  const results = [];
  for (const kind of ['draft', 'validated']) {
    const dir = path.join(dataRoot, 'generated', kind, 'marketing-jobs');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      results.push(path.join(dir, entry));
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const jobFilterIdx = args.indexOf('--job');
  const jobFilter = jobFilterIdx >= 0 ? args[jobFilterIdx + 1] : null;

  const dataRoot = resolveDataRoot();
  console.log(`[backfill] DATA_ROOT = ${dataRoot}`);
  console.log(`[backfill] mode = ${write ? 'WRITE' : 'dry-run'}`);
  if (jobFilter) console.log(`[backfill] job filter = ${jobFilter}`);

  return (async () => {
    const ingest = await loadIngest();
    const docs = listJobDocs(dataRoot);
    console.log(`[backfill] found ${docs.length} runtime docs`);

    let totalRewrites = 0;
    let touchedDocs = 0;

    for (const docPath of docs) {
      const basename = path.basename(docPath, '.json');
      if (jobFilter && basename !== jobFilter) continue;
      let doc;
      try {
        doc = JSON.parse(readFileSync(docPath, 'utf8'));
      } catch (err) {
        console.warn(`[backfill] skip ${docPath}: ${err.message}`);
        continue;
      }
      const result = ingest(doc);
      if (result.rewrites.length === 0) {
        continue;
      }
      touchedDocs += 1;
      totalRewrites += result.rewrites.length;
      console.log(`[backfill] ${basename}: ${result.rewrites.length} path(s) rewritten`);
      for (const r of result.rewrites.slice(0, 3)) {
        console.log(`    ${r.from} -> ${r.to} (${r.bytes}B)`);
      }
      if (result.rewrites.length > 3) {
        console.log(`    ... +${result.rewrites.length - 3} more`);
      }
      if (write) {
        writeFileSync(docPath, JSON.stringify(doc, null, 2));
      }
    }

    console.log(`[backfill] done. ${touchedDocs} doc(s) touched, ${totalRewrites} path(s) ${write ? 'rewritten' : 'would be rewritten'}.`);
    if (!write && touchedDocs > 0) {
      console.log('[backfill] rerun with --write to persist changes.');
    }
  })();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
