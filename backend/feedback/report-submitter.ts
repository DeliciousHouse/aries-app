/**
 * Resolve durable report attribution without making feedback depend on auth.
 * Authenticated sessions keep their existing tenant-backed attribution. Missing,
 * expired, or failing sessions fall back to an anonymous identity derived from a
 * one-way client-IP hash so the public endpoint remains rate limited without
 * storing a raw address or inventing contact details.
 */

import { clientIpFromHeaders, hashIp } from '@/lib/feedback/submission';

export type ReportSubmitterAttribution = 'authenticated' | 'anonymous';

export interface ReportSubmitter {
  attribution: ReportSubmitterAttribution;
  userId: string;
  email: string | null;
  name: string | null;
  tenantId: string | null;
  tenantSlug: string | null;
}

interface ReportSession {
  user?: {
    id?: string | number | null;
    email?: string | null;
    name?: string | null;
    tenantId?: string | number | null;
    tenantSlug?: string | null;
  } | null;
}

interface ReportTenantContext {
  userId: string;
  tenantId: string;
  tenantSlug: string;
}

export interface ResolveReportSubmitterDeps {
  readSession(): Promise<ReportSession | null>;
  readTenantContext(): Promise<ReportTenantContext>;
}

function anonymousReportSubmitter(headers: Headers): ReportSubmitter {
  const ipHash = hashIp(clientIpFromHeaders(headers));
  return {
    attribution: 'anonymous',
    userId: `anonymous:${ipHash ?? 'unknown'}`,
    email: null,
    name: null,
    tenantId: 'anonymous',
    tenantSlug: 'anonymous',
  };
}

/**
 * Auth is optional by product decision. Tenant resolution runs only for a real
 * session; any auth/session edge case becomes an anonymous report rather than a
 * pre-persistence 401. Header-less requests intentionally share one bucket.
 */
export async function resolveReportSubmitter(
  headers: Headers,
  deps: ResolveReportSubmitterDeps,
): Promise<ReportSubmitter> {
  let session: ReportSession | null = null;
  try {
    session = await deps.readSession();
  } catch {
    return anonymousReportSubmitter(headers);
  }

  if (!session?.user?.id) {
    return anonymousReportSubmitter(headers);
  }

  let submitter: ReportSubmitter = {
    attribution: 'authenticated',
    userId: String(session.user.id),
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    tenantId: session.user.tenantId ? String(session.user.tenantId) : null,
    tenantSlug: session.user.tenantSlug ? String(session.user.tenantSlug) : null,
  };

  // A signed-in user without a resolved membership can still report. Preserve
  // session identity when tenant lookup fails, matching the previous behavior.
  try {
    const tenantContext = await deps.readTenantContext();
    submitter = {
      ...submitter,
      userId: tenantContext.userId,
      tenantId: tenantContext.tenantId,
      tenantSlug: tenantContext.tenantSlug,
    };
  } catch {
    // keep session-only attribution
  }

  return submitter;
}
