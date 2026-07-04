import { auth } from '@/auth';
import { headers } from 'next/headers';
import pool from '@/lib/db';
import type { Session } from 'next-auth';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import {
  isTenantRole,
  missingTenantClaims,
  resolveTenantClaimsRow,
} from '@/lib/auth-tenant-membership';

export type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

/**
 * Request header the browser API client pins to the workspace id it booted
 * under. The client attaches it to state-changing (POST/PUT/PATCH/DELETE)
 * requests ONLY — never GET reads and never full-page navigations — so
 * "header present" is the mutation signal the guard below keys on (plan
 * Decision 2a). The value is the workspace/tenant id (== organization id ==
 * TenantContext.tenantId) that was active when the tab loaded.
 */
export const WORKSPACE_ID_HEADER = 'x-aries-workspace-id';

export type TenantContext = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  role: TenantRole;
  timezone?: string;
};

export class TenantContextError extends Error {
  readonly reason: 'tenant_membership_missing' | 'tenant_claims_incomplete';
  readonly missingClaims: string[];

  constructor(
    reason: 'tenant_membership_missing' | 'tenant_claims_incomplete',
    message: string,
    missingClaims: string[] = [],
  ) {
    super(message);
    this.name = 'TenantContextError';
    this.reason = reason;
    this.missingClaims = missingClaims;
  }
}

/**
 * Thrown by the multi-workspace mutation guard inside getTenantContext() when a
 * state-changing request is pinned (via WORKSPACE_ID_HEADER) to a workspace that
 * is NOT the account's currently-resolved active workspace — or when membership
 * could not be verified because tenant resolution fell back to stale session
 * claims (a DB blip; mutations fail closed — plan eng finding 12). The HTTP
 * layer maps this to `409 workspace_mismatch` and never executes the mutation
 * (plan Decision 2a). See workspaceMismatchResponse in lib/tenant-context-http.
 */
export class WorkspaceMismatchError extends Error {
  /**
   * `workspace_mismatch` — the pinned id differs from the active workspace (a
   * sibling tab/device switched the account's global active-workspace pointer).
   * `workspace_unverifiable` — resolution used the claims fallback, so
   * membership can't be checked; a write must fail closed.
   */
  readonly reason: 'workspace_mismatch' | 'workspace_unverifiable';
  /** The workspace the account is active in NOW (server-resolved truth). */
  readonly activeWorkspaceId: string;
  /** The workspace this tab pinned via WORKSPACE_ID_HEADER. */
  readonly requestedWorkspaceId: string;

  constructor(
    reason: 'workspace_mismatch' | 'workspace_unverifiable',
    activeWorkspaceId: string,
    requestedWorkspaceId: string,
  ) {
    super(
      reason === 'workspace_unverifiable'
        ? `Workspace membership could not be verified for a request pinned to ${requestedWorkspaceId} (tenant resolution used the session-claims fallback).`
        : `Request pinned to workspace ${requestedWorkspaceId} but the account is now active in workspace ${activeWorkspaceId}.`,
    );
    this.name = 'WorkspaceMismatchError';
    this.reason = reason;
    this.activeWorkspaceId = activeWorkspaceId;
    this.requestedWorkspaceId = requestedWorkspaceId;
  }
}

type Queryable = {
  query: (
    sql: string,
    params: unknown[]
  ) => Promise<{
    rowCount: number | null;
    rows: Array<{
      user_id: string | number;
      organization_id?: string | number | null;
      tenant_id?: string | number | null;
      tenant_slug?: string | null;
      role?: string | null;
    }>;
  }>;
};

function normalizeContextRow(row: {
  user_id: string | number;
  tenant_id?: string | number | null;
  tenant_slug?: string | null;
  role?: string | null;
}): TenantContext {
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    tenantSlug: String(row.tenant_slug),
    role: row.role as TenantRole,
  };
}

export async function loadTenantContextForUser(queryable: Queryable, userId: string): Promise<TenantContext> {
  // Claims resolution is consolidated onto the ONE membership-claims helper
  // (multi-workspace plan eng findings 5 + 14); this function owns only the
  // row → TenantContext / TenantContextError mapping.
  const row = await resolveTenantClaimsRow(
    queryable as unknown as Parameters<typeof resolveTenantClaimsRow>[0],
    { by: 'userId', userId },
  );

  if (!row) {
    throw new TenantContextError(
      'tenant_membership_missing',
      'No tenant membership found for authenticated user.',
    );
  }

  const missingClaims = missingTenantClaims(row);
  if (missingClaims.length > 0) {
    // Flag ON, the resolver returns a typed zero-membership shape (all tenant
    // fields NULL) for an account with no active workspace — a pointer to a
    // non-membership org resolves like NULL (plan Decision 7 / eng finding 9).
    // That state is 'tenant_membership_missing' (chooser / 403), NOT the
    // claims-incomplete hard-fail, which stays reserved for genuinely corrupt
    // rows. Flag OFF this branch is unreachable-by-flag and behavior is
    // byte-identical to today (golden-tested).
    if (isMultiWorkspaceEnabled() && !row.organization_id) {
      throw new TenantContextError(
        'tenant_membership_missing',
        'No active workspace membership found for authenticated user.',
      );
    }
    throw new TenantContextError(
      'tenant_claims_incomplete',
      `Authenticated user is missing required tenant claims: ${missingClaims.join(', ')}.`,
      missingClaims,
    );
  }

  return normalizeContextRow(row);
}

