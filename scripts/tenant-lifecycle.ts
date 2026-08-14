import path from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import pool from '@/lib/db';
import {
  loadTenantDispositionDigest,
  ORGANIZATION_KINDS,
  setOrganizationKind,
  type OrganizationKind,
} from '@/backend/tenant/lifecycle-hygiene';

function usage(): never {
  throw new Error(
    'Usage: npm run tenant:lifecycle -- report | kind <organization-id> <production|test|archived>',
  );
}

export async function main(args = argv.slice(2)): Promise<void> {
  const [command = 'report', idRaw, kindRaw] = args;
  if (command === 'report') {
    console.log(JSON.stringify(await loadTenantDispositionDigest(pool), null, 2));
    return;
  }
  if (command !== 'kind' || !idRaw || !kindRaw) usage();

  const id = Number(idRaw);
  const kind = kindRaw as OrganizationKind;
  if (!Number.isInteger(id) || id <= 0 || !ORGANIZATION_KINDS.includes(kind)) usage();

  const updated = await setOrganizationKind(pool, id, kind);
  if (!updated) throw new Error(`Organization ${id} was not found`);
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
