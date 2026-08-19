import path from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import pool from '@/lib/db';
import {
  listOrganizationKinds,
  ORGANIZATION_KINDS,
  setOrganizationKind,
  type OrganizationKind,
} from '@/backend/tenant/organization-kind';

function usage(): never {
  throw new Error(
    'Usage: npm run tenant:kind -- list | set <organization-id> <production|test|archived>',
  );
}

export async function main(args = argv.slice(2)): Promise<void> {
  const [command = 'list', idRaw, kindRaw] = args;
  if (command === 'list') {
    console.log(JSON.stringify(await listOrganizationKinds(pool), null, 2));
    return;
  }
  if (command !== 'set' || !idRaw || !kindRaw) usage();

  const organizationId = Number(idRaw);
  const kind = kindRaw as OrganizationKind;
  if (!Number.isInteger(organizationId) || !ORGANIZATION_KINDS.includes(kind)) usage();

  const updated = await setOrganizationKind(pool, organizationId, kind);
  if (!updated) throw new Error(`Organization ${organizationId} was not found`);
  console.log(JSON.stringify(updated, null, 2));
}

const isDirectRun =
  argv[1] !== undefined && pathToFileURL(path.resolve(argv[1])).href === import.meta.url;
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
