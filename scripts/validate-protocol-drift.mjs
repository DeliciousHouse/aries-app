/**
 * CI gate: verify that the protocol package exports the expected shapes and
 * that critical consumer files import from @aries/hermes-protocol rather than
 * redefining the callback envelope inline.
 *
 * Run: node scripts/validate-protocol-drift.mjs
 * Wired into: npm run lint
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

// ---------------------------------------------------------------------------
// 1. Protocol package files exist and export PROTOCOL_VERSION
// ---------------------------------------------------------------------------

const PROTOCOL_INDEX = path.join(root, 'packages/aries-hermes-protocol/src/index.ts');
const PROTOCOL_SCHEMAS = path.join(root, 'packages/aries-hermes-protocol/src/schemas.ts');

if (!fs.existsSync(PROTOCOL_INDEX)) {
  console.error('[validate-protocol-drift] FAIL: packages/aries-hermes-protocol/src/index.ts is missing.');
  process.exit(1);
}
if (!fs.existsSync(PROTOCOL_SCHEMAS)) {
  console.error('[validate-protocol-drift] FAIL: packages/aries-hermes-protocol/src/schemas.ts is missing.');
  process.exit(1);
}

const schemasSource = fs.readFileSync(PROTOCOL_SCHEMAS, 'utf8');
if (!schemasSource.includes('PROTOCOL_VERSION')) {
  console.error('[validate-protocol-drift] FAIL: schemas.ts does not export PROTOCOL_VERSION.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Banned inline redefinitions outside the protocol package
//
// These patterns would re-introduce the convention drift we're preventing.
// Any inline HermesRunCallbackPayload type in backend/ outside packages/ is a
// violation — it should import from @aries/hermes-protocol instead.
// ---------------------------------------------------------------------------

const INLINE_CALLBACK_PATTERN = /^\s*(export\s+)?(type|interface)\s+HermesRunCallbackPayload\s*[={]/m;
const INLINE_CALLBACK_STATUS_PATTERN = /^\s*(export\s+)?(type)\s+HermesRunCallbackStatus\s*=/m;

const BACKEND_DIR = path.join(root, 'backend');

function walkTs(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...walkTs(abs));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      results.push(abs);
    }
  }
  return results;
}

const violations = [];
for (const file of walkTs(BACKEND_DIR)) {
  const rel = path.relative(root, file);
  // The consumer modules that import from the protocol package ARE allowed to
  // re-export or alias the types — but they must import, not redeclare.
  const source = fs.readFileSync(file, 'utf8');
  if (INLINE_CALLBACK_PATTERN.test(source)) {
    violations.push(`${rel}: inline HermesRunCallbackPayload definition (import from @aries/hermes-protocol instead)`);
  }
  if (INLINE_CALLBACK_STATUS_PATTERN.test(source)) {
    violations.push(`${rel}: inline HermesRunCallbackStatus definition (import from @aries/hermes-protocol instead)`);
  }
}

if (violations.length > 0) {
  console.error('[validate-protocol-drift] FAIL: inline callback envelope definitions found outside protocol package:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  console.error('');
  console.error('Fix: replace inline type definitions with imports from @aries/hermes-protocol.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. hermes-callbacks.ts imports HermesRunCallbackPayload from the protocol pkg
// ---------------------------------------------------------------------------

const CALLBACKS_FILE = path.join(root, 'backend/execution/hermes-callbacks.ts');
const callbacksSource = fs.readFileSync(CALLBACKS_FILE, 'utf8');

if (!callbacksSource.includes('@aries/hermes-protocol')) {
  console.error('[validate-protocol-drift] FAIL: backend/execution/hermes-callbacks.ts does not import from @aries/hermes-protocol.');
  console.error('  Fix: replace inline HermesRunCallbackPayload/Status with imports from @aries/hermes-protocol.');
  process.exit(1);
}

console.log('[validate-protocol-drift] OK: protocol package present, no inline drift detected.');
