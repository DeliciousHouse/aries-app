/**
 * The local durable mirror — the fix for the 24h Hermes cache eviction.
 *
 * THE ONE PROPERTY THAT MATTERS: the path this writes to must be byte-identical
 * to the path the public proxy computes for its second read root. If those two
 * ever drift, the mirror silently stores bytes nobody can serve and the failure
 * looks exactly like the incident it was written to prevent — a 404 to Meta at
 * publish time, days after anyone was watching.
 *
 * So the first test does not trust a shared helper: it recomputes the proxy's
 * lookup the way the ROUTE does (resolve(root, tenant, basename.slice(0,2),
 * basename), see app/api/public/media/[token]/[basename]/route.ts) and asserts
 * the mirror landed exactly there.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mirrorRuntimeAssetForDurability } from '../backend/marketing/ingest-production-assets';

async function withDataRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previous = process.env.DATA_ROOT;
  const root = await mkdtemp(path.join(tmpdir(), 'aries-durable-mirror-'));
  process.env.DATA_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/** Exactly what app/api/public/media/[token]/[basename]/route.ts computes. */
function proxyLookupPath(dataRoot: string, tenantId: number, basename: string): string {
  const ingestedRoot = path.normalize(path.join(dataRoot, 'ingested-assets'));
  return path.resolve(ingestedRoot, String(tenantId), basename.slice(0, 2), basename);
}

test('the mirror writes exactly where the public proxy looks', async () => {
  await withDataRoot(async (root) => {
    const basename = 'openai_codex_gpt-image-2-low_20260810_141122_2824f893.png';
    const bytes = Buffer.from('PNGBYTES');

    const ok = await mirrorRuntimeAssetForDurability(15, `/hermes-media/${basename}`, bytes);
    assert.equal(ok, true);

    const expected = proxyLookupPath(root, 15, basename);
    const found = await readFile(expected);
    assert.deepEqual(found, bytes, 'the proxy must find these exact bytes at its own lookup path');
    // The shard is the basename's first two chars, NOT a sha — the proxy has no
    // way to know a checksum, it only has the basename from the signed token.
    assert.equal(path.basename(path.dirname(expected)), 'op');
  });
});

test('a post generated 12 days before its slot still resolves after the cache is evicted', async () => {
  // The incident in one test: Hermes evicts at 24h, the post publishes days
  // later, and the mirror is the only surviving copy.
  await withDataRoot(async (root) => {
    const basename = 'openai_codex_gpt-image-2-low_20260810_140936_8d378019.png';
    const bytes = Buffer.from('THE ONLY SURVIVING COPY');
    await mirrorRuntimeAssetForDurability(15, `/hermes-media/${basename}`, bytes);

    // Hermes' cache is gone; nothing recreated it. The proxy's second root still
    // has the bytes.
    const served = await readFile(proxyLookupPath(root, 15, basename));
    assert.equal(served.toString(), 'THE ONLY SURVIVING COPY');
  });
});

test('mirrors are tenant-scoped, so one tenant cannot shadow another', async () => {
  await withDataRoot(async (root) => {
    const basename = 'shared_name.png';
    await mirrorRuntimeAssetForDurability(15, `/hermes-media/${basename}`, Buffer.from('T15'));
    await mirrorRuntimeAssetForDurability(70, `/hermes-media/${basename}`, Buffer.from('T70'));

    assert.equal((await readFile(proxyLookupPath(root, 15, basename))).toString(), 'T15');
    assert.equal((await readFile(proxyLookupPath(root, 70, basename))).toString(), 'T70');
  });
});

test('a re-ingest overwrites in place rather than accumulating copies', async () => {
  await withDataRoot(async (root) => {
    const basename = 'replayed.png';
    await mirrorRuntimeAssetForDurability(15, `/hermes-media/${basename}`, Buffer.from('first'));
    await mirrorRuntimeAssetForDurability(15, `/hermes-media/${basename}`, Buffer.from('second-longer'));

    const target = proxyLookupPath(root, 15, basename);
    assert.equal((await readFile(target)).toString(), 'second-longer');
    const info = await stat(target);
    assert.equal(info.size, 'second-longer'.length, 'a shorter first write must not leave a tail');
  });
});

test('keys that are not a real media filename write nothing, anywhere', async () => {
  await withDataRoot(async (root) => {
    // basename() defuses traversal on its own — '/hermes-media/../../etc/passwd'
    // reduces to 'passwd', which can only ever land under the tenant dir. The
    // extension requirement then rejects it outright, along with a key that
    // reduces to a DIRECTORY name ('/hermes-media/' -> 'hermes-media'), which
    // would otherwise store an unservable extensionless file.
    for (const key of ['/hermes-media/../../etc/passwd', '/hermes-media/', '..', '']) {
      assert.equal(
        await mirrorRuntimeAssetForDurability(15, key, Buffer.from('x')),
        false,
        `key ${JSON.stringify(key)}`,
      );
    }

    // Nothing escaped, and nothing junk was left behind inside the root either.
    await assert.rejects(
      () => stat(path.resolve(root, '..', 'etc', 'passwd')),
      'nothing may be written outside the data root',
    );
    await assert.rejects(() => stat(proxyLookupPath(root, 15, 'passwd')));
    await assert.rejects(() => stat(proxyLookupPath(root, 15, 'hermes-media')));
  });
});

test('a legitimate Hermes basename is never turned away by the extension check', async () => {
  await withDataRoot(async (root) => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'clip.mp4']) {
      assert.equal(
        await mirrorRuntimeAssetForDurability(15, `/hermes-media/${name}`, Buffer.from('x')),
        true,
        `name ${name}`,
      );
      await stat(proxyLookupPath(root, 15, name));
    }
  });
});

test('mirroring FAILS OPEN when the data root is unwritable', async () => {
  const previous = process.env.DATA_ROOT;
  // A path that cannot be created: a regular file standing in for a directory.
  const root = await mkdtemp(path.join(tmpdir(), 'aries-durable-mirror-ro-'));
  const asFile = path.join(root, 'not-a-dir');
  await (await import('node:fs/promises')).writeFile(asFile, 'x');
  process.env.DATA_ROOT = asFile;
  try {
    await assert.doesNotReject(() =>
      mirrorRuntimeAssetForDurability(15, '/hermes-media/a.png', Buffer.from('x')),
    );
    assert.equal(
      await mirrorRuntimeAssetForDurability(15, '/hermes-media/a.png', Buffer.from('x')),
      false,
      'ingestion has already succeeded; a mirror failure must never fail the job',
    );
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
