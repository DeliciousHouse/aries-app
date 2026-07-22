// PRD §20 invariant 1 (strengthened):
//   "Aries owns tenant boundaries, canonical state, approvals, audit, and
//    workflow policy."
//
// Structural enforcement: every state-mutating route handler under app/api/
// MUST reach one of the three recognized auth-gate functions either directly
// in the route file or in any directly-imported (1-hop) local module.
//
// Motivation: PR #470 fixed an ungated route that PR #467's coverage check
// missed because #467 only verified that getTenantContext *exists* and has
// callers — not that every POST/PUT/DELETE/PATCH handler is actually gated.
// This test provides that structural guarantee going forward.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { rel, repoPath, walk } from './_helpers';

// ── Auth-gate patterns ──────────────────────────────────────────────────────

const AUTH_GATE_PATTERNS = [
  /\bgetTenantContext\s*\(/,
  /\bloadTenantContextOrResponse\s*\(/,
  /\bverifyInternalCallbackRequest\s*\(/,
  // Loader-alias pattern: `const loader = options.tenantContextLoader ?? getTenantContext;`
  // followed by `loader()` at the call site. The handler still gates on a
  // tenant context — the alias just lets tests inject a stub. Match the
  // `?? getTenantContext` fallback so the 1-hop scanner recognizes this
  // form without needing to follow the loader through a second indirection.
  /\?\?\s*getTenantContext\b/,
  // Multi-workspace mutation guard helper (plan Phase 3, Decision 2a). A route
  // that maps the getTenantContext() workspace-mismatch throw to `409
  // workspace_mismatch` references workspaceMismatchResponse in its catch — it
  // gates on getTenantContext too (so it already matches above), but this
  // pattern makes the structural test explicitly "learn" the guard helper so
  // it can never silently rot out of the recognized set.
  /\bworkspaceMismatchResponse\s*\(/,
];

function hasAuthGate(source: string): boolean {
  return AUTH_GATE_PATTERNS.some((p) => p.test(source));
}

// ── 1-hop import resolver ───────────────────────────────────────────────────

const REPO_ROOT = repoPath();

/**
 * Resolve a TypeScript import specifier to an absolute file path.
 * Handles @/ (repo root alias), ./ and ../ relative imports.
 * Returns null for bare package imports or unresolvable paths.
 */
function resolveImport(specifier: string, fromFile: string): string | null {
  let base: string;

  if (specifier.startsWith('@/')) {
    base = join(REPO_ROOT, specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    // bare package import — skip
    return null;
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Parse all `from '...'` / `from "..."` import specifiers from a source file.
 */
function parseImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

// ── State-mutating export detector ─────────────────────────────────────────

const MUTATING_EXPORT_RE =
  /export\s+(?:async\s+function|function|const)\s+(POST|PUT|DELETE|PATCH)\b/;

function hasStateMutatingExport(source: string): boolean {
  return MUTATING_EXPORT_RE.test(source);
}

// ── Allowlist ───────────────────────────────────────────────────────────────

type AllowlistEntry = {
  path: string; // relative to repo root, using forward slashes
  rationale: string;
};

const ALLOWLIST: AllowlistEntry[] = [
  {
    path: 'app/api/auth/[...nextauth]/route.ts',
    rationale: 'next-auth signin/signout/session must be pre-session',
  },
  {
    path: 'app/api/auth/forgot-password/route.ts',
    rationale: 'pre-session password reset — no session exists yet',
  },
  {
    path: 'app/api/auth/reset-password/route.ts',
    rationale: 'pre-session password reset — no session exists yet',
  },
  {
    path: 'app/api/auth/invite/accept/route.ts',
    rationale:
      'pre-session workspace-invite acceptance — authenticated by the single-use invite token (sha256-hashed at rest), not a session; the invitee has no account password until this call sets it',
  },
  {
    path: 'app/api/auth/invite/absorb/route.ts',
    rationale:
      'absorb-orphan consent accept (multi-workspace Phase 0.5) — gated on auth() session + in-transaction session-is-the-invited-account verification; getTenantContext would resolve the invitee’s OLD workspace, which is exactly the org this call moves them out of',
  },
  {
    path: 'app/api/auth/invite/join/route.ts',
    rationale:
      'join-as-existing-account consent accept (multi-workspace Phase 2, flag-gated 404 when OFF) — gated on auth() session + in-transaction session-is-the-invited-account verification; getTenantContext would resolve the invitee’s CURRENT workspace, not the one they are consenting to join',
  },
  {
    path: 'app/api/tenant/workspace/switch/route.ts',
    rationale:
      'workspace switch (multi-workspace Phase 3, flag-gated 404 when OFF) — gated on auth() session + server-side membership validation inside switchActiveWorkspace’s transaction (the target must be an ACTIVE membership of the caller). It deliberately does NOT gate on getTenantContext(): this is the ONE mutation that moves the account’s active-workspace pointer, so the WORKSPACE_ID_HEADER mismatch guard inside getTenantContext() would 409 the very switch it is performing (the tab is pinned to the OLD workspace by definition).',
  },
  {
    path: 'app/api/oauth/[provider]/callback/route.ts',
    rationale: 'OAuth provider callback resolves tenant via state token, not session',
  },
  {
    path: 'app/api/oauth/[provider]/start/route.ts',
    rationale: 'pre-session operator OAuth dance start — delegates to handleIntegrationsConnect which gates on session',
  },
  {
    path: 'app/api/early-access/route.ts',
    rationale: 'public early-access email signup — no tenant exists yet',
  },
  {
    path: 'app/api/hackathon/register/route.ts',
    rationale: 'public hackathon registration — intentionally pre-session per inline comment',
  },
  {
    path: 'app/api/integrations/slack/events/route.ts',
    rationale:
      'Slack Events API webhook — authenticated via HMAC verifySlackSignature (not tenant-session); tenant resolution not applicable for inbound webhooks',
  },
  {
    path: 'app/api/onboarding/draft/route.ts',
    rationale: 'pre-session onboarding draft creation/update — tenant does not exist yet at this stage',
  },
  {
    path: 'app/api/onboarding/start/route.ts',
    rationale: 'pre-session tenant creation — this is the flow that creates the tenant',
  },
  {
    path: 'app/api/internal/marketing/job-runtime/route.ts',
    rationale: 'deprecated stub — returns HTTP 410 immediately with no state mutation',
  },
];

const ALLOWLIST_SET = new Set(ALLOWLIST.map((e) => e.path));

// ── Tests ───────────────────────────────────────────────────────────────────

test('every allowlist entry exists on disk (no stale paths)', () => {
  const missing: string[] = [];
  for (const entry of ALLOWLIST) {
    const abs = join(REPO_ROOT, entry.path);
    if (!existsSync(abs)) {
      missing.push(entry.path);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Stale allowlist entries — file no longer exists:\n  ${missing.join('\n  ')}`,
  );
});

test('state-mutating routes scan finds >=30 routes (regression guard on scanner)', () => {
  const routeFiles = walk(repoPath('app/api')).filter((f) => rel(f).endsWith('/route.ts'));
  const mutating = routeFiles.filter((f) => {
    try {
      return hasStateMutatingExport(readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  });
  assert.ok(
    mutating.length >= 30,
    `Expected >=30 state-mutating routes; found ${mutating.length}. ` +
      `The scanner regex may have regressed.`,
  );
});

test('getTenantContext() enforces the multi-workspace mutation guard (guard cannot silently rot)', () => {
  // Multi-workspace plan Phase 3, Decision 2a + Eng finding S0: the workspace-
  // mismatch guard MUST live inside getTenantContext() itself (not the
  // loadTenantContextOrResponse wrapper), because ~12 mutating routes call
  // getTenantContext() directly and bypass the wrapper. This structural check
  // fails loudly if the guard is ever removed or moved out of getTenantContext.
  const source = readFileSync(repoPath('lib/tenant-context.ts'), 'utf8');

  // The guard exists and throws the typed error the HTTP layer maps to 409.
  assert.match(
    source,
    /class WorkspaceMismatchError/,
    'WorkspaceMismatchError must exist in lib/tenant-context.ts',
  );
  assert.match(
    source,
    /function assertActiveWorkspaceMatch/,
    'The workspace-mismatch guard (assertActiveWorkspaceMatch) must exist in lib/tenant-context.ts',
  );

  // getTenantContext must actually CALL the guard — assert the call appears in
  // the getTenantContext function body (between its declaration and the return).
  const fnStart = source.indexOf('export async function getTenantContext');
  assert.ok(fnStart >= 0, 'getTenantContext must be defined in lib/tenant-context.ts');
  const fnBody = source.slice(fnStart);
  assert.match(
    fnBody.slice(0, fnBody.indexOf('\n}')),
    /assertActiveWorkspaceMatch\s*\(/,
    'getTenantContext() must invoke assertActiveWorkspaceMatch — the mutation guard was removed or bypassed',
  );

  // The HTTP layer maps the typed error to a 409 response in exactly one place.
  const httpSource = readFileSync(repoPath('lib/tenant-context-http.ts'), 'utf8');
  assert.match(
    httpSource,
    /WorkspaceMismatchError/,
    'lib/tenant-context-http.ts must map WorkspaceMismatchError → 409',
  );
  assert.match(
    httpSource,
    /status:\s*409|409,/,
    'workspaceMismatchResponse must return HTTP 409',
  );
});

test('every state-mutating app/api route has an auth gate or is allowlisted', () => {
  const routeFiles = walk(repoPath('app/api')).filter((f) => rel(f).endsWith('/route.ts'));
  const violations: string[] = [];

  for (const abs of routeFiles) {
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    if (!hasStateMutatingExport(source)) continue;

    // Compute the repo-relative path for allowlist lookup
    const relativePath = rel(abs);

    if (ALLOWLIST_SET.has(relativePath)) continue;

    // Check direct (in-file) auth gate
    if (hasAuthGate(source)) continue;

    // Check 1-hop imports
    const specifiers = parseImportSpecifiers(source);
    let foundVia1Hop = false;
    for (const spec of specifiers) {
      const resolved = resolveImport(spec, abs);
      if (!resolved) continue;
      try {
        const importedSource = readFileSync(resolved, 'utf8');
        if (hasAuthGate(importedSource)) {
          foundVia1Hop = true;
          break;
        }
      } catch {
        // unreadable import — skip
      }
    }

    if (!foundVia1Hop) {
      violations.push(relativePath);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `State-mutating routes with no auth gate (direct or 1-hop) and not allowlisted:\n  ${violations.join('\n  ')}\n` +
      `Each violation is a potential security gap. Fix the route or add to ALLOWLIST with rationale.`,
  );
});
