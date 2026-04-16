import { NextResponse } from 'next/server';
import crypto from 'node:crypto';

import pool from '@/lib/db';
import { sendPasswordResetEmail } from '@/lib/email';

type ForgotPasswordBody = {
  email?: unknown;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function successResponse() {
  return NextResponse.json({ success: true });
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: Request) {
  let body: ForgotPasswordBody = {};
  try {
    body = (await req.json()) as ForgotPasswordBody;
  } catch {
    body = {};
  }

  const email = normalizeEmail(body.email);

  // Always return success to prevent email enumeration.
  if (!email || !EMAIL_RE.test(email)) {
    return successResponse();
  }

  let client;
  try {
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email],
    );

    if ((userResult.rowCount ?? 0) === 0) {
      return successResponse();
    }

    const user = userResult.rows[0] as { id: number; password_hash: string | null };
    if (!user.password_hash || user.password_hash === 'oauth_managed') {
      return successResponse();
    }

    const rateResult = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM password_resets
        WHERE email = $1
          AND created_at > now() - interval '1 hour'`,
      [email],
    );
    const recentCount = Number(rateResult.rows[0]?.count ?? 0);
    if (recentCount >= 3) {
      return successResponse();
    }

    // crypto.randomInt(min, max) uses an EXCLUSIVE upper bound. Using 999999
    // would never actually produce 999999. Keep the inclusive 100000..999999
    // six-digit range by passing 1000000 as the exclusive max.
    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await client.query(
      `INSERT INTO password_resets (user_id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '15 minutes')`,
      [user.id, email, codeHash],
    );

    try {
      await sendPasswordResetEmail(email, code);
    } catch (err) {
      console.error('[forgot-password] email send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return successResponse();
  } catch (error) {
    console.error('[forgot-password] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Still return success to avoid leaking state to clients.
    return successResponse();
  } finally {
    client?.release();
  }
}
