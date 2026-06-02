/**
 * Composio CapabilityProvider — resolves the capability matrix for a connected
 * account and persists it on the connection row so the UI can render without a
 * live round-trip every load.
 */

import type { CapabilityProvider } from '../providers/interfaces';
import { emptyCapabilities, type Capabilities, type IntegrationPlatform } from '../providers/types';
import type { ComposioConfig } from './composio-config';
import type { ComposioGateway } from './composio-client';
import { getConnectionRow, saveCapabilities, type Queryable } from './connection-store';
import { computeCapabilities } from './capability-preflight';
import { isActiveStatus } from './status-map';
import pool from '@/lib/db';

export class ComposioCapabilityProvider implements CapabilityProvider {
  readonly kind = 'composio' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
  ) {}

  async checkCapabilities(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<Capabilities> {
    if (!options?.tenantId) return emptyCapabilities('composio');

    const stored = await getConnectionRow(options.tenantId, platform, this.db);
    let active = stored?.status === 'connected';

    // If we have a connected-account id, confirm liveness against Composio.
    if (stored?.connectedAccountId) {
      try {
        const live = await this.gateway.getConnection(stored.connectedAccountId);
        if (live) active = isActiveStatus(live.status);
      } catch {
        /* keep the stored view */
      }
    }

    const caps = computeCapabilities({ config: this.config, platform, active });

    if (stored) {
      try {
        await saveCapabilities(options.tenantId, platform, caps, this.db);
      } catch {
        /* persistence is best-effort; the computed matrix is still returned */
      }
    }

    return caps;
  }
}
