import { NextResponse } from 'next/server';

type ResetPasswordBody = {
  email?: unknown;
  otpCode?: unknown;
  password?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Accept any password at least 8 characters with at least one letter and one
// number. Previous regex required a character from a narrow special-char class,
// which rejected valid passwords like `GoodPass22` outright.
const PASSWORD_POLICY = {
  minLength: 8,
  hasLetter: (value: string) => /[A-Za-z]/.test(value),
  hasDigit: (value: string) => /\d/.test(value),
};

function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_POLICY.minLength) {
    return `Password must be at least ${PASSWORD_POLICY.minLength} characters.`;
  }
  if (!PASSWORD_POLICY.hasLetter(password)) {
    return 'Password must include at least one letter.';
  }
  if (!PASSWORD_POLICY.hasDigit(password)) {
    return 'Password must include at least one number.';
  }
  return null;
}

export async function POST(req: Request) {
  let payload: ResetPasswordBody;
  try {
    payload = (await req.json()) as ResetPasswordBody;
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json(
      { error: 'invalid_payload', message: 'Request body must be a JSON object.' },
      { status: 400 },
    );
  }

  const { email, otpCode, password } = payload;

  if (!isNonEmptyString(email)) {
    return NextResponse.json(
      { error: 'invalid_email', message: 'A valid email is required.' },
      { status: 400 },
    );
  }

  if (!isNonEmptyString(otpCode)) {
    return NextResponse.json(
      { error: 'invalid_otp_code', message: 'A recovery code is required.' },
      { status: 400 },
    );
  }

  if (!isNonEmptyString(password)) {
    return NextResponse.json(
      { error: 'invalid_password', message: 'A password is required.' },
      { status: 400 },
    );
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json(
      { error: 'weak_password', message: passwordError },
      { status: 400 },
    );
  }

  // Reset-password transport is not wired up in this runtime yet. Return a
  // predictable 501 so the client can render a graceful message instead of a
  // generic 500. When the backend is ready, replace this with the actual
  // password update + OTP consumption calls.
  return NextResponse.json(
    {
      status: 'error',
      reason: 'reset_password_not_configured',
      message: 'Password reset is not wired up in this Aries runtime yet.',
    },
    { status: 501 },
  );
}
