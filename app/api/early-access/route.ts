import { NextResponse } from 'next/server';

import pool from '@/lib/db';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SOURCE_LENGTH = 100;
const MAX_USER_AGENT_LENGTH = 500;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

function normalizeSource(value: unknown): string {
  if (typeof value !== 'string') return 'website';
  const trimmed = value.trim().slice(0, MAX_SOURCE_LENGTH);
  return trimmed || 'website';
}

async function readBody(req: Request): Promise<{ email: unknown; source: unknown }> {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const parsed = (await req.json()) as Record<string, unknown>;
      return { email: parsed.email, source: parsed.source };
    } catch {
      return { email: null, source: null };
    }
  }

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      const form = await req.formData();
      return { email: form.get('email'), source: form.get('source') };
    } catch {
      return { email: null, source: null };
    }
  }

  return { email: null, source: null };
}

export async function POST(req: Request) {
  const { email: rawEmail, source: rawSource } = await readBody(req);
  const email = normalizeEmail(rawEmail);
  const source = normalizeSource(rawSource);
  const userAgent = (req.headers.get('user-agent') || '').slice(0, MAX_USER_AGENT_LENGTH);

  const contentType = req.headers.get('content-type') || '';
  const isFormSubmit =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  if (!email) {
    if (isFormSubmit) {
      return NextResponse.redirect(new URL('/?early-access=invalid', req.url), { status: 303 });
    }
    return NextResponse.json(
      { error: 'invalid_email', message: 'Enter a valid email to request early access.' },
      { status: 400 },
    );
  }

  let client;
  try {
    client = await pool.connect();

    await client.query(
      `INSERT INTO early_access_signups (email, source, user_agent)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET
         source = EXCLUDED.source,
         user_agent = EXCLUDED.user_agent,
         updated_at = now()`,
      [email, source, userAgent || null],
    );
  } catch (error) {
    // Log the infra error, then still return success so the public form
    // doesn't leak database state to the internet. If the table is missing
    // (migration not yet applied), the user-facing response is still graceful
    // and we'll see the error in server logs.
    console.error('[early-access] failed to persist signup', {
      error: error instanceof Error ? error.message : String(error),
      emailHash: email ? email.slice(0, 2) + '***' : null,
    });
  } finally {
    client?.release();
  }

  if (isFormSubmit) {
    return NextResponse.redirect(new URL('/?early-access=success', req.url), { status: 303 });
  }

  return NextResponse.json({
    success: true,
    message: "You're on the early access list. We'll be in touch.",
  });
}
