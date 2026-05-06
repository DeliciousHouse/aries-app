export type ScheduledPostQueryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{
    rows: Array<{
      id: string | number | bigint;
      post_id: string | number | bigint;
      tenant_id: string | number;
      scheduled_for: string | Date;
      target_platforms: string[];
      updated_at: string | Date;
    }>;
    rowCount: number | null;
  }>;
};

export interface UpsertScheduledPostInput {
  tenantId: number;
  postId: number;
  scheduledFor: Date;
  platforms: string[];
}

export interface ScheduledPostRecord {
  id: string;
  postId: string;
  tenantId: number;
  scheduledFor: string;
  platforms: string[];
  updatedAt: string;
}

const UPSERT_SCHEDULED_POST_SQL = `
  INSERT INTO scheduled_posts (post_id, tenant_id, scheduled_for, target_platforms, updated_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (post_id) DO UPDATE
    SET scheduled_for = EXCLUDED.scheduled_for,
        target_platforms = EXCLUDED.target_platforms,
        updated_at = now()
    WHERE scheduled_posts.tenant_id = EXCLUDED.tenant_id
  RETURNING id, post_id, tenant_id, scheduled_for, target_platforms, updated_at
`;

function normalizeTimestamp(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export async function upsertScheduledPost(
  queryable: ScheduledPostQueryable,
  input: UpsertScheduledPostInput,
): Promise<ScheduledPostRecord> {
  const result = await queryable.query(UPSERT_SCHEDULED_POST_SQL, [
    input.postId,
    input.tenantId,
    input.scheduledFor.toISOString(),
    input.platforms,
  ]);
  if ((result.rowCount ?? result.rows.length) === 0 || result.rows.length === 0) {
    // Tenant guard: WHERE clause prevented update; surface typed error so
    // the route returns 404 rather than leaking the cross-tenant attempt.
    throw new ScheduledPostTenantMismatchError(input.tenantId, input.postId);
  }
  const row = result.rows[0];
  return {
    id: String(row.id),
    postId: String(row.post_id),
    tenantId: Number(row.tenant_id),
    scheduledFor: normalizeTimestamp(row.scheduled_for),
    platforms: Array.isArray(row.target_platforms) ? row.target_platforms : [],
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

export class ScheduledPostTenantMismatchError extends Error {
  readonly tenantId: number;
  readonly postId: number;
  constructor(tenantId: number, postId: number) {
    super(`Scheduled post tenant mismatch for post_id=${postId}`);
    this.name = 'ScheduledPostTenantMismatchError';
    this.tenantId = tenantId;
    this.postId = postId;
  }
}

export const ALLOWED_TARGET_PLATFORMS = ['facebook', 'instagram'] as const;
export type AllowedTargetPlatform = (typeof ALLOWED_TARGET_PLATFORMS)[number];

export function normalizeTargetPlatforms(value: unknown): AllowedTargetPlatform[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const allowed = new Set<AllowedTargetPlatform>(ALLOWED_TARGET_PLATFORMS);
  const seen = new Set<AllowedTargetPlatform>();
  const result: AllowedTargetPlatform[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const normalized = entry.trim().toLowerCase();
    if (!allowed.has(normalized as AllowedTargetPlatform)) {
      return null;
    }
    const platform = normalized as AllowedTargetPlatform;
    if (!seen.has(platform)) {
      seen.add(platform);
      result.push(platform);
    }
  }
  return result;
}

export function parseScheduledForIso(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = new Date(trimmed);
  if (Number.isNaN(candidate.getTime())) {
    return null;
  }
  return candidate;
}
