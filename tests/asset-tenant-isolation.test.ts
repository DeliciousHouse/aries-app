import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withScratch<T>(
  run: (ctx: { dataRoot: string; hostOut: string; hostMount: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'aries-tenant-iso-'));
  const dataRoot = path.join(root, 'data');
  const hostOut = path.join(root, 'lobster-output');
  const hostMount = hostOut;
  await mkdir(dataRoot, { recursive: true });
  await mkdir(hostOut, { recursive: true });
  try {
    return await run({ dataRoot, hostOut, hostMount });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadIngest() {
  return import('../backend/marketing/asset-ingest');
}

async function loadRead() {
  return import('../backend/marketing/asset-read');
}

test('tenant isolation: two tenants ingesting identical bytes land in distinct paths', async () => {
  await withScratch(async ({ dataRoot, hostOut, hostMount }) => {
    const src = path.join(hostOut, 'shared.png');
    const body = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(src, body);
    const declared = path.join('/home/node/aries-app/lobster/output', 'shared.png');

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadIngest();

        const docA = { tenant_id: 'tenant-a', p: declared } as Record<string, unknown>;
        const docB = { tenant_id: 'tenant-b', p: declared } as Record<string, unknown>;

        const resultA = ingestRuntimeDocAssets(docA);
        const resultB = ingestRuntimeDocAssets(docB);

        assert.equal(resultA.rewrites.length, 1, 'tenant A should rewrite once');
        assert.equal(resultB.rewrites.length, 1, 'tenant B should rewrite once');

        const pathA = docA.p as string;
        const pathB = docB.p as string;

        assert.notEqual(pathA, pathB, 'identical bytes must NOT share storage path across tenants');

        const sha = crypto.createHash('sha256').update(body).digest('hex');
        assert.ok(pathA.includes(sha), `tenant A path should embed sha ${sha}; got ${pathA}`);
        assert.ok(pathB.includes(sha), `tenant B path should embed sha ${sha}; got ${pathB}`);

        const expectedPrefixA = path.join(dataRoot, 'ingested-assets', 'tenant-a') + path.sep;
        const expectedPrefixB = path.join(dataRoot, 'ingested-assets', 'tenant-b') + path.sep;
        assert.ok(
          pathA.startsWith(expectedPrefixA),
          `tenant A path must be tenant-prefixed; expected prefix ${expectedPrefixA}, got ${pathA}`,
        );
        assert.ok(
          pathB.startsWith(expectedPrefixB),
          `tenant B path must be tenant-prefixed; expected prefix ${expectedPrefixB}, got ${pathB}`,
        );

        const bytesA = await readFile(pathA);
        const bytesB = await readFile(pathB);
        assert.ok(bytesA.equals(body), 'tenant A bytes preserved');
        assert.ok(bytesB.equals(body), 'tenant B bytes preserved');

        const docA2 = { tenant_id: 'tenant-a', p: declared } as Record<string, unknown>;
        const resultA2 = ingestRuntimeDocAssets(docA2);
        assert.equal(
          resultA2.rewrites.length,
          1,
          'second ingest still records the rewrite for visibility',
        );
        assert.equal(
          docA2.p,
          pathA,
          'within-tenant dedup: same tenant + same bytes must reuse the existing storage path',
        );
      },
    );
  });
});

