import { auth } from '@/auth';

import { isInternalOpsEmail } from '@/backend/telemetry/usage-attribution-env';

/**
 * AA-165 — the access check for internal, cross-company surfaces.
 *
 * Kept out of `lib/tenant-context.ts` on purpose: tenant context answers "which
 * ONE workspace is this request scoped to", and everything built on it assumes
 * that scoping. This answers a different question — "is this human our own
 * staff" — and a surface guarded by it is deliberately NOT tenant-scoped. Mixing
 * the two would make it easy to reach for the wrong one.
 *
 * Identity comes from the session email only. It is never taken from a header,
 * a query param, or the tenant claims, so nothing a customer controls can
 * influence it.
 */

export type InternalOpsActor = { email: string };

export type InternalOpsAccessResult =
  | { ok: true; actor: InternalOpsActor }
  | { ok: false; status: 401 | 403; reason: 'sign_in_required' | 'forbidden' };

/** Injectable for tests; defaults to the real Auth.js session. */
export type SessionLoader = () => Promise<{ user?: { email?: string | null } | null } | null>;

export async function resolveInternalOpsActor(
  sessionLoader: SessionLoader = auth as unknown as SessionLoader,
  env: Partial<Record<string, string | undefined>> = process.env,
): Promise<InternalOpsAccessResult> {
  let email: string | null = null;
  try {
    const session = await sessionLoader();
    const raw = session?.user?.email;
    email = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch {
    // A session-store failure is not authorization. Fail CLOSED — the opposite
    // of the usage guards, which fail open because a metering outage must not
    // look like a paywall. Here an outage must not look like a staff badge.
    return { ok: false, status: 403, reason: 'forbidden' };
  }

  if (!email) {
    return { ok: false, status: 401, reason: 'sign_in_required' };
  }
  if (!isInternalOpsEmail(email, env)) {
    // No detail about why: a customer admin probing this endpoint learns only
    // that they may not have it, never who may.
    return { ok: false, status: 403, reason: 'forbidden' };
  }
  return { ok: true, actor: { email: email.toLowerCase() } };
}
