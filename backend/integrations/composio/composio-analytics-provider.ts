/**
 * Composio AnalyticsProvider (Phase 8).
 *
 * Returns NormalizedMetrics. When the platform/connection cannot serve a metric
 * set — no configured action slug, no active connection, or an unsuccessful
 * tool call — it returns an all-null envelope with an explicit
 * `unavailableReason` rather than fabricating numbers.
 */

import type { AnalyticsProvider } from '../providers/interfaces';
import {
  emptyMetrics,
  isIntegrationPlatform,
  type AccountInsightsInput,
  type AdInsightsInput,
  type IntegrationPlatform,
  type NormalizedMetrics,
  type PostInsightsInput,
} from '../providers/types';
import type { ComposioConfig, ComposioOperation } from './composio-config';
import type { ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import { normalizeMetrics } from './metrics-normalizer';
import pool from '@/lib/db';

export class ComposioAnalyticsProvider implements AnalyticsProvider {
  readonly kind = 'composio' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
  ) {}

  supports(platform: IntegrationPlatform): boolean {
    return isIntegrationPlatform(platform);
  }

  private async run(args: {
    tenantId: string;
    platform: IntegrationPlatform;
    op: ComposioOperation;
    externalPostId?: string | null;
    externalAdId?: string | null;
    toolArguments: Record<string, unknown>;
  }): Promise<NormalizedMetrics> {
    const slug = this.config.actionSlugFor(args.platform, args.op);
    if (!slug) {
      return emptyMetrics(args.platform, {
        externalPostId: args.externalPostId ?? null,
        externalAdId: args.externalAdId ?? null,
        unavailableReason: `No ${args.op} action is configured for ${args.platform} (set COMPOSIO_${args.platform.toUpperCase()}_${args.op.toUpperCase()}_ACTION). Metrics unavailable.`,
      });
    }

    const conn = await getConnectionRow(args.tenantId, args.platform, this.db);
    if (!conn || conn.status !== 'connected' || !conn.connectedAccountId) {
      return emptyMetrics(args.platform, {
        externalPostId: args.externalPostId ?? null,
        externalAdId: args.externalAdId ?? null,
        unavailableReason: `No active ${args.platform} connection; metrics unavailable.`,
      });
    }

    try {
      const result = await this.gateway.executeTool(slug, {
        connectedAccountId: conn.connectedAccountId,
        arguments: args.toolArguments,
      });
      if (!result.successful) {
        return emptyMetrics(args.platform, {
          externalPostId: args.externalPostId ?? null,
          externalAdId: args.externalAdId ?? null,
          unavailableReason: result.error ?? 'Composio analytics tool reported unsuccessful.',
        });
      }
      return normalizeMetrics({
        platform: args.platform,
        externalPostId: args.externalPostId ?? null,
        externalAdId: args.externalAdId ?? null,
        raw: result.data,
      });
    } catch (error) {
      return emptyMetrics(args.platform, {
        externalPostId: args.externalPostId ?? null,
        externalAdId: args.externalAdId ?? null,
        unavailableReason: error instanceof Error ? error.message : 'Composio analytics call failed.',
      });
    }
  }

  async getPostInsights(input: PostInsightsInput): Promise<NormalizedMetrics> {
    return this.run({
      tenantId: input.tenantId,
      platform: input.platform,
      op: 'post_insights',
      externalPostId: input.externalPostId,
      toolArguments: { post_id: input.externalPostId },
    });
  }

  async getAdInsights(input: AdInsightsInput): Promise<NormalizedMetrics> {
    return this.run({
      tenantId: input.tenantId,
      platform: input.platform,
      op: 'ad_insights',
      externalAdId: input.externalAdId ?? null,
      toolArguments: { ad_id: input.externalAdId, campaign_id: input.externalCampaignId },
    });
  }

  async getAccountInsights(input: AccountInsightsInput): Promise<NormalizedMetrics> {
    return this.run({
      tenantId: input.tenantId,
      platform: input.platform,
      op: 'account_insights',
      toolArguments: { since: input.since, until: input.until },
    });
  }
}
