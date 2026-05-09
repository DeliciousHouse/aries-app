import { createHmac } from 'node:crypto';
import { MemoryError } from './errors';

const PSEUDONYM_HEX_LENGTH = 32;
const WORKSPACE_PREFIX = 'aries-tenant-';

function readSalt(env: Partial<Record<string, string | undefined>> = process.env): string {
  const salt = env.ARIES_TENANT_PSEUDONYM_SALT;
  if (!salt || salt.trim().length < 16) {
    throw new MemoryError(
      'pseudonym_salt_missing',
      'ARIES_TENANT_PSEUDONYM_SALT must be set to a 16+ character secret.',
      500,
    );
  }
  return salt;
}

export function pseudonymForTenant(
  tenantId: string | number,
  env: Partial<Record<string, string | undefined>> = process.env,
): string {
  const id = String(tenantId ?? '').trim();
  if (!id) {
    throw new MemoryError('tenant_context_required', 'tenantId required for pseudonymization.', 400);
  }
  return createHmac('sha256', readSalt(env)).update(id).digest('hex').slice(0, PSEUDONYM_HEX_LENGTH);
}

export function pseudonymForUser(userId: string | number): string {
  const id = String(userId ?? '').trim();
  if (!id) {
    throw new MemoryError('invalid_request', 'userId required for pseudonymization.', 400);
  }
  return createHmac('sha256', readSalt()).update(`user:${id}`).digest('hex').slice(0, PSEUDONYM_HEX_LENGTH);
}

export function workspaceIdForTenant(
  tenantId: string | number,
  env: Partial<Record<string, string | undefined>> = process.env,
): string {
  return `${WORKSPACE_PREFIX}${pseudonymForTenant(tenantId, env)}`;
}

export function isAriesTenantWorkspace(workspaceId: string): boolean {
  return typeof workspaceId === 'string' && workspaceId.startsWith(WORKSPACE_PREFIX);
}

export const ARIES_TENANT_WORKSPACE_PREFIX = WORKSPACE_PREFIX;
