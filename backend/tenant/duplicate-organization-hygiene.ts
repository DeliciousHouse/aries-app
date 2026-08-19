export interface DuplicateOrganizationHygieneDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface OrganizationHygieneSnapshot {
  id: number;
  name: string;
  slug: string | null;
  createdAt: string;
  activeMemberCount: number;
  connectionCount: number;
  publishedPostCount: number;
  lastActivityAt: string | null;
}

export interface OrganizationMergeCandidate {
  canonicalName: string;
  organizations: OrganizationHygieneSnapshot[];
  recommendedDisposition: {
    action: 'merge_then_archive';
    keepOrganizationId: number;
    reviewOrganizationIds: number[];
  };
  evidence: string[];
  reasoning: string;
}

export interface OrganizationArchiveCandidate {
  organization: OrganizationHygieneSnapshot;
  recommendedDisposition: 'archive';
  evidence: string[];
  reasoning: string;
}

export interface DuplicateOrganizationHygieneDigest {
  type: 'duplicate_organization_hygiene_proposal';
  title: 'Duplicate organization hygiene proposal';
  proposalOnly: true;
  requiresOwnerSignOff: true;
  generatedAt: string;
  mergeCandidates: OrganizationMergeCandidate[];
  archiveCandidates: OrganizationArchiveCandidate[];
}

export const DUPLICATE_ORGANIZATION_HYGIENE_READ_SQL = `
SELECT o.id,
       o.name,
       o.slug,
       o.created_at,
       COALESCE(m.active_member_count, 0)::int AS active_member_count,
       COALESCE(c.connection_count, 0)::int AS connection_count,
       COALESCE(p.published_post_count, 0)::int AS published_post_count,
       GREATEST(o.created_at, c.last_activity_at, p.last_activity_at) AS last_activity_at
  FROM organizations o
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS active_member_count
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

interface FamilyMatch {
  key: string;
  canonicalName: string;
  evidence: string;
}

function normalizedWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function familyMatch(name: string): FamilyMatch | null {
  const words = normalizedWords(name);
  const wordSet = new Set(words);
  if (wordSet.has('sugar') && wordSet.has('leather')) {
    return {
      key: 'sugar-and-leather',
      canonicalName: 'Sugar and Leather',
      evidence: 'name contains the Sugar and Leather family signature',
    };
  }
  if (wordSet.has('aries') && wordSet.has('ai')) {
    return {
      key: 'aries-ai',
      canonicalName: 'Aries AI',
      evidence: 'name contains the Aries AI family signature',
    };
  }

  const compact = words.join('');
  return compact
    ? {
        key: `normalized:${compact}`,
        canonicalName: name.trim(),
        evidence: `name normalizes to ${compact}`,
      }
    : null;
}

function testAccountEvidence(name: string): string | null {
  const words = normalizedWords(name);
  const compact = words.join('');
  if (compact.includes('xsocialmediatest')) {
    return 'name matches the known X SocialMedia test-account signature';
  }
  if (compact.includes('fbleadtestpage')) {
    return 'name matches the known FB Lead Test Page test-account signature';
  }
  const marker = words.find((word) => ['test', 'sandbox', 'demo', 'canary'].includes(word));
  return marker ? `name contains the explicit test-account marker "${marker}"` : null;
}

function activityScore(row: OrganizationHygieneSnapshot): number {
  return (
    row.activeMemberCount * 1_000_000 +
    row.connectionCount * 10_000 +
    row.publishedPostCount
  );
}

function activityEvidence(row: OrganizationHygieneSnapshot): string {
  return (
    `organization ${row.id} has ${row.activeMemberCount} active member(s), ` +
    `${row.connectionCount} connection(s), and ${row.publishedPostCount} published post(s)`
  );
}

/** Generates a proposal item only; callers receive no organization mutation capability. */
export function buildDuplicateOrganizationHygieneDigest(
  organizations: OrganizationHygieneSnapshot[],
  generatedAt = new Date().toISOString(),
): DuplicateOrganizationHygieneDigest {
  const groups = new Map<string, { match: FamilyMatch; rows: OrganizationHygieneSnapshot[] }>();
  const archiveCandidates: OrganizationArchiveCandidate[] = [];

  for (const organization of organizations) {
    const testEvidence = testAccountEvidence(organization.name);
    if (testEvidence) {
      archiveCandidates.push({
        organization,
        recommendedDisposition: 'archive',
        evidence: [testEvidence, activityEvidence(organization)],
        reasoning: 'This appears to be a test account; confirm it owns no production data before archiving.',
      });
    }

    const match = familyMatch(organization.name);
    if (!match) continue;
    const group = groups.get(match.key) ?? { match, rows: [] };
    group.rows.push(organization);
    groups.set(match.key, group);
  }

  const mergeCandidates = [...groups.values()]
    .filter(({ rows }) => rows.length > 1)
    .map(({ match, rows }) => {
      const organizationsById = [...rows].sort((a, b) => a.id - b.id);
      const ranked = [...rows].sort(
        (a, b) => activityScore(b) - activityScore(a) || a.id - b.id,
      );
      const keeper = ranked[0]!;
      const reviewOrganizationIds = ranked
        .slice(1)
        .map((row) => row.id)
        .sort((a, b) => a - b);
      return {
        canonicalName: match.canonicalName,
        organizations: organizationsById,
        recommendedDisposition: {
          action: 'merge_then_archive' as const,
          keepOrganizationId: keeper.id,
          reviewOrganizationIds,
        },
        evidence: [
          `${rows.length} organizations ${match.evidence}`,
          activityEvidence(keeper),
        ],
        reasoning:
          `Organization ${keeper.id} has the strongest activity signal. ` +
          'Review ownership and production data before approving any merge or archive.',
      };
    })
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  return {
    type: 'duplicate_organization_hygiene_proposal',
    title: 'Duplicate organization hygiene proposal',
    proposalOnly: true,
    requiresOwnerSignOff: true,
    generatedAt,
    mergeCandidates,
    archiveCandidates: archiveCandidates.sort((a, b) => a.organization.id - b.organization.id),
  };
}

function toIsoString(value: unknown): string {
  return new Date(String(value)).toISOString();
}

export async function loadDuplicateOrganizationHygieneDigest(
  db: DuplicateOrganizationHygieneDb,
  generatedAt = new Date().toISOString(),
): Promise<DuplicateOrganizationHygieneDigest> {
  const result = await db.query(DUPLICATE_ORGANIZATION_HYGIENE_READ_SQL);
  return buildDuplicateOrganizationHygieneDigest(
    result.rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      slug: row.slug == null ? null : String(row.slug),
      createdAt: toIsoString(row.created_at),
      activeMemberCount: Number(row.active_member_count),
      connectionCount: Number(row.connection_count),
      publishedPostCount: Number(row.published_post_count),
      lastActivityAt: row.last_activity_at == null ? null : toIsoString(row.last_activity_at),
    })),
    generatedAt,
  );
}
