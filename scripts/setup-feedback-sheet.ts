/**
 * One-shot setup for the feedback button's Google Sheet mirror.
 *
 * Produces the two values you can't get from gcloud (the Composio connection is
 * separate from gcloud auth), plus creates the destination sheet, all through the
 * SAME Composio account the app uses (COMPOSIO_API_KEY from .env):
 *
 *   1. Connects a Google account to Composio (prints an OAuth URL to open once)
 *      -> COMPOSIO_FEEDBACK_GOOGLE_CONNECTED_ACCOUNT_ID
 *   2. Creates an "Aries Feedback" spreadsheet with a "Feedback" tab + header row
 *      -> FEEDBACK_GOOGLE_SHEET_ID
 *   3. Prints the ready-to-paste .env block.
 *
 * Run from the repo root:
 *   npx tsx scripts/setup-feedback-sheet.ts
 *
 * Re-running reuses an existing connection for the same user id (idempotent).
 * Env knobs: FEEDBACK_COMPOSIO_USER_ID (default "aries-feedback"),
 *            FEEDBACK_SHEET_TITLE (default "Aries Feedback"),
 *            FEEDBACK_GOOGLE_SHEET_TAB (default "Feedback").
 */

import 'dotenv/config';

import { Composio } from '@composio/core';
import { FEEDBACK_SHEET_COLUMNS } from '../lib/feedback/feedback-sink';

const TOOLKIT = 'GOOGLESHEETS';
const apiKey = process.env.COMPOSIO_API_KEY?.trim();
const userId = process.env.FEEDBACK_COMPOSIO_USER_ID?.trim() || 'aries-feedback';
const sheetTitle = process.env.FEEDBACK_SHEET_TITLE?.trim() || 'Aries Feedback';
const sheetTab = process.env.FEEDBACK_GOOGLE_SHEET_TAB?.trim() || 'Feedback';
const version = process.env.COMPOSIO_TOOLKIT_VERSION?.trim() || 'latest';

function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!apiKey) {
  die('COMPOSIO_API_KEY is not set. Run from the repo root so .env is loaded.');
}

const composio = new Composio({ apiKey });

function pick(obj: unknown, keys: string[]): string | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    for (const k of keys) {
      if (typeof rec[k] === 'string' && (rec[k] as string).trim()) return (rec[k] as string).trim();
    }
    for (const v of Object.values(rec)) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  };
  return walk(obj);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findOrCreateAuthConfig(): Promise<string> {
  try {
    const existing = (await composio.authConfigs.list({
      toolkit: TOOLKIT,
      isComposioManaged: true,
    })) as unknown as { items?: Array<{ id?: string }> };
    const found = existing?.items?.find((c) => typeof c?.id === 'string' && c.id);
    if (found?.id) return found.id;
  } catch {
    // fall through to create
  }
  const created = (await composio.authConfigs.create(TOOLKIT, {
    name: 'Aries Feedback (managed)',
    type: 'use_composio_managed_auth',
  })) as unknown as { id?: string };
  if (!created?.id) die('Composio did not return an auth config id for GOOGLESHEETS.');
  return created.id!;
}

async function reuseActiveConnection(authConfigId: string): Promise<string | null> {
  try {
    const list = await composio.connectedAccounts.list({
      userIds: [userId],
      authConfigIds: [authConfigId],
    });
    const active = (list.items ?? []).find(
      (c: { id?: string; status?: string }) =>
        c?.id && String(c.status).toUpperCase() === 'ACTIVE',
    );
    return active?.id ?? null;
  } catch {
    return null;
  }
}

