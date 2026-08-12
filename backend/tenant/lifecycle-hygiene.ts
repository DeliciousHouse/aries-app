export const ORGANIZATION_KINDS = ['production', 'test', 'archived'] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export interface TenantLifecycleDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface OrganizationKindRow extends Record<string, unknown> {
  id: number;
  name: string;
  slug: string | null;
  kind: OrganizationKind;
}

export async function setOrganizationKind(
  db: TenantLifecycleDb,
  organizationId: number,
  kind: OrganizationKind,
): Promise<OrganizationKindRow | null> {
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error('organization id must be a positive integer');
  }
  if (!ORGANIZATION_KINDS.includes(kind)) {
    throw new Error(`invalid organization kind: ${String(kind)}`);
  }

  const result = await db.query(
    `UPDATE organizations
        SET kind = $2
      WHERE id = $1
      RETURNING id, name, slug, kind`,
    [organizationId, kind],
  );
  return (result.rows[0] as OrganizationKindRow | undefined) ?? null;
}

export interface TenantHygieneRow {
  id: number;
  name: string;
  slug: string | null;
  kind: OrganizationKind;
  activeMembers: number;
  connectionCount: number;
  publishedPostCount: number;
  lastActivityAt: string | null;
}

export const TENANT_HYGIENE_READ_SQL = `
  SELECT o.id,
         o.name,
         o.slug,
         o.kind,
         COALESCE(m.active_members, 0)::int AS active_members,
         COALESCE(c.connection_count, 0)::int AS connection_count,
         COALESCE(p.published_post_count, 0)::int AS published_post_count,
         GREATEST(c.last_activity_at, p.last_activity_at, o.created_at) AS last_activity_at
    FROM organizations o
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS active_members
        FROM organization_memberships om
       WHERE om.organization_id = o.id
         AND om.status = 'active'
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS connection_count,
             MAX(updated_at) AS last_activity_at
        FROM connected_accounts ca
       WHERE ca.tenant_id = o.id
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE published_status = 'published')::int AS published_post_count,
             MAX(updated_at) AS last_activity_at
        FROM posts
       WHERE tenant_id = o.id
    ) p ON true
   ORDER BY o.id`;

function duplicateKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

function keeperScore(row: TenantHygieneRow): number {
  return (
    (row.kind === 'production' ? 1_000_000_000 : row.kind === 'test' ? 1_000_000 : 0) +
    row.activeMembers * 10_000 +
    row.connectionCount * 1_000 +
    row.publishedPostCount
  );
}

export interface TenantDispositionCandidate {
  duplicateKey: string;
  names: string[];
  keepTenantId: number;
  reviewTenantIds: number[];
  proposal: string;
}

export interface TenantDispositionDigest {
  title: 'Tenant lifecycle hygiene proposal';
  requiresOwnerApproval: true;
  generatedAt: string;
  candidates: TenantDispositionCandidate[];
}

/** Build a read-only owner digest. This function never writes organization data. */
export function buildTenantDispositionDigest(
  rows: TenantHygieneRow[],
  generatedAt = new Date().toISOString(),
): TenantDispositionDigest {
  const groups = new Map<string, TenantHygieneRow[]>();
  for (const row of rows) {
    const key = duplicateKey(row.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const candidates = [...groups.entries()]
    .filter(([, matches]) => matches.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, matches]) => {
      const ranked = [...matches].sort((a, b) => keeperScore(b) - keeperScore(a) || a.id - b.id);
      const keeper = ranked[0]!;
      const reviewTenantIds = ranked.slice(1).map((row) => row.id).sort((a, b) => a - b);
      return {
        duplicateKey: key,
        names: [...new Set(matches.map((row) => row.name))].sort(),
        keepTenantId: keeper.id,
        reviewTenantIds,
        proposal:
          `Keep tenant ${keeper.id}; review tenants ${reviewTenantIds.join(', ')} for merge, ` +
          'then archive only after owner approval.',
      };
    });

  return {
    title: 'Tenant lifecycle hygiene proposal',
    requiresOwnerApproval: true,
    generatedAt,
    candidates,
  };
}

export async function loadTenantDispositionDigest(
  db: TenantLifecycleDb,
  generatedAt = new Date().toISOString(),
): Promise<TenantDispositionDigest> {
  const result = await db.query(TENANT_HYGIENE_READ_SQL);
  return buildTenantDispositionDigest(
    result.rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      slug: row.slug == null ? null : String(row.slug),
      kind: row.kind as OrganizationKind,
      activeMembers: Number(row.active_members),
      connectionCount: Number(row.connection_count),
      publishedPostCount: Number(row.published_post_count),
      lastActivityAt: row.last_activity_at == null ? null : new Date(String(row.last_activity_at)).toISOString(),
    })),
    generatedAt,
  );
}
