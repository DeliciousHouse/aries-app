/**
 * Durable media store — the object-storage fallback behind the public proxy.
 *
 * THE LOAD-BEARING PROPERTY IN THIS FILE IS FAIL-OPEN.
 *
 * This module sits in two hot paths: asset ingestion (a Hermes callback) and the
 * public media proxy (what Meta fetches at publish time). It exists because
 * media went missing and broke publishing — so it must never itself become a new
 * way for those paths to break. A dead bucket, a missing IAM grant, an expired
 * token, a hung metadata server: every one of them has to degrade to exactly the
 * behaviour we already have, never to a thrown error.
 *
 * The tests below therefore care less about the happy path than about every way
 * the store can fail.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  durableObjectName,
  getDurableMedia,
  isDurableMediaEnabled,
  putDurableMedia,
  type DurableMediaTransport,
} from '../backend/marketing/durable-media-store';

const ON = {
  ARIES_DURABLE_MEDIA_ENABLED: '1',
  ARIES_DURABLE_MEDIA_BUCKET: 'aries-media',
} as unknown as NodeJS.ProcessEnv;

const TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Records every call so a test can assert the network was never touched. */
function transportOf(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { transport: DurableMediaTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async fetch(url, init) {
        calls.push(url);
        return handler(url, init);
      },
    },
  };
}

/** A transport that mints a token and then defers to `onApi` for the GCS call. */
function tokenThen(onApi: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  return transportOf((url, init) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return onApi(url, init);
  });
}

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

test('off by default, and a flag without a bucket is still off', () => {
  assert.equal(isDurableMediaEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(
    isDurableMediaEnabled({ ARIES_DURABLE_MEDIA_ENABLED: '1' } as unknown as NodeJS.ProcessEnv),
    false,
    'a half-finished rollout must read as off, never as an error',
  );
  assert.equal(
    isDurableMediaEnabled({
      ARIES_DURABLE_MEDIA_ENABLED: '1',
      ARIES_DURABLE_MEDIA_BUCKET: '   ',
    } as unknown as NodeJS.ProcessEnv),
    false,
  );
  assert.equal(isDurableMediaEnabled(ON), true);
});

test('the four canonical truthy tokens enable it; everything else does not', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
    const env = { ...ON, ARIES_DURABLE_MEDIA_ENABLED: v } as unknown as NodeJS.ProcessEnv;
    assert.equal(isDurableMediaEnabled(env), true, `token ${v}`);
  }
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', 'maybe']) {
    const env = { ...ON, ARIES_DURABLE_MEDIA_ENABLED: v } as unknown as NodeJS.ProcessEnv;
    assert.equal(isDurableMediaEnabled(env), false, `token ${v}`);
  }
});

test('when off, NEITHER entry point touches the network', async () => {
  const { transport, calls } = transportOf(() => {
    throw new Error('the network must not be reached when the store is off');
  });
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(await putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env, transport }), false);
  assert.equal(await getDurableMedia(15, 'a.png', { env, transport }), null);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Object naming / containment
// ---------------------------------------------------------------------------

test('object names are tenant-scoped under the prefix', () => {
  assert.equal(durableObjectName(15, 'a.png', ON), 'creative/15/a.png');
  assert.equal(
    durableObjectName('70', 'b.png', { ...ON, ARIES_DURABLE_MEDIA_PREFIX: 'media' } as unknown as NodeJS.ProcessEnv),
    'media/70/b.png',
  );
  assert.equal(
    durableObjectName(15, 'a.png', { ...ON, ARIES_DURABLE_MEDIA_PREFIX: '/wrapped/' } as unknown as NodeJS.ProcessEnv),
    'wrapped/15/a.png',
    'stray slashes in the prefix must not produce a doubled separator',
  );
});

test('anything that could escape the tenant prefix is refused', () => {
  for (const bad of ['../x.png', 'a/b.png', 'a\\b.png', '..', '', '   ']) {
    assert.equal(durableObjectName(15, bad, ON), null, `basename ${JSON.stringify(bad)}`);
  }
  for (const bad of ['0', '-1', 'abc', '1x', '', ' ']) {
    assert.equal(durableObjectName(bad, 'a.png', ON), null, `tenant ${JSON.stringify(bad)}`);
  }
});

