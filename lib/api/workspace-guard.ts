/**
 * Client-side half of the multi-workspace mutation guard (plan Decision 2a,
 * Phase 3). This module is browser-safe on purpose — it must NOT import any
 * server-only code (next/headers, auth, db). The server half lives in
 * lib/tenant-context.ts (WorkspaceMismatchError + the getTenantContext guard).
 *
 * Responsibilities:
 *  1. Pin the workspace id the TAB booted under, once, at app load. The pin is
 *     deliberately set-once: if a sibling tab/device repoints the account's
 *     active workspace, THIS tab keeps sending the id it booted under so the
 *     server guard can detect the mismatch and 409 the write.
 *  2. Tell the shared fetch wrapper (lib/api/http.ts) whether the guard is
 *     active and hand it the header name/value to attach to state-changing
 *     requests (POST/PUT/PATCH/DELETE) only.
 *  3. Route every `409 workspace_mismatch` response into the single shell-level
 *     stale-workspace interlock via a registered handler.
 */

/**
 * Must match WORKSPACE_ID_HEADER in lib/tenant-context.ts. Re-declared here (not
 * imported) because that module pulls server-only deps; the value is asserted
 * to stay in sync by tests.
 */
export const WORKSPACE_ID_HEADER = 'x-aries-workspace-id';

let bootedWorkspaceId: string | null = null;
let guardActive = false;

export interface WorkspaceMismatchPayload {
  /** The workspace the account is active in NOW (the "Reload into <Y>" target). */
  activeWorkspaceId: string | null;
  /** The workspace this tab pinned / booted under (the "Switch back to <X>" target). */
  requestedWorkspaceId: string | null;
  message?: string;
}

let mismatchHandler: ((payload: WorkspaceMismatchPayload) => void) | null = null;

/**
 * Pin the booted workspace id and arm the guard. Set-once: the FIRST non-empty
 * call wins so the pinned id survives a mid-session pointer change in a sibling
 * tab (which is exactly the staleness the guard exists to catch). Idempotent on
 * repeat calls with the same id.
 */
export function activateWorkspaceGuard(workspaceId: string | null | undefined): void {
  if (guardActive) {
    return;
  }
  const normalized = workspaceId != null && String(workspaceId).trim() !== '' ? String(workspaceId) : null;
  if (!normalized) {
    return;
  }
  bootedWorkspaceId = normalized;
  guardActive = true;
}

export function isWorkspaceGuardActive(): boolean {
  return guardActive && bootedWorkspaceId != null;
}

export function getBootedWorkspaceId(): string | null {
  return bootedWorkspaceId;
}

/**
 * Method whose semantics change server state. The guard header rides these
 * only — never GET/HEAD/OPTIONS reads (a read is allowed to be one render
 * stale; a write is not — plan Decision 2a).
 */
export function isStateChangingMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

/**
 * Register the single stale-workspace interlock handler (the shell mounts one).
 * Returns an unregister fn. Only one handler is meaningful at a time; a second
 * registration replaces the first.
 */
export function registerWorkspaceMismatchHandler(
  handler: (payload: WorkspaceMismatchPayload) => void,
): () => void {
  mismatchHandler = handler;
  return () => {
    if (mismatchHandler === handler) {
      mismatchHandler = null;
    }
  };
}

/** Route a detected 409 workspace_mismatch into the interlock. No-op if unmounted. */
export function reportWorkspaceMismatch(payload: WorkspaceMismatchPayload): void {
  if (mismatchHandler) {
    try {
      mismatchHandler(payload);
    } catch {
      // The interlock handler must never break the failing request's own
      // error path; swallow.
    }
  }
}

/**
 * Extract the interlock payload from a parsed 409 response body when it carries
 * the shared `workspace_mismatch` shape (lib/tenant-context-http.ts). Returns
 * null for any other body so non-mismatch 409s fall through to normal handling.
 */
export function readWorkspaceMismatchBody(body: unknown): WorkspaceMismatchPayload | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.code !== 'workspace_mismatch' && record.reason !== 'workspace_mismatch') {
    return null;
  }
  const toId = (value: unknown): string | null =>
    value == null ? null : String(value);
  return {
    activeWorkspaceId: toId(record.active_workspace_id),
    requestedWorkspaceId: toId(record.requested_workspace_id),
    message: typeof record.message === 'string' ? record.message : undefined,
  };
}

/** Test-only reset so unit tests don't leak module state across cases. */
export function __resetWorkspaceGuardForTests(): void {
  bootedWorkspaceId = null;
  guardActive = false;
  mismatchHandler = null;
}
