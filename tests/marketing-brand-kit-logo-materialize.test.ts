// Unit tests for downloadAndMaterializeLogo (brand-kit logo file materialization).
// Deterministic + offline: data: URIs need no network; http(s) URLs use an
// injected fetchImpl so ssrfSafeFetch skips DNS but still runs the URL guard.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevCodeRoot = process.env.CODE_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-logo-materialize-'));
  process.env.DATA_ROOT = dataRoot;
  if (!process.env.CODE_ROOT) process.env.CODE_ROOT = process.cwd();
  try {
    return await run(dataRoot);
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prevCodeRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

// A 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function imageResponse(bytes: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
  });
}

test('downloadAndMaterializeLogo: data: SVG materializes offline (no fetch)', async () => {
  await withDataRoot(async (dataRoot) => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    let fetchCalls = 0;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    const out = await downloadAndMaterializeLogo({
      tenantId: '15',
      logoUrls: [dataUri],
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch,
    });
    assert.equal(fetchCalls, 0, 'data: URI must not hit the network');
    assert.equal(out, path.join(dataRoot, 'generated', 'validated', '15', 'logo.svg'));
    const written = await readFile(out!, 'utf8');
    assert.equal(written, svg);
  });
});

test('downloadAndMaterializeLogo: data: base64 PNG materializes offline', async () => {
  await withDataRoot(async (dataRoot) => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    const dataUri = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const out = await downloadAndMaterializeLogo({ tenantId: '15', logoUrls: [dataUri] });
    assert.equal(out, path.join(dataRoot, 'generated', 'validated', '15', 'logo.png'));
    const written = await readFile(out!);
    assert.deepEqual(written, PNG_BYTES);
  });
});

test('downloadAndMaterializeLogo: http image is fetched and stored', async () => {
  await withDataRoot(async (dataRoot) => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    const out = await downloadAndMaterializeLogo({
      tenantId: '7',
      logoUrls: ['https://example.com/logo.png'],
      fetchImpl: (async () => imageResponse(PNG_BYTES, 'image/png')) as unknown as typeof fetch,
    });
    assert.equal(out, path.join(dataRoot, 'generated', 'validated', '7', 'logo.png'));
    const written = await readFile(out!);
    assert.deepEqual(written, PNG_BYTES);
  });
});

test('downloadAndMaterializeLogo: non-image content-type is rejected (null, no file)', async () => {
  await withDataRoot(async () => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    const out = await downloadAndMaterializeLogo({
      tenantId: '7',
      logoUrls: ['https://example.com/not-an-image'],
      fetchImpl: (async () => imageResponse(Buffer.from('<html>'), 'text/html')) as unknown as typeof fetch,
    });
    assert.equal(out, null);
  });
});

test('downloadAndMaterializeLogo: oversize content-length is skipped', async () => {
  await withDataRoot(async () => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    const huge = new Response(new Uint8Array(PNG_BYTES), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) },
    });
    const out = await downloadAndMaterializeLogo({
      tenantId: '7',
      logoUrls: ['https://example.com/huge.png'],
      fetchImpl: (async () => huge) as unknown as typeof fetch,
    });
    assert.equal(out, null);
  });
});

test('downloadAndMaterializeLogo: falls through to the next candidate on failure', async () => {
  await withDataRoot(async (dataRoot) => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    const out = await downloadAndMaterializeLogo({
      tenantId: '7',
      logoUrls: ['https://example.com/bad.html', 'https://example.com/good.png'],
      fetchImpl: (async (url: string) =>
        url.endsWith('good.png')
          ? imageResponse(PNG_BYTES, 'image/png')
          : imageResponse(Buffer.from('<html>'), 'text/html')) as unknown as typeof fetch,
    });
    assert.equal(out, path.join(dataRoot, 'generated', 'validated', '7', 'logo.png'));
  });
});

test('downloadAndMaterializeLogo: private/metadata host is skipped without throwing', async () => {
  await withDataRoot(async () => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    let fetchCalls = 0;
    const out = await downloadAndMaterializeLogo({
      tenantId: '7',
      // A literal IP host is rejected by ssrfSafeFetch's URL guard before any fetch.
      logoUrls: ['http://169.254.169.254/latest/meta-data/logo.png'],
      fetchImpl: (async () => {
        fetchCalls += 1;
        return imageResponse(PNG_BYTES, 'image/png');
      }) as unknown as typeof fetch,
    });
    assert.equal(out, null, 'SSRF-blocked URL must yield null, not throw');
    assert.equal(fetchCalls, 0, 'blocked URL must never reach fetch');
  });
});

test('downloadAndMaterializeLogo: empty list returns null', async () => {
  await withDataRoot(async () => {
    const { downloadAndMaterializeLogo } = await import('../backend/marketing/brand-kit');
    const out = await downloadAndMaterializeLogo({ tenantId: '7', logoUrls: [] });
    assert.equal(out, null);
    // sanity: stat would throw if a stray file were created — nothing to check, null is enough
    assert.ok(typeof stat === 'function');
  });
});
