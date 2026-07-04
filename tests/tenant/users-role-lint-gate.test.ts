/**
 * users.role read/write lint gate (multi-workspace plan Risk 2 + eng finding
 * 10; active from Phase 1 onward).
 *
 * Under multi-workspace, the authoritative role lives on the
 * organization_memberships row; users.role is a LEGACY MIRROR of the active
 * membership, kept only for rollout back-compat and deleted in Phase 5. Any
 * NEW code path that reads users.role directly is a potential cross-org
 * privilege escalation (an org-A admin reading as org-B admin), and any new
 * WRITER outside the membership seam produces reverse mirror drift (mirror
 * fresh, membership stale).
 *
 * This is a structural tripwire over SQL strings (the inv-01b pattern): it
 * walks the runtime source trees, flags every file whose SQL touches the
 * users table's role column, and fails when a file outside the explicit
 * allowlist shows up. To add a site, route it through
 * lib/auth-tenant-membership.ts instead — or, if genuinely necessary, extend
 * the allowlist WITH a rationale comment (and expect review pushback).
 *
 * NOTE: indirect writers (e.g. resolveTenantForDraft in
 * app/onboarding/resume/page.tsx) go through assignUserToOrganization and are
 * covered by the allowlisted membership module — that is the intended shape.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from '../helpers/project-root';

const REPO_ROOT = path.join(resolveProjectRoot(import.meta.url), '..');

// Runtime source scanned for direct SQL against users.role. Tests, migrations,
// and scripts/init-db.js (schema DDL, .js) are deliberately out of scope.
const SCAN_DIRS = ['lib', 'backend', 'app', 'scripts'];
const SCAN_ROOT_FILES = ['auth.ts'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Today's known users.role SQL sites (seeded 2026-07-04, Phase 1). Every entry
 * is legacy-mirror machinery scheduled for conversion (Phase 2) or removal
 * (Phase 5):
 *  - auth.ts — sign-in SELECT feeding ensureTenantAccessForUser (legacy claims
 *    input; removed with the flag-OFF path in Phase 5).
 *  - lib/auth-tenant-membership.ts — THE membership module: legacy flag-OFF
 *    claims query, the role-mirror writes (assignUserToOrganization,
 *    ensureTenantAccessForUser dev backfill + flag-ON repoint), and the
 *    self-heal read.
 *  - backend/tenant/user-profiles.ts — member CRUD (list/create/update read
 *    and write users.role; converted to membership rows in Phase 2).
 *  - backend/tenant/workspace-invitations.ts — absorb repoint (pointer + role
 *    mirror in one statement) and the accept-path user-row locks.
 *  - backend/tenant/workspace-switch.ts — the Phase 3 switch repoint: pointer +
 *    legacy role mirror move together in ONE statement (CEO hardening 3, closes
 *    the skew window). The role written is the target MEMBERSHIP's role (read
 *    from organization_memberships), not a fresh users.role read — so it is a
 *    mirror sync, not a users.role-as-source-of-truth read. Removed with the
 *    mirror in Phase 5.
 *  - scripts/qa/seed-qa-tenant.ts — QA sandbox seed (pinned identity).
 */
const ALLOWLIST = new Set<string>([
  'auth.ts',
  'lib/auth-tenant-membership.ts',
  'backend/tenant/user-profiles.ts',
  'backend/tenant/workspace-invitations.ts',
  'backend/tenant/workspace-switch.ts',
  'scripts/qa/seed-qa-tenant.ts',
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      yield* walk(full);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry))) {
      yield full;
    }
  }
}

function usersRoleTouchKinds(src: string): string[] {
  const kinds: string[] = [];

  // UPDATE users SET ... role ...
  if (/update\s+users\s+set[^;]{0,300}?\brole\b/i.test(src)) {
    kinds.push('update');
  }

  // INSERT INTO users (<columns containing role>)
  const insertRe = /insert\s+into\s+users\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = insertRe.exec(src)) !== null) {
    if (/\brole\b/i.test(match[1])) {
      kinds.push('insert');
      break;
    }
  }

  // u.role in a query over "FROM/JOIN users u"
  if (/\bu\.role\b/.test(src) && /(from|join)\s+users\s+u\b/i.test(src)) {
    kinds.push('alias-read');
  }

  // SELECT ... role ... FROM users (non-aliased single-table reads)
  if (/select[^;`]{0,200}?\brole\b[^;`]{0,300}?from\s+users\b(?!\s+u\b)/i.test(src)) {
    kinds.push('bare-select');
  }

  return kinds;
}

test('no NEW users.role SQL outside the membership module allowlist (Risk 2 / eng finding 10)', () => {
  const violations: string[] = [];
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    files.push(...walk(path.join(REPO_ROOT, dir)));
  }
  for (const rootFile of SCAN_ROOT_FILES) {
    files.push(path.join(REPO_ROOT, rootFile));
  }

  const flagged = new Set<string>();
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const kinds = usersRoleTouchKinds(readFileSync(file, 'utf8'));
    if (kinds.length === 0) continue;
    flagged.add(rel);
    if (!ALLOWLIST.has(rel)) {
      violations.push(`${rel} (${kinds.join(', ')})`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `users.role is a legacy mirror — new reads/writes must go through the membership seam ` +
      `(lib/auth-tenant-membership.ts / organization_memberships.role). Violations:\n${violations.join('\n')}`,
  );

  // The gate must keep BITING: if an allowlisted site is cleaned up (Phase 2/5
  // conversions), remove it here so it cannot silently regrow.
  for (const allowed of ALLOWLIST) {
    assert.ok(
      flagged.has(allowed),
      `${allowed} no longer touches users.role — remove it from the allowlist to keep the gate tight`,
    );
  }
});
