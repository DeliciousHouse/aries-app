import { createHmac, timingSafeEqual } from 'node:crypto';

export const PARTNER_REF_COOKIE_NAME = 'aries_partner_ref';

const REF_CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;

export function isValidPartnerRefFormat(ref: string): boolean {
  return REF_CODE_RE.test(ref);
}

function signingSecret(): string {
  const explicit = process.env.PARTNER_REF_COOKIE_SECRET?.trim();
  if (explicit) {
    return explicit;
  }
  const nextAuth = process.env.NEXTAUTH_SECRET?.trim();
  if (!nextAuth) {
    throw new Error('NEXTAUTH_SECRET (or PARTNER_REF_COOKIE_SECRET) is required to sign partner ref cookies');
  }
  return nextAuth;
}

/** Cookie value: ref.expMs.hexHmac (ref has no dots). */
export function serializePartnerRefCookie(ref: string, secret?: string): string {
  const s = secret ?? signingSecret();
  const expMs = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const payload = `${ref}.${expMs}`;
  const sig = createHmac('sha256', s).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function parsePartnerRefCookie(cookieValue: string, secret?: string): string | null {
  try {
    const s = secret ?? signingSecret();
    const trimmed = cookieValue.trim();
    const lastDot = trimmed.lastIndexOf('.');
    if (lastDot <= 0) {
      return null;
    }
    const sig = trimmed.slice(lastDot + 1);
    const rest = trimmed.slice(0, lastDot);
    const secondDot = rest.lastIndexOf('.');
    if (secondDot <= 0) {
      return null;
    }
    const ref = rest.slice(0, secondDot);
    const expMs = Number(rest.slice(secondDot + 1));
    if (!isValidPartnerRefFormat(ref) || !Number.isFinite(expMs) || expMs < Date.now()) {
      return null;
    }
    const payload = `${ref}.${expMs}`;
    const expected = createHmac('sha256', s).update(payload).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}
