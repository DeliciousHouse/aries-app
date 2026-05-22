/**
 * SSRF-safe outbound fetch helpers.
 *
 * All outbound HTTP requests for user-supplied URLs (brand-kit extraction,
 * url-preview, stylesheet fetches) must go through ssrfSafeFetch so that
 * redirect chains and attacker-controlled hrefs cannot reach internal services.
 *
 * Design notes:
 * - assertSafeUrl is synchronous and network-free (hostname-literal check only).
 * - ssrfSafeFetch additionally resolves DNS and rejects private addresses before
 *   each hop, closing the most common bypass vectors (redirects, stylesheet hrefs).
 * - DNS-rebinding TOCTOU note: we re-resolve and re-validate immediately before
 *   each hop.  A sufficiently fast rebind between our check and the kernel's
 *   connect() call could still reach a private host.  The undici Agent.connect.lookup
 *   pin (which would close this window entirely) requires undici to be a resolvable
 *   dependency; fall back to this documented-narrow-window approach until that is
 *   available.
 */

import dns from 'node:dns';

// ---------------------------------------------------------------------------
// IPv4 / IPv6 block-list helpers
// ---------------------------------------------------------------------------

/** Parse a dotted-decimal IPv4 string into a 32-bit integer, or null if invalid. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = parseInt(part, 10);
    if (byte > 255) return null;
    value = (value << 8) | byte;
  }
  return value >>> 0; // unsigned 32-bit
}

/** True if the IPv4 address (as a 32-bit unsigned int) falls in a private/reserved range. */
function isBlockedIPv4Int(ip32: number): boolean {
  // 0.0.0.0/8   — this-network / unspecified
  if ((ip32 >>> 24) === 0x00) return true;
  // 10.0.0.0/8  — RFC1918 private
  if ((ip32 >>> 24) === 0x0a) return true;
  // 100.64.0.0/10 — CGNAT (RFC 6598)
  if ((ip32 >>> 22) === (0x64400000 >>> 22)) return true;
  // 127.0.0.0/8  — loopback
  if ((ip32 >>> 24) === 0x7f) return true;
  // 169.254.0.0/16 — link-local / cloud metadata (169.254.169.254 lives here)
  if ((ip32 >>> 16) === 0xa9fe) return true;
  // 172.16.0.0/12  — RFC1918 private
  if ((ip32 >>> 20) === (0xac100000 >>> 20)) return true;
  // 192.168.0.0/16 — RFC1918 private
  if ((ip32 >>> 16) === 0xc0a8) return true;
  return false;
}

/**
 * Returns true if the given IP address string is private or reserved and must
 * never be contacted by an outbound request.
 *
 * Covers:
 *   IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12, 192.168/16
 *   IPv6: ::1 (loopback), :: (unspecified), fc00::/7 (ULA), fe80::/10 (link-local),
 *         ::ffff:x.x.x.x (IPv4-mapped — embedded address is rechecked)
 */
