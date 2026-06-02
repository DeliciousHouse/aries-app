import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GET } from '../app/api/public/media/[token]/[basename]/route';
import { signMediaToken } from '../lib/signed-media-token';

const SECRET = 'test-internal-secret';
const PNG = Buffer.from('89504e470d0a1a0a-fake-png-bytes', 'utf8');

async function withEnv<T>(fn: (roots: { mount: string; dataRoot: string }) => Promise<T>): Promise<T> {
  const mount = await mkdtemp(path.join(tmpdir(), 'pm-mount-'));
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'pm-data-'));
  const prev = {
    secret: process.env.INTERNAL_API_SECRET,
    mount: process.env.HERMES_IMAGE_CACHE_MOUNT,
    data: process.env.DATA_ROOT,
  };
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  process.env.DATA_ROOT = dataRoot;
  try {
    return await fn({ mount, dataRoot });
  } finally {
    process.env.INTERNAL_API_SECRET = prev.secret;
    process.env.HERMES_IMAGE_CACHE_MOUNT = prev.mount;
    if (prev.data === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev.data;
    await rm(mount, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function call(token: string, basename: string) {
  return GET(new Request('https://aries.example.com/api/public/media/x/y'), {
    params: Promise.resolve({ token, basename }),
  });
}

test('serves an ingested_asset (composed story / upload) from DATA_ROOT by tenant + sha path', async () => {
  await withEnv(async ({ dataRoot }) => {
    const sha = crypto.createHash('sha256').update(PNG).digest('hex');
    const basename = `${sha}.png`;
    const dir = path.join(dataRoot, 'ingested-assets', '15', sha.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, basename), PNG);

    const token = signMediaToken({ tenantId: '15', basename, expiresAt: Date.now() + 60_000 }, SECRET);
    const res = await call(token, basename);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.length, PNG.length);
  });
});

test('still serves a runtime_asset from the Hermes mount by basename', async () => {
  await withEnv(async ({ mount }) => {
    const basename = 'runtime_img.png';
    await writeFile(path.join(mount, basename), PNG);
    const token = signMediaToken({ tenantId: '15', basename, expiresAt: Date.now() + 60_000 }, SECRET);
    const res = await call(token, basename);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });
});

test('404 when the ingested file does not exist for the token tenant', async () => {
  await withEnv(async () => {
    const sha = crypto.createHash('sha256').update(PNG).digest('hex');
    const basename = `${sha}.png`;
    // No file written anywhere.
    const token = signMediaToken({ tenantId: '15', basename, expiresAt: Date.now() + 60_000 }, SECRET);
    const res = await call(token, basename);
    assert.equal(res.status, 404);
  });
});

test('a token for tenant A cannot reach tenant B ingested bytes (path is tenant-scoped)', async () => {
  await withEnv(async ({ dataRoot }) => {
    const sha = crypto.createHash('sha256').update(PNG).digest('hex');
    const basename = `${sha}.png`;
    // File belongs to tenant 99.
    const dir = path.join(dataRoot, 'ingested-assets', '99', sha.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, basename), PNG);
    // Token claims tenant 15 -> resolver looks under /15/ -> miss -> 404.
    const token = signMediaToken({ tenantId: '15', basename, expiresAt: Date.now() + 60_000 }, SECRET);
    const res = await call(token, basename);
    assert.equal(res.status, 404);
  });
});
