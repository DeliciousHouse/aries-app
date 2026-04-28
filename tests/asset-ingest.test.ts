import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function withScratch<T>(run: (ctx: { dataRoot: string; hostOut: string; hostMount: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'aries-ingest-'));
  const dataRoot = path.join(root, 'data');
  const hostOut = path.join(root, 'lobster-output');
  // hostMount in tests is the same dir as hostOut (no actual mount); ingest
  // remaps host-output-dir → host-output-mount and reads from there.
  const hostMount = hostOut;
  await mkdir(dataRoot, { recursive: true });
  await mkdir(hostOut, { recursive: true });
  try {
    return await run({ dataRoot, hostOut, hostMount });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadModule() {
  return import('../backend/marketing/asset-ingest');
}

test('ingestRuntimeDocAssets copies out-of-DATA_ROOT file and rewrites path', async () => {
  await withScratch(async ({ dataRoot, hostOut, hostMount }) => {
    const src = path.join(hostOut, '27-campaign', 'landing-pages', 'index.html');
    await mkdir(path.dirname(src), { recursive: true });
    const body = Buffer.from('<html>charlene</html>');
    await writeFile(src, body);
    const declaredHostPath = path.join('/home/node/aries-app/lobster/output', '27-campaign', 'landing-pages', 'index.html');

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadModule();
        const doc = {
          job_id: 'mkt_test',
          stages: {
            production: {
              artifacts: { landing_page_path: declaredHostPath },
            },
          },
        } as Record<string, unknown>;

        const result = ingestRuntimeDocAssets(doc);
        assert.equal(result.rewrites.length, 1);
        const rewrite = result.rewrites[0]!;
        const rewritten = ((doc.stages as any).production.artifacts.landing_page_path as string);
        assert.equal(rewritten, rewrite.to);
        assert.ok(rewritten.startsWith(path.join(dataRoot, 'ingested-assets')));
        const copied = await readFile(rewritten);
        assert.ok(copied.equals(body));

        const sha = crypto.createHash('sha256').update(body).digest('hex');
        assert.ok(rewritten.includes(sha), `destination should embed sha256 ${sha}, got ${rewritten}`);
      },
    );
  });
});

test('ingestRuntimeDocAssets leaves paths already within DATA_ROOT unchanged', async () => {
  await withScratch(async ({ dataRoot }) => {
    const existing = path.join(dataRoot, 'already', 'here.txt');
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, 'x');

    await withEnv({ DATA_ROOT: dataRoot }, async () => {
      const { ingestRuntimeDocAssets } = await loadModule();
      const doc = { x: existing } as Record<string, unknown>;
      const result = ingestRuntimeDocAssets(doc);
      assert.equal(result.rewrites.length, 0);
      assert.equal(doc.x, existing);
    });
  });
});

test('ingestRuntimeDocAssets is idempotent — re-ingesting a normalized doc is a no-op', async () => {
  await withScratch(async ({ dataRoot, hostOut, hostMount }) => {
    const src = path.join(hostOut, 'img.png');
    await writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const declared = path.join('/home/node/aries-app/lobster/output', 'img.png');

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadModule();
        const doc = { p: declared } as Record<string, unknown>;

        const first = ingestRuntimeDocAssets(doc);
        assert.equal(first.rewrites.length, 1);
        const normalized = doc.p as string;

        const second = ingestRuntimeDocAssets(doc);
        assert.equal(second.rewrites.length, 0, 'second pass should rewrite nothing');
        assert.equal(doc.p, normalized, 'path should be stable across passes');
      },
    );
  });
});

test('ingestRuntimeDocAssets leaves unreadable paths untouched (no new failure mode)', async () => {
  await withScratch(async ({ dataRoot, hostMount }) => {
    const declared = '/home/node/aries-app/lobster/output/does-not-exist.html';

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadModule();
        const doc = { p: declared } as Record<string, unknown>;
        const result = ingestRuntimeDocAssets(doc);
        assert.equal(result.rewrites.length, 0);
        assert.equal(doc.p, declared, 'unreadable source leaves original path');
        assert.ok(
          result.skipped.some((s) => s.path === declared && s.reason === 'unreadable'),
          'should record the skip with reason=unreadable',
        );
      },
    );
  });
});

