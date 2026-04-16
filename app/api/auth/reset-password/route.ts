import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import pool from '@/lib/db';

type ResetPasswordBody = {
  email?: unknown;
  code?: unknown;
  password?: unknown;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
// Matches the existing password policy in frontend/auth/reset-password-form.tsx:
// 8+ chars, at least one uppercase, one digit, one special character.
const PASSWORD_RE = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  let body: ResetPasswordBody = {};
  try {
    body = (await req.json()) as ResetPasswordBody;
  } catch {
    body = {};
  }

  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !EMAIL_RE.test(email)) {
    return errorResponse('Invalid or expired code');
  }
  if (!CODE_RE.test(code)) {
    return errorResponse('Invalid or expired code');
  }
  if (!PASSWORD_RE.test(password)) {
    return errorResponse(
      'Password must be at least 8 characters and include an uppercase letter, a number, and a special character.',
    );
  }

  const hashedSubmitted = crypto.createHash('sha256').update(code).digest('hex');

  let client;
  try {
    client = await pool.connect();

    // Brute-force protection: only consider rows that are unused, unexpired,
    // AND have fewer than MAX_ATTEMPTS_PER_ROW failed verification attempts.
    // On every mismatch below we increment the attempts counter, so a given
    // reset row can be guessed at most MAX_ATTEMPTS_PER_ROW times before it
    // is effectively locked. Combined with the 3-per-hour rate limit in
    // forgot-password, an attacker gets at most ~15 guesses per email per hour
    // against a 10^6 keyspace.
    const MAX_ATTEMPTS_PER_ROW = 5;

    const rows = await client.query(
      `SELECT id, user_id, code_hash, attempts
         FROM password_resets
        WHERE email = $1
          AND used_at IS NULL
          AND expires_at > now()
          AND attempts < $2
        ORDER BY created_at DESC
        LIMIT 5`,
      [email, MAX_ATTEMPTS_PER_ROW],
    );

    let match: { id: number; user_id: number } | null = null;
    const candidateIds: number[] = [];
    for (const row of rows.rows as Array<{ id: number; user_id: number; code_hash: string; attempts: number }>) {
      candidateIds.push(row.id);
      if (timingSafeHexEqual(hashedSubmitted, row.code_hash)) {
        match = { id: row.id, user_id: row.user_id };
        break;
      }
    }

    if (!match) {
      // Increment the failed-attempts counter on every candidate row we
      // checked. A row that hits MAX_ATTEMPTS_PER_ROW is excluded from
      // future candidate queries above — effectively locking it without
      // marking it used_at (so we keep the used_at column meaning "a real
      // reset consumed this row" rather than "got brute-forced away").
      if (candidateIds.length > 0) {
        await client.query(
          `UPDATE password_resets SET attempts = attempts + 1 WHERE id = ANY($1::bigint[])`,
          [candidateIds],
        );
      }
      return errorResponse('Invalid or expired code');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [passwordHash, match.user_id],
      );
      await client.query(
        `UPDATE password_resets SET used_at = now() WHERE id = $1`,
        [match.id],
      );
      await client.query(
        `UPDATE password_resets SET used_at = now() WHERE email = $1 AND used_at IS NULL`,
        [email],
      );
      await client.query('COMMIT');
    } catch (txError) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw txError;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[reset-password] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Unable to reset password right now.', 500);
  } finally {
    client?.release();
  }
}