test('tenant isolation: cross-tenant read of another tenant path is denied', async () => {
  await withScratch(async ({ dataRoot }) => {
    const codeRoot = path.join(dataRoot, '..', 'code');
    await mkdir(codeRoot, { recursive: true });

    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tenantAFile = path.join(
      dataRoot,
      'ingested-assets',
      'tenant-a',
      sha.slice(0, 2),
      `${sha}.png`,
    );
    await mkdir(path.dirname(tenantAFile), { recursive: true });
    const bytes = Buffer.from('A-only-payload');
    await writeFile(tenantAFile, bytes);

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        CODE_ROOT: codeRoot,
      },
      async () => {
        const { readMarketingAssetWithinAllowedRoots } = await loadRead();

        const okBytes = await readMarketingAssetWithinAllowedRoots(tenantAFile, {
          tenantId: 'tenant-a',
        });
        assert.ok(okBytes, 'tenant A must be able to read its own asset');
        assert.ok(okBytes!.equals(bytes), 'tenant A read returns exact bytes');

        const deniedBytes = await readMarketingAssetWithinAllowedRoots(tenantAFile, {
          tenantId: 'tenant-b',
        });
        assert.equal(
          deniedBytes,
          null,
          'cross-tenant read of tenant A path with tenant B context MUST return null',
        );

        const blankBytes = await readMarketingAssetWithinAllowedRoots(tenantAFile, {
          tenantId: '',
        });
        assert.equal(
          blankBytes,
          null,
          'empty tenantId must deny reads of tenant-prefixed paths',
        );
      },
    );
  });
});

test('migration: tenant-prefix migration is idempotent on re-run', async () => {
  await withScratch(async ({ dataRoot }) => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const ext = '.png';
    const legacyAbs = path.join(dataRoot, 'ingested-assets', sha.slice(0, 2), `${sha}${ext}`);
    await mkdir(path.dirname(legacyAbs), { recursive: true });
    const bytes = Buffer.from('legacy-bytes');
    await writeFile(legacyAbs, bytes);

    const tenantId = 42;
    const expectedNewAbs = path.join(
      dataRoot,
      'ingested-assets',
      String(tenantId),
      sha.slice(0, 2),
      `${sha}${ext}`,
    );

    type Row = { id: string; tenant_id: number; storage_key: string };
    const rows: Row[] = [
      { id: 'asset-1', tenant_id: tenantId, storage_key: legacyAbs },
    ];

    const stubDb = {
      query: async (sql: string, params: unknown[] = []) => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT')) {
          const pending = rows.filter((row) => {
            const idx = row.storage_key.indexOf(`${path.sep}ingested-assets${path.sep}`);
            if (idx === -1) return false;
            const tail = row.storage_key.slice(idx + `${path.sep}ingested-assets${path.sep}`.length);
            const segs = tail.split(path.sep);
            return segs.length === 2;
          });
          return { rows: pending, rowCount: pending.length };
        }
        if (trimmed.startsWith('UPDATE')) {
          const [newKey, id] = params as [string, string];
          const target = rows.find((row) => row.id === id);
          if (target) {
            target.storage_key = newKey;
          }
          return { rows: [], rowCount: target ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await withEnv({ DATA_ROOT: dataRoot }, async () => {
      const { runAssetTenantPrefixMigration } = await import('../scripts/migrate-asset-tenant-prefix');

      const first = await runAssetTenantPrefixMigration({
        dryRun: false,
        db: stubDb,
        dataRoot,
      });

      assert.equal(first.scanned, 1, 'first run scans one legacy row');
      assert.equal(first.moved, 1, 'first run moves one file');
      assert.equal(first.updated, 1, 'first run updates one DB row');
      assert.equal(first.skipped, 0, 'first run skips none');

      const movedBytes = await readFile(expectedNewAbs);
      assert.ok(movedBytes.equals(bytes), 'bytes preserved at new tenant-prefixed path');

      let legacyExists = true;
      try {
        await stat(legacyAbs);
      } catch {
        legacyExists = false;
      }
      assert.equal(legacyExists, false, 'legacy path removed after move');

      assert.equal(rows[0]!.storage_key, expectedNewAbs, 'DB row points at new path');

      const second = await runAssetTenantPrefixMigration({
        dryRun: false,
        db: stubDb,
        dataRoot,
      });
      assert.equal(second.scanned, 0, 'second run finds no legacy rows');
      assert.equal(second.moved, 0, 'second run moves no files');
      assert.equal(second.updated, 0, 'second run updates no rows');
    });
  });
});
