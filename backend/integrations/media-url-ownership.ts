import { Pool } from 'pg';

function assert(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export async function assertMediaUrlsBelongToTenant(
  tenantId: string | number,
  urls: string[],
  db: Pool
): Promise<void> {
  if (!urls || urls.length === 0) {
    return;
  }

  const client = await db.connect();
  try {
    const tenantIdNum = typeof tenantId === 'string' ? Number.parseInt(tenantId, 10) : tenantId;
    for (const url of urls) {
      const result = await client.query(
        'SELECT id FROM creative_assets WHERE tenant_id = $1 AND storage_key = $2',
        [tenantIdNum, url]
      );

      assert(
        result.rows.length > 0,
        `media_url_tenant_mismatch:${url}`
      );
    }
  } finally {
    client.release();
  }
}
