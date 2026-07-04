/**
 * Audit (and optionally repair) auto-provisioned personal-org display names
 * before the multi-workspace switcher ships (multi-workspace plan design review
 * "Backfill naming audit" + P3 data-hygiene task).
 *
 * Auto-provisioning (`ensureOrganizationForUser` → `trimOrganizationName`) mints
 * an org whose NAME is the signer-in's Google display name or their email
 * (e.g. "Steven Wong", "eatright@gmail.com"). Under the single-pointer model no
 * one ever saw that name; once the switcher renders a list of workspaces those
 * machine-minted names become user-visible and confusing. This tool flags orgs
 * whose display name still matches the sole member's identity so they can be
 * cleaned up before the switcher is exercised in prod.
 *
 * READ-ONLY BY DEFAULT — it prints candidates and writes nothing. Pass `--fix`
 * to rename. DO NOT run --fix against prod without operator sign-off (a rename
 * is user-visible prod state); this ships the tool, it does not run it.
 *
 * A candidate = an org with exactly ONE active membership whose `name`,
 * case-insensitively, equals the member's `full_name` OR their `email` OR the
 * local-part of their email. (Multi-member orgs and orgs with a distinct
 * business name are never candidates — those names were deliberately chosen.)
 *
 * Usage:
 *   # audit (read-only) — every candidate + suggested rename
 *   tsx scripts/tenant/audit-org-display-names.ts
 *
 *   # audit a single org
 *   tsx scripts/tenant/audit-org-display-names.ts --org 58
 *
 *   # RENAME every candidate to the default suggestion ("<member>'s workspace")
 *   tsx scripts/tenant/audit-org-display-names.ts --fix
 *
 *   # rename ONE org to an explicit name
 *   tsx scripts/tenant/audit-org-display-names.ts --org 58 --fix --name "EatRight Kitchen"
 */
import 'dotenv/config';

import pg from 'pg';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function buildPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 2,
  });
}

type Candidate = {
  organizationId: number;
  currentName: string;
  memberEmail: string;
  memberFullName: string | null;
  matchedOn: 'full_name' | 'email' | 'email_local_part';
  suggestedName: string;
};

/** A friendlier default rename: "<display>'s workspace" (never blank). */
function suggestedName(memberFullName: string | null, memberEmail: string): string {
  const display = (memberFullName?.trim() || memberEmail.split('@')[0] || 'Your').trim();
  return `${display}'s workspace`;
}

async function findCandidates(pool: pg.Pool, orgFilter: number | null): Promise<Candidate[]> {
  // Orgs with EXACTLY one active membership + that member's identity fields.
  const res = await pool.query(
    `
      SELECT o.id AS organization_id, o.name AS org_name,
             u.email AS member_email, u.full_name AS member_full_name
        FROM organizations o
        JOIN (
          SELECT organization_id, count(*)::int AS active_members, min(user_id) AS only_user_id
            FROM organization_memberships
           WHERE status = 'active'
           GROUP BY organization_id
          HAVING count(*) = 1
        ) m ON m.organization_id = o.id
        JOIN users u ON u.id = m.only_user_id
       ${orgFilter !== null ? 'WHERE o.id = $1' : ''}
       ORDER BY o.id ASC
    `,
    orgFilter !== null ? [orgFilter] : [],
  );

  const candidates: Candidate[] = [];
  for (const row of res.rows as Array<{
    organization_id: number | string;
    org_name: string | null;
    member_email: string;
    member_full_name: string | null;
  }>) {
    const name = (row.org_name ?? '').trim();
    if (!name) continue;
    const lowerName = name.toLowerCase();
    const email = row.member_email;
    const fullName = row.member_full_name;
    const emailLocal = email.split('@')[0] ?? '';

    let matchedOn: Candidate['matchedOn'] | null = null;
    if (fullName && lowerName === fullName.trim().toLowerCase()) {
      matchedOn = 'full_name';
    } else if (lowerName === email.trim().toLowerCase()) {
      matchedOn = 'email';
    } else if (emailLocal && lowerName === emailLocal.toLowerCase()) {
      matchedOn = 'email_local_part';
    }
    if (!matchedOn) continue;

    candidates.push({
      organizationId: Number(row.organization_id),
      currentName: name,
      memberEmail: email,
      memberFullName: fullName,
      matchedOn,
      suggestedName: suggestedName(fullName, email),
    });
  }
  return candidates;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const orgFilter =
    typeof args.org === 'string' && Number.isFinite(Number(args.org)) ? Number(args.org) : null;
  const fix = args.fix === true || args.fix === 'true';
  const explicitName = typeof args.name === 'string' ? args.name.trim() : null;
  if (explicitName && (!fix || orgFilter === null)) {
    throw new Error('--name requires --fix AND --org <id> (a single explicit rename)');
  }

  const pool = buildPool();
  try {
    const candidates = await findCandidates(pool, orgFilter);
    if (candidates.length === 0) {
      console.log('(no auto-provisioned personal-org display-name candidates found)');
      return;
    }

    console.table(
      candidates.map((c) => ({
        org: c.organizationId,
        current: c.currentName,
        member: c.memberEmail,
        matched_on: c.matchedOn,
        suggested: explicitName ?? c.suggestedName,
      })),
    );

    if (!fix) {
      console.log(`\n${candidates.length} candidate(s). Re-run with --fix to rename (read-only by default).`);
      return;
    }

    for (const c of candidates) {
      const newName = explicitName ?? c.suggestedName;
      await pool.query(`UPDATE organizations SET name = $1 WHERE id = $2`, [newName, c.organizationId]);
      console.log(
        JSON.stringify({
          event: 'audit-org-display-names.rename',
          organization_id: c.organizationId,
          from: c.currentName,
          to: newName,
          at: new Date().toISOString(),
        }),
      );
    }
    console.log(`\nrenamed ${candidates.length} org(s).`);
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((err) => {
  console.error(`[audit-org-display-names] ${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
