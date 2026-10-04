import { NextResponse } from 'next/server';

import pool from '@/lib/db';

type EarlyAccessRequestBody = {
  email?: unknown;
  source?: unknown;
};

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    return null;
  }

  return email;
}

function normalizeSource(value: unknown): string {
  if (typeof value !== 'string') {
    return 'website';
  }

  return value.trim().slice(0, 80) || 'website';
}

export async function POST(req: Request) {
  let body: EarlyAccessRequestBody = {};

  try {
    body = (await req.json()) as EarlyAccessRequestBody;
  } catch {
    body = {};
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return NextResponse.json(
      {
        status: 'error',
        reason: 'invalid_email',
        message: 'Enter a valid email address.',
      },
      { status: 400 },
    );
  }

  try {
    await pool.query(
      `
        INSERT INTO early_access_signups (email, source, user_agent)
        VALUES ($1, $2, $3)
        ON CONFLICT (email)
        DO UPDATE SET
          source = EXCLUDED.source,
          user_agent = EXCLUDED.user_agent,
          updated_at = now()
      `,
      [email, normalizeSource(body.source), req.headers.get('user-agent')],
    );

    return NextResponse.json({
      status: 'ok',
      message: "You're on the early access list.",
    });
  } catch (error) {
    console.error('Unable to capture early access signup:', error);
    return NextResponse.json(
      {
        status: 'error',
        reason: 'database_unavailable',
        message: 'We could not save your email right now. Please try again.',
      },
      { status: 503 },
    );
  }
}
