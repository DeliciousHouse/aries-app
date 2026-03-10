import type { ProviderKey } from './provider-registry';

export type TokenHealth = 'healthy' | 'expiring_soon' | 'expired' | 'unknown';

export interface PlatformConnectionSchema {
  schema_name: 'aries_platform_connection';
  schema_version: '1.0.0';
  tenant_id: string;
  provider: ProviderKey;
  connection_id: string;
  status: 'connected' | 'disconnected' | 'reauthorization_required' | 'pending';
  token_health: TokenHealth;
  expires_at?: string;
  refresh_expires_at?: string;
  updated_at: string;
}

export function resolveTokenHealth(expiresAt?: string): TokenHealth {
  if (!expiresAt) return 'unknown';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= 0) return 'expired';
  if (ms < 24 * 60 * 60 * 1000) return 'expiring_soon';
  return 'healthy';
}
