import { NextResponse } from 'next/server';
import pool from '@/lib/db';

// Public, unauthenticated registration endpoint for the Aries AI Hackathon
// landing page (`/hackathon`). Idempotent on email (case-insensitive); a
// re-submit from the same email updates the existing record rather than
// creating a duplicate. Off the navigation grid -- accessed only via the
// landing page direct URL.

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_FIELD_LEN = 1000;

interface RegistrationBody {
  name?: unknown;
  email?: unknown;
  motivation?: unknown;
}

function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, max);
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: RegistrationBody;
  try {
    body = (await request.json()) as RegistrationBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const name = clean(body.name, 200);
  const email = clean(body.email, 320);
  const motivation = clean(body.motivation, MAX_FIELD_LEN);

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = 'Name is required.';
  if (!email) fieldErrors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) fieldErrors.email = 'Enter a valid email address.';

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ error: 'invalid_input', fieldErrors }, { status: 422 });
  }

  // Best-effort client metadata for spam/abuse triage. Never relied on for
  // identity -- this endpoint is intentionally public.
  const forwardedFor = request.headers.get('x-forwarded-for') ?? '';
  const ipAddress = forwardedFor.split(',')[0]?.trim().slice(0, 100) || null;
  const userAgent = (request.headers.get('user-agent') ?? '').slice(0, 500) || null;

  try {
    await pool.query(
      `INSERT INTO hackathon_registrations (name, email, motivation, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ((lower(email))) DO UPDATE
         SET name = EXCLUDED.name,
             motivation = EXCLUDED.motivation,
             ip_address = EXCLUDED.ip_address,
             user_agent = EXCLUDED.user_agent,
             updated_at = now()`,
      [name, email, motivation || null, ipAddress, userAgent],
    );
  } catch (error) {
    console.error('[hackathon-register]', {
      cause: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'persist_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
