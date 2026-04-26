import { CreativeMemoryServiceError } from './errors';
import type { TenantContext as AppTenantContext } from '@/lib/tenant-context';

export type TenantContext = Pick<AppTenantContext, 'tenantId'|'tenantSlug'|'userId'|'role'>;

export function requireNumericTenantId(ctx: Pick<TenantContext,'tenantId'>): number {
  const raw = String(ctx?.tenantId ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new CreativeMemoryServiceError('tenant_context_not_materialized','Creative Memory requires a database-backed numeric tenant.',401);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new CreativeMemoryServiceError('tenant_context_not_materialized','Creative Memory requires a database-backed numeric tenant.',401);
  return id;
}

export function requireCreativeMemoryWriter(ctx: TenantContext): void {
  const role = String(ctx.role ?? '');
  if (role === 'tenant_viewer' || role === 'viewer' || role === 'read_only') {
    throw new CreativeMemoryServiceError('invalid_request', 'Creative Memory write access requires an operator role.', 403);
  }
}