test('a traversing basename never reaches the network', async () => {
  const { transport, calls } = transportOf(() => {
    throw new Error('must not be called for a rejected object name');
  });
  assert.equal(
    await putDurableMedia(15, '../escape.png', Buffer.from('x'), 'image/png', { env: ON, transport }),
    false,
  );
  assert.equal(await getDurableMedia(15, '../escape.png', { env: ON, transport }), null);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test('upload posts the bytes to the tenant-scoped object and reports success', async () => {
  let seenUrl = '';
  let seenType = '';
  let seenBody: unknown = null;
  const { transport } = tokenThen((url, init) => {
    seenUrl = url;
    seenType = String((init?.headers as Record<string, string>)?.['content-type'] ?? '');
    seenBody = init?.body;
    return new Response('{}', { status: 200 });
  });

  const bytes = Buffer.from('PNGDATA');
  const ok = await putDurableMedia(15, 'a.png', bytes, 'image/png', { env: ON, transport });

  assert.equal(ok, true);
  assert.match(seenUrl, /\/upload\/storage\/v1\/b\/aries-media\/o/);
  assert.match(seenUrl, /name=creative%2F15%2Fa\.png/);
  assert.equal(seenType, 'image/png');
  assert.equal(seenBody, bytes);
});

test('upload FAILS OPEN on a rejected write, a dead token, and a thrown transport', async () => {
  const rejected = tokenThen(() => new Response('denied', { status: 403 }));
  assert.equal(
    await putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env: ON, transport: rejected.transport }),
    false,
  );

  const noToken = transportOf((url) =>
    url === TOKEN_URL ? new Response('nope', { status: 500 }) : new Response('{}', { status: 200 }),
  );
  assert.equal(
    await putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env: ON, transport: noToken.transport }),
    false,
  );
  assert.deepEqual(noToken.calls, [TOKEN_URL], 'a failed token must short-circuit before the API call');

  const throws = transportOf(() => {
    throw new Error('ECONNREFUSED');
  });
  await assert.doesNotReject(() =>
    putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env: ON, transport: throws.transport }),
  );
  assert.equal(
    await putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env: ON, transport: throws.transport }),
    false,
  );
});

test('a malformed token response is treated as no token, not as a crash', async () => {
  for (const body of ['{}', 'not json', '{"access_token": 42}', '{"access_token": ""}']) {
    const { transport } = transportOf((url) =>
      url === TOKEN_URL ? new Response(body, { status: 200 }) : new Response('{}', { status: 200 }),
    );
    assert.equal(
      await putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env: ON, transport }),
      false,
      `token body ${body}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

test('read returns the bytes for a stored object', async () => {
  let seenUrl = '';
  const { transport } = tokenThen((url) => {
    seenUrl = url;
    return new Response(Buffer.from('IMAGEBYTES'), { status: 200 });
  });

  const got = await getDurableMedia(15, 'a.png', { env: ON, transport });
  assert.ok(got);
  assert.equal(got.toString(), 'IMAGEBYTES');
  assert.match(seenUrl, /\/storage\/v1\/b\/aries-media\/o\/creative%2F15%2Fa\.png\?alt=media/);
});

test('read FAILS OPEN on 404, on error status, and on a thrown transport', async () => {
  const missing = tokenThen(() => new Response('', { status: 404 }));
  assert.equal(await getDurableMedia(15, 'a.png', { env: ON, transport: missing.transport }), null);

  const broken = tokenThen(() => new Response('boom', { status: 500 }));
  assert.equal(await getDurableMedia(15, 'a.png', { env: ON, transport: broken.transport }), null);

  const throws = transportOf(() => {
    throw new Error('ECONNRESET');
  });
  await assert.doesNotReject(() => getDurableMedia(15, 'a.png', { env: ON, transport: throws.transport }));
  assert.equal(await getDurableMedia(15, 'a.png', { env: ON, transport: throws.transport }), null);
});

test('a zero-byte object reads as absent, never as a valid empty image', async () => {
  // Serving 0 bytes to Meta reproduces the exact failure this module exists to
  // prevent ("Only photo or video can be accepted as media type").
  const { transport } = tokenThen(() => new Response(Buffer.alloc(0), { status: 200 }));
  assert.equal(await getDurableMedia(15, 'a.png', { env: ON, transport }), null);
});

test('a hung transport times out and fails open rather than hanging the publish path', async () => {
  const env = { ...ON, ARIES_DURABLE_MEDIA_TIMEOUT_MS: '30' } as unknown as NodeJS.ProcessEnv;
  const { transport } = transportOf(
    () => new Promise<Response>(() => {}), // never settles
  );
  assert.equal(await getDurableMedia(15, 'a.png', { env, transport }), null);
  assert.equal(await putDurableMedia(15, 'a.png', Buffer.from('x'), 'image/png', { env, transport }), false);
});

test('tenants cannot read each other: the object name carries the caller tenant', async () => {
  const seen: string[] = [];
  const { transport } = tokenThen((url) => {
    seen.push(url);
    return new Response(Buffer.from('x'), { status: 200 });
  });
  await getDurableMedia(15, 'shared.png', { env: ON, transport });
  await getDurableMedia(70, 'shared.png', { env: ON, transport });
  assert.match(seen[0], /creative%2F15%2Fshared\.png/);
  assert.match(seen[1], /creative%2F70%2Fshared\.png/);
});
