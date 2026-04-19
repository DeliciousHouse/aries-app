import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contentTypeForAsset } from '../backend/marketing/asset-library';

async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aries-mime-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('contentTypeForAsset returns video/* for common video extensions', async () => {
  await withScratchDir(async (dir) => {
    // Non-existent files: sniffing returns null, the ext switch decides.
    const mp4 = path.join(dir, 'nonexistent.mp4');
    const mov = path.join(dir, 'nonexistent.mov');
    const m4v = path.join(dir, 'nonexistent.m4v');
    const webm = path.join(dir, 'nonexistent.webm');
    const ogv = path.join(dir, 'nonexistent.ogv');
    const ogg = path.join(dir, 'nonexistent.ogg');

    assert.equal(contentTypeForAsset(mp4), 'video/mp4');
    assert.equal(contentTypeForAsset(mov), 'video/quicktime');
    assert.equal(contentTypeForAsset(m4v), 'video/x-m4v');
    assert.equal(contentTypeForAsset(webm), 'video/webm');
    assert.equal(contentTypeForAsset(ogv), 'video/ogg');
    assert.equal(contentTypeForAsset(ogg), 'video/ogg');
  });
});

test('contentTypeForAsset falls back to application/octet-stream for unknown extensions', async () => {
  await withScratchDir(async (dir) => {
    const unknown = path.join(dir, 'nonexistent.bin');
    assert.equal(contentTypeForAsset(unknown), 'application/octet-stream');
  });
});

test('contentTypeForAsset sniffs ftyp magic bytes to classify ISOBMFF as video/mp4 even without a .mp4 extension', async () => {
  await withScratchDir(async (dir) => {
    const mislabeled = path.join(dir, 'asset.bin');
    // Minimal ftyp box header: 4-byte size (any) + 'ftyp' + 4-byte major brand.
    const buffer = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftypisom', 'ascii'),
      Buffer.alloc(16, 0),
    ]);
    await writeFile(mislabeled, buffer);

    assert.equal(contentTypeForAsset(mislabeled), 'video/mp4');
  });
});

test('contentTypeForAsset keeps .mov as video/quicktime even though the file carries an ftyp box', async () => {
  await withScratchDir(async (dir) => {
    // Real .mov files are ISOBMFF too and include an `ftyp` box. Extension
    // wins so we keep the QuickTime distinction instead of collapsing all
    // ISOBMFF into video/mp4.
    const movFile = path.join(dir, 'clip.mov');
    const buffer = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftypqt  ', 'ascii'),
      Buffer.alloc(16, 0),
    ]);
    await writeFile(movFile, buffer);

    assert.equal(contentTypeForAsset(movFile), 'video/quicktime');
  });
});

test('contentTypeForAsset keeps sniffing image magic bytes when extension is missing', async () => {
  await withScratchDir(async (dir) => {
    const pngLike = path.join(dir, 'asset.bin');
    // PNG signature.
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await writeFile(pngLike, buffer);

    assert.equal(contentTypeForAsset(pngLike), 'image/png');
  });
});

test('contentTypeForAsset trusts image bytes over a drifted extension (JPEG bytes saved as .png)', async () => {
  await withScratchDir(async (dir) => {
    // Operators routinely keep the source URL's extension when scraping a
    // preview, so image MIME has to follow the bytes when the two disagree.
    const drifted = path.join(dir, 'meta-preview.png');
    await writeFile(drifted, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]));

    assert.equal(contentTypeForAsset(drifted), 'image/jpeg');
  });
});