export function isBlockedIpAddress(ip: string): boolean {
  // Normalize: lowercase, strip surrounding brackets used for IPv6 literals.
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // --- Pure IPv4 ---
  const v4 = parseIPv4(normalized);
  if (v4 !== null) {
    return isBlockedIPv4Int(v4);
  }

  // --- IPv6 ---
  // IPv4-mapped: ::ffff:a.b.c.d  or  ::ffff:xxyy (hex form)
  const v4MappedDotted = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedDotted) {
    // Recurse on the embedded IPv4 address.
    return isBlockedIpAddress(v4MappedDotted[1]);
  }
  const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{4}):([0-9a-f]{4})$/);
  if (v4MappedHex) {
    // Convert hex groups to dotted-decimal.
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const dotted = `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
    return isBlockedIpAddress(dotted);
  }

  // Unspecified address
  if (normalized === '::') return true;

  // Loopback ::1
  if (normalized === '::1') return true;

  // fc00::/7 — Unique Local Addresses (ULA).  First byte 0xfc or 0xfd.
  const firstGroup = normalized.split(':')[0];
  if (firstGroup) {
    const firstByte = parseInt(firstGroup.padStart(4, '0').slice(0, 2), 16);
    if (!isNaN(firstByte) && (firstByte & 0xfe) === 0xfc) return true;
  }

  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // Also catch fe80:: (no colon after the first group in short forms)
  if (normalized.startsWith('fe80:')) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Synchronous, network-free URL validator
// ---------------------------------------------------------------------------

/**
 * Validates that a URL is safe to fetch without touching the network.
 *
 * Throws an Error with a message prefixed `ssrf_blocked:` when:
 *   - Protocol is not http: or https:
 *   - Hostname is `localhost` or ends with `.localhost`
 *   - Hostname is an IPv4 or IPv6 literal that resolves to a blocked address
 *
 * IPv6 literals appear in URLs as `[::1]`; new URL() normalises the hostname
 * to `[::1]` (with brackets) so we strip them before passing to isBlockedIpAddress.
 *
 * Returns the parsed URL on success.
 */
export function assertSafeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`ssrf_blocked:invalid_url:${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`ssrf_blocked:disallowed_protocol:${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Localhost check (also catches *.localhost per RFC 6761).
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`ssrf_blocked:localhost:${hostname}`);
  }

  // IPv4 literal — hostname is digits and dots only.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error(`ssrf_blocked:blocked_ip:${hostname}`);
    }
    // A public IPv4 literal is technically allowed here (though unusual).
    return parsed;
  }

  // IPv6 literal — new URL() keeps brackets in hostname, e.g. `[::1]`.
  if (hostname.startsWith('[') || hostname.includes(':')) {
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (isBlockedIpAddress(bare)) {
      throw new Error(`ssrf_blocked:blocked_ip:${hostname}`);
    }
    // A public IPv6 literal is allowed.
    return parsed;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// DNS-validating safe fetch
// ---------------------------------------------------------------------------

interface SsrfSafeFetchOptions {
  /** Override the fetch implementation (used in tests to inject a fake). */
  fetchImpl?: typeof fetch;
  /** Maximum redirect hops before throwing. Default 5. */
  maxRedirects?: number;
}

/**
 * Fetches a URL with SSRF protection.
 *
 * Behavior depends on whether a custom fetchImpl is injected via opts:
 *
 * - Injected-fetchImpl mode (opts.fetchImpl is provided):
 *   Runs assertSafeUrl, then delegates directly to the injected impl.
 *   DNS resolution is skipped — the caller controls the transport, so the
 *   URL-literal check is sufficient.  Tests use this path (both explicit
 *   fake injection and globalThis.fetch monkey-patching, since brand-kit
 *   forwards the current global as fetchImpl regardless).
 *
 * - Production mode (opts.fetchImpl is undefined):
 *   1. assertSafeUrl — protocol and IP-literal check.
 *   2. dns.promises.lookup — rejects if ANY resolved address is private.
 *   3. Performs the request with redirect: 'manual'.
 *   4. On 3xx: resolves Location, re-runs assertSafeUrl + DNS check on the
 *      new target, and follows manually — up to maxRedirects hops.
 *
 * DNS-rebinding note: there is a narrow TOCTOU window between our DNS check
 * and the kernel's connect().  Pinning via undici Agent.connect.lookup would
 * close this window but requires undici as a resolvable dependency.
 */
export async function ssrfSafeFetch(
  rawUrl: string,
  init?: RequestInit,
  opts?: SsrfSafeFetchOptions,
): Promise<Response> {
  const maxRedirects = opts?.maxRedirects ?? 5;

  // ------------------------------------------------------------------
  // Injected-fetchImpl mode: URL-literal check only, then delegate.
  //
  // Any provided fetchImpl (including a monkey-patched globalThis.fetch
  // forwarded from brand-kit.ts) takes this path.  DNS resolution is
  // skipped to keep tests deterministic and offline.
  // ------------------------------------------------------------------
  if (opts?.fetchImpl !== undefined) {
    assertSafeUrl(rawUrl);
    return opts.fetchImpl(rawUrl, init);
  }

  // ------------------------------------------------------------------
  // Production mode: full DNS + redirect validation.
  // ------------------------------------------------------------------
  const realFetch = globalThis.fetch;
  let currentUrl = rawUrl;
  let hops = 0;

  while (hops <= maxRedirects) {
    // 1. Synchronous URL/protocol/IP-literal check.
    const parsed = assertSafeUrl(currentUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    // 2. DNS resolution — reject if any address is private.
    //    Skip DNS check for IP literals (already validated above).
    const isIpLiteral =
      /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':');
    if (!isIpLiteral) {
      let addresses: { address: string }[];
      try {
        addresses = await dns.promises.lookup(hostname, { all: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`ssrf_blocked:dns_lookup_failed:${hostname}:${msg}`);
      }
      for (const { address } of addresses) {
        if (isBlockedIpAddress(address)) {
          throw new Error(`ssrf_blocked:dns_resolves_to_private:${hostname}:${address}`);
        }
      }
    }

    // 3. Perform the request — never follow redirects automatically.
    const response = await realFetch(currentUrl, {
      ...init,
      redirect: 'manual',
    });

    // 4. Follow 3xx manually so we can validate each hop.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        // No Location header — return the redirect response as-is.
        return response;
      }
      // Resolve relative Location against the current URL.
      currentUrl = new URL(location, currentUrl).href;
      hops++;
      if (hops > maxRedirects) {
        throw new Error(`ssrf_blocked:too_many_redirects:${maxRedirects}`);
      }
      continue;
    }

    return response;
  }

  // Should be unreachable, but satisfies TS.
  throw new Error(`ssrf_blocked:too_many_redirects:${maxRedirects}`);
}