async function connectGoogle(authConfigId: string): Promise<string> {
  const reused = await reuseActiveConnection(authConfigId);
  if (reused) {
    console.log(`✓ Reusing existing active Google connection: ${reused}`);
    return reused;
  }

  const req = await composio.connectedAccounts.link(userId, authConfigId);
  console.log('\n────────────────────────────────────────────────────────');
  console.log('1) Open this URL in a browser and authorize Google Sheets:');
  console.log(`\n   ${req.redirectUrl}\n`);
  console.log('   Sign in as the Google account that should OWN the feedback');
  console.log('   sheet (e.g. an ops/shared account). Waiting up to 3 min…');
  console.log('────────────────────────────────────────────────────────\n');

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const model = await composio.connectedAccounts.get(req.id);
      const status = String((model as { status?: string })?.status ?? '').toUpperCase();
      if (status === 'ACTIVE') {
        console.log('✓ Google account connected.');
        return req.id;
      }
      if (status === 'FAILED' || status === 'EXPIRED') {
        die(`Connection ${status}. Re-run and complete the OAuth prompt.`);
      }
    } catch {
      // transient; keep polling
    }
  }
  die('Timed out waiting for the OAuth authorization. Re-run when ready.');
}

async function exec(slug: string, connectedAccountId: string, args: Record<string, unknown>) {
  const result = await composio.tools.execute(slug, {
    connectedAccountId,
    arguments: args,
    version,
    ...(version.toLowerCase() === 'latest' ? { dangerouslySkipVersionCheck: true } : {}),
  } as Parameters<typeof composio.tools.execute>[1]);
  if (result.successful === false) {
    die(`${slug} failed: ${result.error ?? 'unknown error'}`);
  }
  return result.data as unknown;
}

async function main() {
  console.log(`Composio user id: ${userId}`);
  const authConfigId = await findOrCreateAuthConfig();
  console.log(`✓ Auth config: ${authConfigId}`);

  const connectedAccountId = await connectGoogle(authConfigId);

  console.log(`\n2) Creating spreadsheet "${sheetTitle}"…`);
  const created = await exec('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', connectedAccountId, {
    title: sheetTitle,
  });
  const spreadsheetId = pick(created, ['spreadsheetId', 'spreadsheet_id']);
  const spreadsheetUrl = pick(created, ['spreadsheetUrl', 'spreadsheet_url']);
  if (!spreadsheetId) die('Could not read spreadsheetId from the create response.');
  console.log(`✓ Spreadsheet: ${spreadsheetId}`);

  // Add the named tab (CREATE makes a default "Sheet1"); ignore "already exists".
  console.log(`3) Adding "${sheetTab}" tab + header row…`);
  await exec('GOOGLESHEETS_ADD_SHEET', connectedAccountId, {
    spreadsheet_id: spreadsheetId,
    title: sheetTab,
    force_unique: false,
  }).catch(() => undefined);

  // Header row. GOOGLESHEETS_VALUES_UPDATE uses snake_case args (per its schema).
  await exec('GOOGLESHEETS_VALUES_UPDATE', connectedAccountId, {
    spreadsheet_id: spreadsheetId,
    range: `'${sheetTab}'!A1`,
    value_input_option: 'USER_ENTERED',
    values: [[...FEEDBACK_SHEET_COLUMNS]],
  });
  console.log('✓ Header row written.');

  console.log('\n════════════════════════════════════════════════════════');
  console.log('Done. Add these to aries-app/.env (COMPOSIO_ENABLED + ');
  console.log('COMPOSIO_API_KEY + APP_BASE_URL are already set):\n');
  console.log(`COMPOSIO_FEEDBACK_GOOGLE_CONNECTED_ACCOUNT_ID=${connectedAccountId}`);
  console.log(`FEEDBACK_GOOGLE_SHEET_ID=${spreadsheetId}`);
  console.log(`FEEDBACK_GOOGLE_SHEET_TAB=${sheetTab}`);
  console.log(`COMPOSIO_FEEDBACK_SHEETS_APPEND_ACTION=GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`);
  if (spreadsheetUrl) console.log(`\nSheet URL: ${spreadsheetUrl}`);
  console.log('════════════════════════════════════════════════════════\n');
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
