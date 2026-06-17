import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __resetHermesMediaPresenceCacheForTests,
  availableHermesMediaUrl,
  hermesMediaBasenameFromUrl,
  isMissingHermesMedia,
  sanitizeAssetPreviewsForMissingMedia,
} from '../../backend/marketing/hermes-media-presence';

const APP = 'https://aries.sugarandleather.com';
const HERMES = `${APP}/api/internal/hermes/media`;
const PRESENT = 'openai_codex_gpt-image-2-low_20260520_present.png';
const MISSING = 'openai_codex_gpt-image-2-medium_20260519_missing.png';

async function withMount<T>(run: (mount: string) => Promise<T>): Promise<T> {
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const mount = await mkdtemp(path.join(tmpdir(), 'aries-hermes-mount-'));
  await writeFile(path.join(mount, PRESENT), 'png-bytes');
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  __resetHermesMediaPresenceCacheForTests();
  try {
    return await run(mount);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
    await rm(mount, { recursive: true, force: true });
  }
}

test('hermesMediaBasenameFromUrl extracts the basename only for basename-addressed hermes-media URLs', () => {
  assert.equal(hermesMediaBasenameFromUrl(`${HERMES}/${PRESENT}`), PRESENT);
  // relative form is accepted too
  assert.equal(hermesMediaBasenameFromUrl(`/api/internal/hermes/media/${PRESENT}`), PRESENT);
  // id/UUID-addressed media is DB-resolved, not a flat basename → null (never nulled here)
  assert.equal(
    hermesMediaBasenameFromUrl(`${HERMES}/123e4567-e89b-42d3-a456-426614174000`),
    null,
  );
  // non-hermes URLs → null
  assert.equal(hermesMediaBasenameFromUrl(`${APP}/api/marketing/jobs/j/assets/a`), null);
  assert.equal(hermesMediaBasenameFromUrl('https://example.com/a.png'), null);
  // nested path under the media prefix → null (route only serves a single segment)
  assert.equal(hermesMediaBasenameFromUrl(`${HERMES}/sub/${PRESENT}`), null);
  // junk → null
  assert.equal(hermesMediaBasenameFromUrl('not a url'), null);
});

test('availableHermesMediaUrl passes through a present basename and nulls a missing one', async () => {
  await withMount(async () => {
    assert.equal(availableHermesMediaUrl(`${HERMES}/${PRESENT}`), `${HERMES}/${PRESENT}`);
    assert.equal(availableHermesMediaUrl(`${HERMES}/${MISSING}`), null);
    assert.equal(isMissingHermesMedia(`${HERMES}/${MISSING}`), true);
    assert.equal(isMissingHermesMedia(`${HERMES}/${PRESENT}`), false);
  });
});

test('availableHermesMediaUrl is a pure pass-through for null/non-hermes/id-addressed URLs', async () => {
  await withMount(async () => {
    assert.equal(availableHermesMediaUrl(null), null);
    assert.equal(availableHermesMediaUrl(''), null);
    const jobAsset = `${APP}/api/marketing/jobs/j/assets/a`;
    assert.equal(availableHermesMediaUrl(jobAsset), jobAsset);
    const external = 'https://cdn.example.com/x.png';
    assert.equal(availableHermesMediaUrl(external), external);
    // id-addressed hermes URL is never nulled even when absent from the mount
    const idUrl = `${HERMES}/123e4567-e89b-42d3-a456-426614174000`;
    assert.equal(availableHermesMediaUrl(idUrl), idUrl);
  });
});

test('availableHermesMediaUrl fails open (URL unchanged) when the mount is unconfigured', () => {
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  delete process.env.HERMES_IMAGE_CACHE_MOUNT;
  __resetHermesMediaPresenceCacheForTests();
  try {
    const url = `${HERMES}/${MISSING}`;
    assert.equal(availableHermesMediaUrl(url), url);
    assert.equal(isMissingHermesMedia(url), false);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
  }
});

test('availableHermesMediaUrl fails open when the mount path is unreadable', () => {
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  process.env.HERMES_IMAGE_CACHE_MOUNT = path.join(tmpdir(), `aries-nonexistent-mount-${process.pid}`);
  __resetHermesMediaPresenceCacheForTests();
  try {
    const url = `${HERMES}/${MISSING}`;
    assert.equal(availableHermesMediaUrl(url), url);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
  }
});

test('a percent-encoded basename round-trips and matches the on-disk (decoded) name', async () => {
  const encodedName = 'openai codex 20260520+v2.png'; // space + plus → encoded in the URL path
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const mount = await mkdtemp(path.join(tmpdir(), 'aries-hermes-enc-'));
  await writeFile(path.join(mount, encodedName), 'png-bytes');
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  __resetHermesMediaPresenceCacheForTests();
  try {
    const encodedUrl = `${HERMES}/${encodeURIComponent(encodedName)}`;
    assert.equal(hermesMediaBasenameFromUrl(encodedUrl), encodedName);
    assert.equal(availableHermesMediaUrl(encodedUrl), encodedUrl);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
    await rm(mount, { recursive: true, force: true });
  }
});

