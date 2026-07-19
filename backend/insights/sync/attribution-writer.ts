export type AttributionQueryable = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

function positiveIntegerString(value: string | number): string | null {
  const normalized = String(value).trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

export function normalizeAttributionPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  return normalized === 'meta' ? 'facebook' : normalized;
}

/**
 * Link an already-synced platform post to the Aries `posts` row that published
 * it. The NULL guard makes the writer additive and idempotent: attribution is
 * never reassigned if a row has already been linked.
 *
 * A newly-published platform post may not have reached `insights_posts` yet.
 * The sync upsert carries the durable scheduled/legacy lookup so publish-first
 * races converge on the next insights tick; this writer handles the inverse
 * ordering where the analytics row already exists.
 */
export async function stampInsightsPostAttribution(args: {
  db: AttributionQueryable;
  tenantId: string | number;
  ariesPostId: string | number;
  platform: string;
  platformPostId: string;
}): Promise<number> {
  const tenantId = Number(args.tenantId);
  const ariesPostId = positiveIntegerString(args.ariesPostId);
  const platform = normalizeAttributionPlatform(args.platform);
  const platformPostId = args.platformPostId.trim();

  if (!Number.isSafeInteger(tenantId) || tenantId < 1 || !ariesPostId || !platform || !platformPostId) {
    return 0;
  }

  const result = await args.db.query(
    `UPDATE insights_posts
        SET aries_post_id = $1
      WHERE tenant_id = $2
        AND platform = $3
        AND external_post_id = $4
        AND aries_post_id IS NULL`,
    [ariesPostId, tenantId, platform, platformPostId],
  );

  return result.rowCount ?? 0;
}
