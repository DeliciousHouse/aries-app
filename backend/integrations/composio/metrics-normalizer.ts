/**
 * Normalize a raw provider metrics payload into NormalizedMetrics.
 *
 * Rule: a metric the payload does not contain stays `null`. We never coerce a
 * missing field to 0 — a null genuinely means "not reported", which downstream
 * dashboards must render as "—" rather than a real zero.
 */

import { emptyMetrics, type IntegrationPlatform, type NormalizedMetrics } from '../providers/types';

/** Candidate source keys for each normalized metric (first present wins). */
const METRIC_KEYS: Record<keyof Omit<NormalizedMetrics, 'platform' | 'externalPostId' | 'externalAdId' | 'publishedAt' | 'rawMetrics' | 'unavailableReason'>, string[]> = {
  impressions: ['impressions', 'impression_count'],
  reach: ['reach', 'unique_impressions'],
  views: ['views', 'video_views', 'play_count', 'plays'],
  likes: ['likes', 'like_count', 'reactions', 'favorites', 'ups'],
  comments: ['comments', 'comment_count', 'num_comments'],
  shares: ['shares', 'share_count', 'reposts', 'retweets'],
  saves: ['saves', 'saved', 'bookmarks'],
  clicks: ['clicks', 'link_clicks', 'click_count'],
  spend: ['spend', 'amount_spent', 'cost'],
  cpm: ['cpm'],
  cpc: ['cpc'],
  ctr: ['ctr'],
  conversions: ['conversions', 'results', 'actions'],
  costPerResult: ['cost_per_result', 'cost_per_conversion', 'cpa'],
  revenue: ['revenue', 'purchase_value', 'conversion_value'],
  roas: ['roas', 'return_on_ad_spend'],
};

function flatten(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  // Unwrap one common nesting level (insights/metrics/data/response).
  for (const key of ['metrics', 'insights', 'data', 'response', 'stats']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return { ...obj, ...(nested as Record<string, unknown>) };
    }
  }
  return obj;
}

function readNumber(src: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function readString(src: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function normalizeMetrics(args: {
  platform: IntegrationPlatform;
  externalPostId?: string | null;
  externalAdId?: string | null;
  raw: unknown;
}): NormalizedMetrics {
  const base = emptyMetrics(args.platform, {
    externalPostId: args.externalPostId ?? null,
    externalAdId: args.externalAdId ?? null,
  });
  base.rawMetrics = args.raw ?? null;

  const src = flatten(args.raw);
  base.publishedAt = readString(src, ['published_at', 'created_time', 'timestamp', 'created_at']);
  (Object.keys(METRIC_KEYS) as Array<keyof typeof METRIC_KEYS>).forEach((metric) => {
    base[metric] = readNumber(src, METRIC_KEYS[metric]);
  });
  return base;
}