test('ingestRuntimeDocAssets walks nested arrays and objects', async () => {
  await withScratch(async ({ dataRoot, hostOut, hostMount }) => {
    const a = path.join(hostOut, 'a.txt');
    const b = path.join(hostOut, 'nested', 'b.md');
    await mkdir(path.dirname(b), { recursive: true });
    await writeFile(a, 'AAA');
    await writeFile(b, '# BBB');

    const declaredA = path.join('/home/node/aries-app/lobster/output', 'a.txt');
    const declaredB = path.join('/home/node/aries-app/lobster/output', 'nested', 'b.md');

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadModule();
        const doc = {
          items: [
            { path: declaredA },
            { deeper: { path: declaredB } },
          ],
        } as Record<string, unknown>;
        const result = ingestRuntimeDocAssets(doc);
        assert.equal(result.rewrites.length, 2);
        const items = doc.items as Array<Record<string, unknown>>;
        assert.ok((items[0]!.path as string).startsWith(path.join(dataRoot, 'ingested-assets')));
        assert.ok(((items[1]!.deeper as Record<string, unknown>).path as string).startsWith(path.join(dataRoot, 'ingested-assets')));
      },
    );
  });
});

test('ingestRuntimeDocAssets content-addresses so duplicate source copies once', async () => {
  await withScratch(async ({ dataRoot, hostOut, hostMount }) => {
    const src = path.join(hostOut, 'shared.json');
    await writeFile(src, '{"hello":"world"}');
    const declared = path.join('/home/node/aries-app/lobster/output', 'shared.json');

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadModule();
        const doc = { a: declared, b: declared, c: declared } as Record<string, unknown>;
        const result = ingestRuntimeDocAssets(doc);
        // One unique source → one rewrite recorded; other two served from cache.
        assert.equal(result.rewrites.length, 1);
        assert.equal(doc.a, result.rewrites[0]!.to);
        assert.equal(doc.a, doc.b);
        assert.equal(doc.b, doc.c);
      },
    );
  });
});

test('ingestRuntimeDocAssets ignores strings that are not absolute file paths', async () => {
  await withScratch(async ({ dataRoot }) => {
    await withEnv({ DATA_ROOT: dataRoot }, async () => {
      const { ingestRuntimeDocAssets } = await loadModule();
      const doc = {
        slug: 'platform-preview-landing-page-meta-outcome-proof',
        url: 'https://example.com/x.png',
        route: '/api/marketing/jobs/foo',
        bare_dir: '/var/run',
        relative: 'lobster/output/thing.md',
      } as Record<string, unknown>;
      const result = ingestRuntimeDocAssets(doc);
      assert.equal(result.rewrites.length, 0);
    });
  });
});

test('ingestRuntimeDocAssets output is readable by readMarketingAssetWithinAllowedRoots', async () => {
  await withScratch(async ({ dataRoot, hostOut, hostMount }) => {
    const src = path.join(hostOut, 'serve-me.html');
    const body = Buffer.from('<html>ok</html>');
    await writeFile(src, body);
    const declared = path.join('/home/node/aries-app/lobster/output', 'serve-me.html');

    await withEnv(
      {
        DATA_ROOT: dataRoot,
        ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
        ARIES_LOBSTER_HOST_OUTPUT_MOUNT: hostMount,
      },
      async () => {
        const { ingestRuntimeDocAssets } = await loadModule();
        const { readMarketingAssetWithinAllowedRoots } = await import('../backend/marketing/asset-read');
        const doc = { landing_page_path: declared } as Record<string, unknown>;
        ingestRuntimeDocAssets(doc);
        const served = await readMarketingAssetWithinAllowedRoots(doc.landing_page_path as string);
        assert.ok(served, 'reader should return bytes for DATA_ROOT-scoped path');
        assert.ok(served!.equals(body));
      },
    );
  });
});
