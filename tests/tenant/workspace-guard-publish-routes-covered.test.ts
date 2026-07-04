/**
 * Mutation guard — publish/schedule/approve routes covered EXPLICITLY
 * (plan Additional test spec: "publish/schedule/approve routes covered
 * explicitly"; Decision 2a).
 *
 * The wrong-workspace-publish incident class is the whole reason the mutation
 * guard exists (a retargeted publish is an irreversible public post to the wrong
 * account). The generic inv-01b scan proves EVERY mutating route reaches an
 * auth gate; this file additionally pins the specific high-blast-radius write
 * routes named in the plan to a gate that maps the WorkspaceMismatchError into
 * the 409 → interlock:
 *   - `loadTenantContextOrResponse` (the wrapper — maps the mismatch to 409),
 *     reached directly or through a 1-hop handler import; OR
 *   - `workspaceMismatchResponse` (the raw-getTenantContext catch mapper).
 *
 * If any of these routes silently rots off the guarded set (e.g. a refactor
 * that stops threading tenant context), this test fails loudly — before a
 * stale-tab publish can land in the wrong workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { repoPath } from '../prd-invariants/_helpers';

const REPO_ROOT = repoPath();

// The high-blast-radius write routes the plan calls out explicitly.
const PUBLISH_SCHEDULE_APPROVE_ROUTES = [
  'app/api/marketing/jobs/[jobId]/approve/route.ts',
  'app/api/marketing/jobs/[jobId]/publish-facebook/route.ts',
  'app/api/marketing/jobs/[jobId]/publish-instagram/route.ts',
  'app/api/publish/dispatch/route.ts',
  'app/api/publish/retry/route.ts',
  'app/api/social-content/jobs/[jobId]/approve/route.ts',
  'app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts',
];

const GATE_RE = /\bloadTenantContextOrResponse\b|\bworkspaceMismatchResponse\b/;

function resolveImport(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

/** True when the file OR any 1-hop-imported local module reaches a 409-mapping gate. */
function reaches409Gate(absPath: string): boolean {
  const source = readFileSync(absPath, 'utf8');
  if (GATE_RE.test(source)) return true;
  for (const spec of parseImportSpecifiers(source)) {
    const resolved = resolveImport(spec, absPath);
    if (!resolved) continue;
    try {
      if (GATE_RE.test(readFileSync(resolved, 'utf8'))) return true;
    } catch {
      // unreadable — skip
    }
  }
  return false;
}

test('every named publish/schedule/approve route exists (no stale spec)', () => {
  const missing = PUBLISH_SCHEDULE_APPROVE_ROUTES.filter((r) => !existsSync(join(REPO_ROOT, r)));
  assert.deepEqual(missing, [], `stale route spec — file no longer exists:\n  ${missing.join('\n  ')}`);
});

test('publish/schedule/approve routes reach a WorkspaceMismatchError→409 gate (mutation guard covers the wrong-workspace-publish class)', () => {
  const ungated = PUBLISH_SCHEDULE_APPROVE_ROUTES.filter((r) => !reaches409Gate(join(REPO_ROOT, r)));
  assert.deepEqual(
    ungated,
    [],
    'These high-blast-radius write routes do NOT reach a 409 workspace-mismatch gate ' +
      '(loadTenantContextOrResponse / workspaceMismatchResponse) — a stale-tab publish could ' +
      `land in the wrong workspace:\n  ${ungated.join('\n  ')}`,
  );
});
