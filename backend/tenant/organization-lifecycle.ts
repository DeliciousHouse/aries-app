import type { TenantDeletionResult } from '@/backend/memory/tenant-deletion';
import { archiveTenantMemory } from '@/backend/memory/tenant-deletion';

/**
 * Archives the Honcho `aries-tenant-*` workspace for a Postgres `organizations.id`.
 * Invoke this **before** deleting the organization row (or any tenant-scoped data) so
 * derived memory is purged while Aries still knows the numeric tenant id.
 *
 * Postgres `DELETE FROM organizations` must be ordered by your migration policy
 * (for example reassigning or removing `users.organization_id` first when FKs require it).
 */
export async function archiveHonchoWorkspaceForOrganizationId(
  organizationId: number,
): Promise<TenantDeletionResult> {
  const ctx = {
    tenantId: String(organizationId),
    tenantSlug: '',
    userId: 'system',
    role: 'tenant_admin' as const,
  };

  return archiveTenantMemory(ctx);
}
