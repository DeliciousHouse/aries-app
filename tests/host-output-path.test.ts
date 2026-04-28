import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { remapHostOutputToMount } from '../backend/marketing/host-output-path';

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
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

test('remapHostOutputToMount returns null when env vars are unset', async () => {
  await withEnv(
    { ARIES_LOBSTER_HOST_OUTPUT_DIR: undefined, ARIES_LOBSTER_HOST_OUTPUT_MOUNT: undefined },
    () => {
      assert.equal(remapHostOutputToMount('/anything'), null);
    },
  );
});

test('remapHostOutputToMount returns null when only one env var is set', async () => {
  await withEnv(
    { ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out', ARIES_LOBSTER_HOST_OUTPUT_MOUNT: undefined },
    () => {
      assert.equal(remapHostOutputToMount('/host/out/file'), null);
    },
  );
  await withEnv(
    { ARIES_LOBSTER_HOST_OUTPUT_DIR: undefined, ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt' },
    () => {
      assert.equal(remapHostOutputToMount('/host/out/file'), null);
    },
  );
});

test('remapHostOutputToMount rewrites paths under host-output-dir onto the mount', async () => {
  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/home/node/aries-app/lobster/output',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/host-lobster-output',
    },
    () => {
      const input = '/home/node/aries-app/lobster/output/27-campaign/landing-pages/index.html';
      assert.equal(
        remapHostOutputToMount(input),
        '/host-lobster-output/27-campaign/landing-pages/index.html',
      );
    },
  );
});

test('remapHostOutputToMount returns the mount itself when input equals host-output-dir', async () => {
  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt',
    },
    () => {
      assert.equal(remapHostOutputToMount('/host/out'), '/mnt');
    },
  );
});

test('remapHostOutputToMount returns null for paths outside host-output-dir', async () => {
  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt',
    },
    () => {
      assert.equal(remapHostOutputToMount('/host/outside/file'), null);
      assert.equal(remapHostOutputToMount('/different/root/file'), null);
      assert.equal(remapHostOutputToMount('/host'), null);
    },
  );
});

test('remapHostOutputToMount handles trailing slashes on env vars without breaking prefix match', async () => {
  // The footgun Copilot flagged: path.normalize preserves trailing slashes,
  // which would make the `${hostDir}${path.sep}` startsWith guard never match.
  // path.resolve strips them, so this must still work.
  const input = '/host/out/campaign/image.png';
  const expected = '/mnt/campaign/image.png';

  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out/',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt',
    },
    () => {
      assert.equal(remapHostOutputToMount(input), expected);
    },
  );

  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt/',
    },
    () => {
      assert.equal(remapHostOutputToMount(input), expected);
    },
  );

  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out/',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt/',
    },
    () => {
      assert.equal(remapHostOutputToMount(input), expected);
    },
  );

  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out///',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt///',
    },
    () => {
      assert.equal(remapHostOutputToMount(input), expected);
    },
  );
});

test('remapHostOutputToMount normalizes the input path', async () => {
  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt',
    },
    () => {
      // Redundant separators and current-dir segments collapse before the prefix match.
      assert.equal(
        remapHostOutputToMount('/host/out//sub/./file.png'),
        path.join('/mnt', 'sub', 'file.png'),
      );
    },
  );
});

test('remapHostOutputToMount does not match partial directory-name prefixes', async () => {
  // /host/output must NOT match /host/out — that's why we require the separator.
  await withEnv(
    {
      ARIES_LOBSTER_HOST_OUTPUT_DIR: '/host/out',
      ARIES_LOBSTER_HOST_OUTPUT_MOUNT: '/mnt',
    },
    () => {
      assert.equal(remapHostOutputToMount('/host/output/file.png'), null);
      assert.equal(remapHostOutputToMount('/host/out-sibling/file.png'), null);
    },
  );
});
