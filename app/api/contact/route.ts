import { NextResponse } from 'next/server';

type ContactRequestBody = {
  name?: unknown;
  email?: unknown;
  message?: unknown;
};

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

export async function POST(req: Request) {
  let body: ContactRequestBody = {};

  try {
    body = (await req.json()) as ContactRequestBody;
  } catch {
    body = {};
  }

  return NextResponse.json(
    {
      status: 'error',
      reason: 'contact_not_configured',
      message: 'The contact form is not available right now. Please try again later.',
      request: {
        name: safeString(body.name),
        email: safeString(body.email),
        message_present: Boolean(safeString(body.message)),
      },
    },
    { status: 501 },
  );
}
