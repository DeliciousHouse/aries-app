/**
 * Composio AnalyticsProvider (Phase 8 + per-platform mapping).
 *
 * Returns NormalizedMetrics. Uses the per-platform analytics mappers
 * (analytics-mappers.ts) to build each tool's REAL arguments and parse its REAL
 * response shape. The verified tool slug is the default, so analytics works once
 * an account is connected — no per-op slug config required (a
 * COMPOSIO_<PLATFORM>_<OP>_ACTION env var still overrides it).
 *
 * When the platform/connection cannot serve a metric set — no mapper for the
 * platform/op, no active connection, or an unsuccessful tool call — it returns
 * an all-null envelope with an explicit `unavailableReason`, never fabricated
 * numbers.
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
import { getAnalyticsMapper, type MapperContext } from './analytics-mappers';
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

  private unavailable(
    platform: IntegrationPlatform,
    reason: string,
    ids?: { externalPostId?: string | null; externalAdId?: string | null },
  ): NormalizedMetrics {
    return emptyMetrics(platform, {
      externalPostId: ids?.externalPostId ?? null,
      externalAdId: ids?.externalAdId ?? null,
      unavailableReason: reason,
    });
  }

  private async run(args: {
    platform: IntegrationPlatform;
    op: ComposioOperation;
    tenantId: string;
    externalPostId?: string | null;
    externalAdId?: string | null;
    externalCampaignId?: string | null;
    since?: string;
    until?: string;
  }): Promise<NormalizedMetrics> {
    const { platform, op } = args;
    const mapper = getAnalyticsMapper(platform, op);
    if (!mapper) {
      return this.unavailable(platform, `${platform} does not expose ${op} via Composio.`, args);
    }
    // env override wins over the verified default slug.
    const slug = this.config.actionSlugFor(platform, op) ?? mapper.slug;

    const conn = await getConnectionRow(args.tenantId, platform, this.db);
    if (!conn || conn.status !== 'connected' || !conn.connectedAccountId) {
      return this.unavailable(platform, `No active ${platform} connection; metrics unavailable.`, args);
    }

    const ctx: MapperContext = {
      externalAccountId: conn.externalAccountId,
      externalPostId: args.externalPostId ?? null,
      externalAdId: args.externalAdId ?? null,
      externalCampaignId: args.externalCampaignId ?? null,
      since: args.since,
      until: args.until,
    };

    try {
      const result = await this.gateway.executeTool(slug, {
        connectedAccountId: conn.connectedAccountId,
        arguments: mapper.buildArgs(ctx),
      });
      if (!result.successful) {
        return this.unavailable(platform, result.error ?? 'Composio analytics tool reported unsuccessful.', args);
      }
      const base = emptyMetrics(platform, {
        externalPostId: args.externalPostId ?? null,
        externalAdId: args.externalAdId ?? null,
      });
      base.rawMetrics = result.data ?? null;
      // Parsers return number|null per field (never undefined), so the all-null
      // base stays null for any metric this platform/response did not report.
      Object.assign(base, mapper.parse(result.data));
      return base;
    } catch (error) {
      return this.unavailable(platform, error instanceof Error ? error.message : 'Composio analytics call failed.', args);
    }
  }

  async getPostInsights(input: PostInsightsInput): Promise<NormalizedMetrics> {
    return this.run({
      platform: input.platform,
      op: 'post_insights',
      tenantId: input.tenantId,
      externalPostId: input.externalPostId,
    });
  }

  async getAdInsights(input: AdInsightsInput): Promise<NormalizedMetrics> {
    return this.run({
      platform: input.platform,
      op: 'ad_insights',
      tenantId: input.tenantId,
      externalAdId: input.externalAdId ?? null,
      externalCampaignId: input.externalCampaignId ?? null,
    });
  }

  async getAccountInsights(input: AccountInsightsInput): Promise<NormalizedMetrics> {
    return this.run({
      platform: input.platform,
      op: 'account_insights',
      tenantId: input.tenantId,
      since: input.since,
      until: input.until,
    });
  }
}
