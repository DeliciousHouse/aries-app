export const ORGANIZATION_KINDS = ['production', 'test', 'archived'] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export type TenantKindDb = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export type OrganizationKindRow = {
  id: number;
  name: string;
  slug: string | null;
  kind: OrganizationKind;
};

function isOrganizationKind(value: string): value is OrganizationKind {
  return ORGANIZATION_KINDS.includes(value as OrganizationKind);
}

function mapRow(row: Record<string, unknown>): OrganizationKindRow {
  const kind = String(row.kind);
  if (!isOrganizationKind(kind)) throw new Error(`invalid organization kind in database: ${kind}`);
  return {
    id: Number(row.id),
    name: String(row.name),
    slug: row.slug == null ? null : String(row.slug),
    kind,
  };
}

export async function listOrganizationKinds(db: TenantKindDb): Promise<OrganizationKindRow[]> {
  const result = await db.query('SELECT id, name, slug, kind FROM organizations ORDER BY id');
  return result.rows.map(mapRow);
}

export async function setOrganizationKind(
  db: TenantKindDb,
  organizationId: number,
  kind: OrganizationKind,
): Promise<OrganizationKindRow | null> {
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error('organization id must be a positive integer');
  }
  if (!isOrganizationKind(kind)) throw new Error(`invalid organization kind: ${String(kind)}`);

  const result = await db.query(
    `UPDATE organizations
        SET kind = $2
      WHERE id = $1
      RETURNING id, name, slug, kind`,
    [organizationId, kind],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export function resolveFleetTenantKinds(
  env: Partial<Record<string, string | undefined>> = process.env,
): OrganizationKind[] {
  const raw = env.ARIES_FLEET_TENANT_KINDS?.trim();
  if (!raw) return ['production'];

  const kinds = [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (kinds.length === 0) return ['production'];
  const invalid = kinds.find((kind) => !isOrganizationKind(kind));
  if (invalid) throw new Error(`invalid ARIES_FLEET_TENANT_KINDS value: ${invalid}`);
  return kinds as OrganizationKind[];
}
