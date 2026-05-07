import { createHash, timingSafeEqual } from 'node:crypto';

import pool from '@/lib/db';

export type InternalCallbackAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export type CallbackTokenVerificationResult =
  | { ok: true }
  | { ok: false; status: 403; reason: 'missing_callback_token' | 'invalid_callback_token' };

type CallbackTokenQueryClient = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

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

export function hashCallbackToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function verifyCallbackToken(
  ariesRunId: string,
  receivedToken: string | undefined | null,
  client: CallbackTokenQueryClient = pool,
): Promise<CallbackTokenVerificationResult> {
  const candidate = typeof receivedToken === 'string' ? receivedToken.trim() : '';
  if (!candidate) {
    return { ok: false, status: 403, reason: 'missing_callback_token' };
  }

  const candidateHash = hashCallbackToken(candidate);
  const result = await client.query(
    `SELECT token_hash, aries_run_id FROM oauth_callback_tokens WHERE token_hash = $1 LIMIT 1`,
    [candidateHash],
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, status: 403, reason: 'invalid_callback_token' };
  }

  const storedHash = typeof row.token_hash === 'string' ? row.token_hash : '';
  const storedRunId = typeof row.aries_run_id === 'string' ? row.aries_run_id : '';
  if (!storedHash || !safeEqual(storedHash, candidateHash) || storedRunId !== ariesRunId) {
    return { ok: false, status: 403, reason: 'invalid_callback_token' };
  }

  return { ok: true };
}
