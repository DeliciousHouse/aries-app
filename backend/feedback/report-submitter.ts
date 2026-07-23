/**
 * Resolve durable report attribution without making feedback depend on auth.
 * Authenticated sessions keep their existing tenant-backed attribution. Missing,
 * expired, or failing sessions fall back to an anonymous identity derived from a
 * one-way client-IP hash so the public endpoint remains rate limited without
 * storing a raw address or inventing contact details.
 */

import { timingSafeEqual } from 'node:crypto';

import { clientIpFromHeaders, hashIp } from '@/lib/feedback/submission';

export type ReportSubmitterAttribution = 'authenticated' | 'anonymous';

export interface ReportSubmitter {
  attribution: ReportSubmitterAttribution;
  userId: string;
  tenantId: string | null;
}

interface ReportSession {
  user?: {
    id?: string | number | null;
  } | null;
}

interface ReportTenantContext {
  userId: string;
  tenantId: string;
}

export interface ResolveReportSubmitterDeps {
  readSession(): Promise<ReportSession | null>;
  readTenantContext(): Promise<ReportTenantContext>;
  readVerifiedClientIp?(headers: Headers): string | null;
}

export class ReportTenantAttributionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReportTenantAttributionError';
  }
}

/**
 * Forwarding headers are caller-controlled unless an upstream proxy proves it
 * sanitized and rewrote them. Deployments opt into that contract with one
 * server-only value; absent or invalid proof collapses anonymous callers into
 * the shared unknown bucket rather than letting header rotation bypass limits.
 */
export function verifiedClientIpFromHeaders(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const expected = env.ARIES_TRUSTED_PROXY_SECRET?.trim();
  const provided = headers.get('x-aries-proxy-verification')?.trim();
  if (!expected || !provided) return null;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length !== providedBytes.length) return null;
  if (!timingSafeEqual(expectedBytes, providedBytes)) return null;
  return clientIpFromHeaders(headers);
}

function anonymousReportSubmitter(verifiedIp: string | null): ReportSubmitter {
  const ipHash = hashIp(verifiedIp);
  return {
    attribution: 'anonymous',
    userId: `anonymous:${ipHash ?? 'unknown'}`,
    tenantId: 'anonymous',
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
    return anonymousReportSubmitter(
      deps.readVerifiedClientIp?.(headers) ?? verifiedClientIpFromHeaders(headers),
    );
  }

  if (!session?.user?.id) {
    return anonymousReportSubmitter(
      deps.readVerifiedClientIp?.(headers) ?? verifiedClientIpFromHeaders(headers),
    );
  }

  const sessionUserId = String(session.user.id);
  let tenantContext: ReportTenantContext;
  try {
    tenantContext = await deps.readTenantContext();
  } catch (error) {
    throw new ReportTenantAttributionError(
      'Current workspace membership could not be verified for feedback attribution.',
      { cause: error },
    );
  }

  if (tenantContext.userId !== sessionUserId) {
    throw new ReportTenantAttributionError(
      'Resolved workspace membership does not belong to the authenticated user.',
    );
  }

  return {
    attribution: 'authenticated',
    userId: tenantContext.userId,
    tenantId: tenantContext.tenantId,
  };
}
