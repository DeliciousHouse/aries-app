import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// URL-safe base64 helpers (no padding, RFC 4648 §5)
// ---------------------------------------------------------------------------

export function urlSafeB64Encode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function urlSafeB64Decode(input: string): Buffer {
  // Re-pad to a multiple of 4 so Buffer.from handles it correctly
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padding), 'base64');
}

// ---------------------------------------------------------------------------
// Token payload
// ---------------------------------------------------------------------------

export type SignedMediaPayload = {
  tenantId: string;
  basename: string;
  expiresAt: number; // Unix ms
};

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Produces a URL-safe base64 token encoding `{payload, signature}`.
 * The HMAC signs `${tenantId}|${basename}|${expiresAt}` with SHA-256.
 */
export function signMediaToken(payload: SignedMediaPayload, secret: string): string {
  const message = `${payload.tenantId}|${payload.basename}|${payload.expiresAt}`;
  const signature = createHmac('sha256', secret).update(message).digest();
  const envelope = JSON.stringify({
    tenantId: payload.tenantId,
    basename: payload.basename,
    expiresAt: payload.expiresAt,
    sig: urlSafeB64Encode(signature),
  });
  return urlSafeB64Encode(Buffer.from(envelope, 'utf8'));
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Decodes and verifies an HMAC-signed media token.
 * Returns null on any failure — callers must not learn why verification failed.
 */
export function verifyMediaToken(token: string, secret: string): SignedMediaPayload | null {
  try {
    const envelopeStr = urlSafeB64Decode(token).toString('utf8');
    const envelope = JSON.parse(envelopeStr) as {
      tenantId?: unknown;
      basename?: unknown;
      expiresAt?: unknown;
      sig?: unknown;
    };

    const { tenantId, basename, expiresAt, sig } = envelope;
    if (
      typeof tenantId !== 'string' ||
      !tenantId ||
      typeof basename !== 'string' ||
      !basename ||
      typeof expiresAt !== 'number' ||
      typeof sig !== 'string' ||
      !sig
    ) {
      return null;
    }

    // Reject expired tokens before HMAC work (short-circuit, not timing-sensitive)
    if (expiresAt <= Date.now()) {
      return null;
    }

    const message = `${tenantId}|${basename}|${expiresAt}`;
    const expected = createHmac('sha256', secret).update(message).digest();
    let actual: Buffer;
    try {
      actual = urlSafeB64Decode(sig);
    } catch {
      return null;
    }

    if (expected.length !== actual.length) {
      return null;
    }

    if (!timingSafeEqual(expected, actual)) {
      return null;
    }

    return { tenantId, basename, expiresAt };
  } catch {
    return null;
  }
}
