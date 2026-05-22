// Regression: SSRF-010 — SSRF-safe fetch hardening.
// Validates that isBlockedIpAddress, assertSafeUrl, and ssrfSafeFetch correctly
// reject private/reserved addresses and redirect-based SSRF vectors.
// All tests are deterministic and offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

resolveProjectRoot(import.meta.url);

// ---------------------------------------------------------------------------
// isBlockedIpAddress
// ---------------------------------------------------------------------------

test('SSRF-010: isBlockedIpAddress — blocked IPv4 addresses', async () => {
  const { isBlockedIpAddress } = await import('../lib/ssrf-safe-fetch');

  // loopback
  assert.equal(isBlockedIpAddress('127.0.0.1'), true, '127.0.0.1 must be blocked');
  // RFC1918
  assert.equal(isBlockedIpAddress('10.0.0.1'), true, '10.0.0.1 must be blocked');
  assert.equal(isBlockedIpAddress('192.168.1.1'), true, '192.168.1.1 must be blocked');
  assert.equal(isBlockedIpAddress('172.16.0.1'), true, '172.16.0.1 must be blocked');
  // cloud metadata
  assert.equal(isBlockedIpAddress('169.254.169.254'), true, '169.254.169.254 must be blocked');
  // CGNAT
  assert.equal(isBlockedIpAddress('100.64.0.1'), true, '100.64.0.1 must be blocked');
  // unspecified
  assert.equal(isBlockedIpAddress('0.0.0.0'), true, '0.0.0.0 must be blocked');
});

test('SSRF-010: isBlockedIpAddress — blocked IPv6 addresses', async () => {
  const { isBlockedIpAddress } = await import('../lib/ssrf-safe-fetch');

  assert.equal(isBlockedIpAddress('::1'), true, '::1 loopback must be blocked');
  assert.equal(isBlockedIpAddress('fe80::1'), true, 'fe80::1 link-local must be blocked');
  assert.equal(isBlockedIpAddress('fc00::1'), true, 'fc00::1 ULA must be blocked');
  assert.equal(isBlockedIpAddress('fd12:3456:789a::1'), true, 'fd:: ULA must be blocked');
  // IPv4-mapped loopback
  assert.equal(isBlockedIpAddress('::ffff:127.0.0.1'), true, '::ffff:127.0.0.1 must be blocked');
});

test('SSRF-010: isBlockedIpAddress — public addresses allowed', async () => {
  const { isBlockedIpAddress } = await import('../lib/ssrf-safe-fetch');

  assert.equal(isBlockedIpAddress('93.184.216.34'), false, '93.184.216.34 is public');
  assert.equal(isBlockedIpAddress('8.8.8.8'), false, '8.8.8.8 is public');
  assert.equal(
    isBlockedIpAddress('2606:2800:220:1:248:1893:25c8:1946'),
    false,
    '2606:... is public',
  );
});

// ---------------------------------------------------------------------------
// assertSafeUrl
// ---------------------------------------------------------------------------

test('SSRF-010: assertSafeUrl — rejects cloud metadata IP', async () => {
  const { assertSafeUrl } = await import('../lib/ssrf-safe-fetch');

  assert.throws(
    () => assertSafeUrl('http://169.254.169.254/latest/meta-data/'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
    'http://169.254.169.254/ must throw ssrf_blocked:',
  );
});

test('SSRF-010: assertSafeUrl — rejects IPv6 loopback literal', async () => {
  const { assertSafeUrl } = await import('../lib/ssrf-safe-fetch');

  assert.throws(
    () => assertSafeUrl('https://[::1]/'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
    'https://[::1]/ must throw ssrf_blocked:',
  );
});

test('SSRF-010: assertSafeUrl — rejects localhost', async () => {
  const { assertSafeUrl } = await import('../lib/ssrf-safe-fetch');

  assert.throws(
    () => assertSafeUrl('https://localhost/'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
    'https://localhost/ must throw ssrf_blocked:',
  );
});

test('SSRF-010: assertSafeUrl — rejects non-HTTP/HTTPS protocol', async () => {
  const { assertSafeUrl } = await import('../lib/ssrf-safe-fetch');

  assert.throws(
    () => assertSafeUrl('ftp://example.org/file'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
    'ftp:// must throw ssrf_blocked:',
  );
});

test('SSRF-010: assertSafeUrl — rejects RFC1918 IP literal', async () => {
  const { assertSafeUrl } = await import('../lib/ssrf-safe-fetch');

  assert.throws(
    () => assertSafeUrl('https://10.0.0.5/admin'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
    'https://10.0.0.5/ must throw ssrf_blocked:',
  );
});

test('SSRF-010: assertSafeUrl — allows public HTTPS hostname', async () => {
  const { assertSafeUrl } = await import('../lib/ssrf-safe-fetch');

  const url = assertSafeUrl('https://www.example-brand.com/page');
  assert.equal(url.hostname, 'www.example-brand.com');
});

// ---------------------------------------------------------------------------
// ssrfSafeFetch with injected fetchImpl
// ---------------------------------------------------------------------------

test('SSRF-010: ssrfSafeFetch — blocks private URL before invoking fake fetch', async () => {
  const { ssrfSafeFetch } = await import('../lib/ssrf-safe-fetch');

  let fakeCalled = false;
  const fakeFetch = (async (_input: RequestInfo | URL) => {
    fakeCalled = true;
    return new Response('should not reach here', { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    () => ssrfSafeFetch('http://169.254.169.254/latest/meta-data/', {}, { fetchImpl: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
  );

  assert.equal(fakeCalled, false, 'fake fetch must not be called for blocked URL');
});

test('SSRF-010: ssrfSafeFetch — passes public URL through to fake fetch', async () => {
  const { ssrfSafeFetch } = await import('../lib/ssrf-safe-fetch');

  let capturedUrl: string | undefined;
  const fakeFetch = (async (input: RequestInfo | URL) => {
    capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const response = await ssrfSafeFetch(
    'https://www.public-brand.com/',
    {},
    { fetchImpl: fakeFetch },
  );

  assert.equal(response.status, 200);
  assert.equal(capturedUrl, 'https://www.public-brand.com/');
});

// ---------------------------------------------------------------------------
// SSRF via stylesheet URL (the original attack vector)
// ---------------------------------------------------------------------------

test('SSRF-010: ssrfSafeFetch — rejects internal stylesheet URL injected via HTML', async () => {
  const { ssrfSafeFetch } = await import('../lib/ssrf-safe-fetch');

  let fakeCalled = false;
  const fakeFetch = (async () => {
    fakeCalled = true;
    return new Response('evil', { status: 200 });
  }) as typeof fetch;

  // Attacker-controlled <link href="http://192.168.1.1/steal"> in HTML:
  await assert.rejects(
    () =>
      ssrfSafeFetch('http://192.168.1.1/steal.css', {}, { fetchImpl: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('ssrf_blocked:'), `message: ${err.message}`);
      return true;
    },
  );

  assert.equal(fakeCalled, false, 'fake fetch must not be called for blocked stylesheet URL');
});
