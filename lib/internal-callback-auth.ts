import { timingSafeEqual } from 'node:crypto';

export type InternalCallbackAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; reason: string };

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyInternalCallbackRequest(
  req: Request,
  env: Partial<Record<string, string | undefined>> = process.env,
): InternalCallbackAuthResult {
  const expected = typeof env.INTERNAL_API_SECRET === 'string' ? env.INTERNAL_API_SECRET.trim() : '';
  if (!expected) {
    return { ok: false, status: 503, reason: 'internal_api_secret_not_configured' };
  }

  const authorization = req.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, status: 401, reason: 'missing_internal_callback_secret' };
  }

  return safeEqual(match[1].trim(), expected)
    ? { ok: true }
    : { ok: false, status: 403, reason: 'invalid_internal_callback_secret' };
}
