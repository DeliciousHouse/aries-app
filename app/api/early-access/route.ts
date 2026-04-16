import { NextResponse } from 'next/server';

type EarlyAccessBody = {
  email?: unknown;
  source?: unknown;
  name?: unknown;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export async function POST(req: Request) {
  let body: EarlyAccessBody;
  try {
    body = (await req.json()) as EarlyAccessBody;
  } catch {
    return NextResponse.json(
      { status: 'error', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const email = safeString(body.email);
  if (!email || !EMAIL_PATTERN.test(email)) {
    return NextResponse.json(
      { status: 'error', message: 'Enter a valid email to request early access.' },
      { status: 400 },
    );
  }

  const source = safeString(body.source);
  const name = safeString(body.name);

  // Forward to a configured external waitlist provider (Formspree / ConvertKit /
  // custom endpoint) when available. If no forwarder is configured, accept the
  // submission and log it on the server so the form never appears broken.
  const forwardUrl = process.env.EARLY_ACCESS_FORWARD_URL;
  if (forwardUrl) {
    try {
      const forwardResponse = await fetch(forwardUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source, name }),
      });

      if (!forwardResponse.ok) {
        console.error('[early-access] forwarder returned non-OK status', forwardResponse.status);
        return NextResponse.json(
          {
            status: 'error',
            message: 'We could not save your email right now. Please try again shortly.',
          },
          { status: 502 },
        );
      }
    } catch (error) {
      console.error('[early-access] forwarder failed', error);
      return NextResponse.json(
        {
          status: 'error',
          message: 'We could not save your email right now. Please try again shortly.',
        },
        { status: 502 },
      );
    }
  } else {
    console.info('[early-access] captured (no forwarder configured)', { email, source, name });
  }

  return NextResponse.json(
    {
      status: 'ok',
      message: "You're on the early access list. We'll be in touch soon.",
    },
    { status: 201 },
  );
}
