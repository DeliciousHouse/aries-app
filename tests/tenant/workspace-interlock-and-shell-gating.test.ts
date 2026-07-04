/**
 * Stale-workspace interlock trigger logic + shell flag-OFF byte-identity
 * (plan Decision 2a; Design Review "Stale-workspace interlock" + Interaction
 * state table; plan items 5 + 6).
 *
 * The interlock itself is a portal-mounted React alertdialog whose full render
 * is a rendered-QA success-bar item (screenshot checklist). What this file pins
 * is the trigger DECISION LOGIC and the shell GATING — the parts that decide
 * whether a stale write is caught and whether the whole feature is inert when
 * the flag is off — both of which are pure/structural and must never rot:
 *
 *   5. The 409 handler fires for `workspace_mismatch` and NOT for other errors
 *      (behavioral, via the client guard's reader); the focus-check compares the
 *      tab's BOOTED id against the SESSION's current tenantId and only raises on
 *      divergence.
 *   6. The shell renders the switcher + guard/interlock + arms the mutation-guard
 *      header ONLY when the flag is ON and the account has >1 active membership;
 *      otherwise the shell is byte-identical to the single-workspace model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  readWorkspaceMismatchBody,
  registerWorkspaceMismatchHandler,
  reportWorkspaceMismatch,
  __resetWorkspaceGuardForTests,
} from '../../lib/api/workspace-guard';
import { repoPath } from '../prd-invariants/_helpers';

// ── 5a. 409 handler fires ONLY for workspace_mismatch (behavioral) ───────────

test('the interlock handler is invoked for a workspace_mismatch body and NOT for other 409 shapes', () => {
  __resetWorkspaceGuardForTests();
  const fired: unknown[] = [];
  const unregister = registerWorkspaceMismatchHandler((p) => fired.push(p));

  // A real mismatch body → handler fires with the parsed payload.
  const mismatch = readWorkspaceMismatchBody({
    code: 'workspace_mismatch',
    active_workspace_id: '9',
    requested_workspace_id: '7',
  });
  assert.ok(mismatch);
  reportWorkspaceMismatch(mismatch!);
  assert.equal(fired.length, 1);

  // A non-mismatch 409 body (last_admin / generic conflict) → not a mismatch, so
  // the caller never reports it (readWorkspaceMismatchBody returns null and there
  // is nothing to hand the interlock).
  assert.equal(readWorkspaceMismatchBody({ code: 'last_admin' }), null);
  assert.equal(readWorkspaceMismatchBody({ error: 'version_conflict' }), null);
  assert.equal(fired.length, 1, 'only workspace_mismatch bodies reach the interlock');
  unregister();
  __resetWorkspaceGuardForTests();
});

// ── 5b. focus-check compares booted vs session tenantId (structural) ─────────

test('the focus-check raises the interlock only when the session tenantId diverges from the tab BOOTED id', () => {
  const guard = readFileSync(
    repoPath('components/redesign/layout/workspace-guard.tsx'),
    'utf8',
  );
  // It reads the session's current active workspace off /api/auth/session (a GET
  // read — no mutation-guard header) and compares it to the tab's booted id.
  assert.match(guard, /\/api\/auth\/session/, 'the focus-check reads the live session workspace');
  assert.match(guard, /getBootedWorkspaceId\(\)/, 'the focus-check reads the tab BOOTED id');
  // The raise is conditional on divergence — never fires when they are equal.
  assert.match(
    guard,
    /sessionWorkspaceId\s*&&\s*booted\s*&&\s*sessionWorkspaceId\s*!==\s*booted/,
    'the interlock is raised ONLY when session tenantId !== booted id',
  );
  assert.match(guard, /raiseInterlock\(/, 'divergence raises the interlock');
  // The interlock NEVER auto-navigates (unsaved caption text must survive behind
  // it, recoverable via Switch back) — the only navigations are user-initiated
  // button handlers.
  assert.match(guard, /role="alertdialog"/, 'the interlock is a blocking alertdialog');
  assert.doesNotMatch(
    guard,
    /useEffect\([^)]*\)\s*=>\s*\{[^}]*window\.location\.href/,
    'the interlock must not auto-navigate from an effect',
  );
});

// ── 6. Shell flag-OFF / single-workspace byte-identity gating ────────────────

test('the app shell renders the switcher + guard ONLY when flag ON AND >1 active membership (flag-OFF byte-identity)', () => {
  const shell = readFileSync(repoPath('components/redesign/layout/app-shell.tsx'), 'utf8');

  // The gate is the conjunction flag-ON && workspaceCount>1 && a resolved tenant.
  assert.match(
    shell,
    /const showWorkspaceSwitcher\s*=\s*multiWorkspaceEnabled\s*&&\s*sessionWorkspaceCount\s*>\s*1\s*&&\s*Boolean\(liveTenantId\)/,
    'the switcher/guard gate must be flag ON && >1 active membership && resolved tenant',
  );
  assert.match(shell, /const multiWorkspaceEnabled = isMultiWorkspaceEnabled\(\)/,
    'the gate must be driven by the multi-workspace flag');
  // workspaceCount rides the session (Phase 1) — no extra query just to decide
  // whether to render (jwt query-budget rule, eng finding 13).
  assert.match(shell, /session\.user\.workspaceCount/, 'workspaceCount must come from the session, not a new query');
});

test('the shell client mounts WorkspaceGuard ONLY under the flag+tenant gate (no interlock, no armed header, when off)', () => {
  const client = readFileSync(repoPath('components/redesign/layout/app-shell-client.tsx'), 'utf8');
  // The guard (which arms the mutation-guard header) is mounted behind the same
  // flag+tenant gate — so flag OFF / single-workspace attaches NO header and
  // renders NO interlock (byte-identical wire + DOM).
  assert.match(
    client,
    /\{multiWorkspaceEnabled && tenantId \?\s*[\s\S]*?<WorkspaceGuard[\s\S]*?\/>[\s\S]*?: null\}/,
    'WorkspaceGuard must mount only when multiWorkspaceEnabled && tenantId',
  );
  // The switcher likewise renders only under the gate.
  assert.match(client, /const showWorkspaceSwitcher = multiWorkspaceEnabled && workspaceSwitcher != null/,
    'the switcher renders only under the flag gate');
});
