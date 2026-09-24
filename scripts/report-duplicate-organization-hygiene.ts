import { loadDuplicateOrganizationHygieneDigest } from '@/backend/tenant/duplicate-organization-hygiene';
import pool from '@/lib/db';

loadDuplicateOrganizationHygieneDigest(pool)
  .then((digest) => console.log(JSON.stringify(digest, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