test('the mount listing cache honours its TTL on the same root (stale within window, refreshed after)', async () => {
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const mount = await mkdtemp(path.join(tmpdir(), 'aries-hermes-ttl-'));
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  __resetHermesMediaPresenceCacheForTests();
  const url = `${HERMES}/${MISSING}`;
  try {
    // t=0: file absent → cached as missing (nulled).
    assert.equal(availableHermesMediaUrl(url, 0), null);
    // File appears, but within the 15s window the cached listing is still served → stale-missing.
    await writeFile(path.join(mount, MISSING), 'png-bytes');
    assert.equal(availableHermesMediaUrl(url, 10_000), null);
    // After the TTL elapses the listing is re-read → now present.
    assert.equal(availableHermesMediaUrl(url, 16_000), url);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
    await rm(mount, { recursive: true, force: true });
  }
});

test('sanitizeAssetPreviewsForMissingMedia nulls dead previews, preserves live + non-hermes, byte-identical when nothing missing', async () => {
  await withMount(async () => {
    const idUrl = `${HERMES}/123e4567-e89b-42d3-a456-426614174000`;
    const jobAsset = `${APP}/api/marketing/jobs/j/assets/a`;
    const dataUri = 'data:image/svg+xml;base64,AAAA';
    const assets = [
      { id: 'dead', previewUrl: `${HERMES}/${MISSING}`, thumbnailUrl: `${HERMES}/${MISSING}` },
      { id: 'live', previewUrl: `${HERMES}/${PRESENT}`, thumbnailUrl: `${HERMES}/${PRESENT}` },
      { id: 'id-addressed', previewUrl: idUrl, thumbnailUrl: idUrl },
      { id: 'job-asset', previewUrl: jobAsset, thumbnailUrl: jobAsset },
      { id: 'placeholder', previewUrl: dataUri, thumbnailUrl: dataUri },
    ];

    const out = sanitizeAssetPreviewsForMissingMedia(assets);

    // Dead hermes-media basename → both fields nulled so the UI placeholder fires.
    assert.deepEqual(
      out.find((a) => a.id === 'dead'),
      { id: 'dead', previewUrl: null, thumbnailUrl: null },
    );
    // Live + non-hermes + id-addressed + placeholder are returned byte-identical
    // (same object reference, since nothing was missing).
    for (const id of ['live', 'id-addressed', 'job-asset', 'placeholder']) {
      const before = assets.find((a) => a.id === id);
      const after = out.find((a) => a.id === id);
      assert.equal(after, before, `${id} must be the unchanged object reference`);
    }
  });
});

test('sanitizeAssetPreviewsForMissingMedia nulls only the missing side when preview/thumbnail differ', async () => {
  await withMount(async () => {
    const [out] = sanitizeAssetPreviewsForMissingMedia([
      { id: 'mixed', previewUrl: `${HERMES}/${PRESENT}`, thumbnailUrl: `${HERMES}/${MISSING}` },
    ]);
    assert.equal(out.previewUrl, `${HERMES}/${PRESENT}`);
    assert.equal(out.thumbnailUrl, null);
  });
});

test('sanitizeAssetPreviewsForMissingMedia fails open (assets untouched) when the mount is unconfigured', () => {
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  delete process.env.HERMES_IMAGE_CACHE_MOUNT;
  __resetHermesMediaPresenceCacheForTests();
  try {
    const assets = [{ id: 'dead', previewUrl: `${HERMES}/${MISSING}`, thumbnailUrl: `${HERMES}/${MISSING}` }];
    const out = sanitizeAssetPreviewsForMissingMedia(assets);
    assert.equal(out[0], assets[0]);
    assert.equal(out[0].previewUrl, `${HERMES}/${MISSING}`);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
  }
});

test('the mount listing cache refreshes when the mount root changes', async () => {
  // First mount: MISSING is absent → nulled.
  await withMount(async () => {
    assert.equal(availableHermesMediaUrl(`${HERMES}/${MISSING}`), null);
  });
  // Second mount that DOES contain MISSING → cache keyed by root re-reads → present.
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const mount2 = await mkdtemp(path.join(tmpdir(), 'aries-hermes-mount2-'));
  await writeFile(path.join(mount2, MISSING), 'png-bytes');
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount2;
  try {
    // No explicit reset: the cache must invalidate on its own because the root changed.
    assert.equal(availableHermesMediaUrl(`${HERMES}/${MISSING}`), `${HERMES}/${MISSING}`);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    __resetHermesMediaPresenceCacheForTests();
    await rm(mount2, { recursive: true, force: true });
  }
});