export function resolveTenantContextFromSession(session: Session | null): TenantContext | null {
  const user = session?.user;
  if (!user?.id || !user.tenantId || !user.tenantSlug || !user.role) {
    return null;
  }

  if (!isTenantRole(user.role)) {
    return null;
  }

  return {
    userId: String(user.id),
    tenantId: String(user.tenantId),
    tenantSlug: String(user.tenantSlug),
    role: user.role,
  };
}

type ResolvedTenantContext = {
  context: TenantContext;
  /**
   * True when the live DB resolution failed transiently and the resolver served
   * the stale session-claims fallback. Reads tolerate this (availability over
   * consistency); a MUTATING request must fail closed — membership cannot be
   * verified without the DB (plan eng finding 12 / Decision 2a).
   */
  usedClaimsFallback: boolean;
};

async function resolveTenantContextForSessionInternal(
  queryable: Queryable,
  session: Session | null,
): Promise<ResolvedTenantContext> {
  const claimContext = resolveTenantContextFromSession(session);
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error('Authentication required.');
  }

  try {
    return {
      context: await loadTenantContextForUser(queryable, userId),
      usedClaimsFallback: false,
    };
  } catch (error) {
    if (claimContext && !(error instanceof TenantContextError)) {
      return { context: claimContext, usedClaimsFallback: true };
    }
    throw error;
  }
}

export async function resolveTenantContextForSession(
  queryable: Queryable,
  session: Session | null,
): Promise<TenantContext> {
  // Thin wrapper — the DB-first-with-claims-fallback behavior is byte-identical
  // to before (golden-pinned). This path is used by RSC render surfaces
  // (workspace chooser, onboarding gate/start) and is INTENTIONALLY NOT guarded:
  // the mutation guard lives only in getTenantContext() (the API-route path).
  return (await resolveTenantContextForSessionInternal(queryable, session)).context;
}

/**
 * Read the pinned workspace id (WORKSPACE_ID_HEADER) from the current request.
 * Returns null when the header is absent (GET reads, full-page navigations,
 * RSC renders, old tabs, and non-browser clients all send none — the frontend
 * API client attaches it ONLY to state-changing requests) or when headers()
 * is unavailable (outside a request scope). Never throws → flag-OFF and
 * non-request callers are unaffected.
 */
async function readPinnedWorkspaceId(): Promise<string | null> {
  try {
    const store = await headers();
    const raw = store.get(WORKSPACE_ID_HEADER);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Multi-workspace mutation guard (plan Decision 2a / Eng finding S0). Enforced
 * INSIDE getTenantContext() — NOT the loadTenantContextOrResponse wrapper —
 * because ~12 mutating routes (team invite/role/delete, business profile, OAuth
 * refresh/disconnect, workflow runs) call getTenantContext() directly and never
 * touch the wrapper; a wrapper-level guard would fail open on exactly the
 * team-management surface multi-workspace modifies.
 *
 * Rule (flag ON only): a request that pins WORKSPACE_ID_HEADER and whose pinned
 * id is NOT the account's resolved active workspace is refused with a typed
 * WorkspaceMismatchError → mapped to 409 by the HTTP layer, so the mutation
 * never runs. Because the client sends the header only on state-changing
 * requests, GET reads (no header) always pass — the guard is scoped to writes
 * by construction. Header-absent is an accepted rollout gap (documented).
 */
async function assertActiveWorkspaceMatch(resolved: ResolvedTenantContext): Promise<void> {
  if (!isMultiWorkspaceEnabled()) {
    return; // flag OFF: header is never read → byte-identical to today
  }

  const requested = await readPinnedWorkspaceId();
  if (requested === null) {
    return; // no pinned workspace → not a guarded state-changing browser write
  }

  if (resolved.usedClaimsFallback) {
    console.warn('[workspace-guard] mutation blocked — membership unverifiable (claims fallback)', {
      requestedWorkspaceId: requested,
      activeWorkspaceId: resolved.context.tenantId,
      userId: resolved.context.userId,
    });
    throw new WorkspaceMismatchError(
      'workspace_unverifiable',
      resolved.context.tenantId,
      requested,
    );
  }

  if (requested !== resolved.context.tenantId) {
    console.warn('[workspace-guard] mutation blocked — pinned workspace no longer active', {
      requestedWorkspaceId: requested,
      activeWorkspaceId: resolved.context.tenantId,
      userId: resolved.context.userId,
    });
    throw new WorkspaceMismatchError(
      'workspace_mismatch',
      resolved.context.tenantId,
      requested,
    );
  }
}

export async function getTenantContext(): Promise<TenantContext> {
  const session = await auth();

  const client = await pool.connect();
  let resolved: ResolvedTenantContext;
  try {
    resolved = await resolveTenantContextForSessionInternal(client, session);
  } finally {
    client.release();
  }

  // Multi-workspace mutation guard (Decision 2a). Flag OFF → no-op (no header
  // read, byte-identical to today). Surfaces INTENTIONALLY out of this guard:
  //  - RSC / server actions that mutate on render (onboarding resume — Decision
  //    8, Phase 4; a full-page navigation carries no API-client header);
  //  - registerUserAction — pre-tenant by definition (no membership exists yet);
  //  - INTERNAL_API_SECRET routes + synthetic/system contexts — no browser
  //    session, so getTenantContext() is never their gate.
  await assertActiveWorkspaceMatch(resolved);

  return resolved.context;
}
