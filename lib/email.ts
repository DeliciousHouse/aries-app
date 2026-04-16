// lib/email.ts
//
// Outbound transactional email helpers backed by Resend (https://resend.com).
//
// Environment variables (names match Resend's official SDK conventions):
//   RESEND_API_KEY   Required in production. API key from
//                    https://resend.com/api-keys. The Resend Node SDK reads
//                    this directly as `new Resend(process.env.RESEND_API_KEY)`.
//                    When missing in production we log at ERROR level and
//                    skip the send; the caller still resolves successfully so
//                    routes don't leak "email not configured" as an oracle.
//   EMAIL_FROM       Fully-qualified "From" header, e.g.
//                    `Aries AI <noreply@sugarandleather.com>`. The
//                    domain portion MUST be verified at
//                    https://resend.com/domains before Resend will accept the
//                    send — otherwise Resend returns a 4xx that we only log.
//                    Falls back to the DEFAULT_FROM below when unset.
//                    For local/sandbox testing use `onboarding@resend.dev`
//                    (Resend's shared verified sender).

import { Resend } from 'resend';

const DEFAULT_FROM = 'Aries AI <noreply@sugarandleather.com>';

function renderHtml(code: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;color:#f5f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0f;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#15151b;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 32px;">
            <tr>
              <td style="text-align:center;">
                <div style="font-size:13px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:8px;">Aries AI</div>
                <h1 style="font-size:22px;font-weight:600;color:#ffffff;margin:0 0 16px;">Reset your password</h1>
                <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 28px;">Use the verification code below to finish resetting your Aries AI password.</p>
                <div style="display:inline-block;padding:18px 28px;background:linear-gradient(135deg,rgba(124,58,237,0.25),rgba(236,72,153,0.2));border:1px solid rgba(124,58,237,0.45);border-radius:12px;font-size:32px;font-weight:700;letter-spacing:0.4em;color:#ffffff;">${code}</div>
                <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:28px 0 0;">This code expires in 15 minutes.</p>
                <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:16px 0 0;">If you didn't request this, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderText(code: string): string {
  return [
    'Aries AI password reset',
    '',
    `Your verification code: ${code}`,
    '',
    'This code expires in 15 minutes.',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

type TestHook = (email: string, code: string) => void | Promise<void>;

function readTestHook(): TestHook | null {
  const hook = (globalThis as Record<string, unknown>).__ARIES_EMAIL_TEST_HOOK__;
  return typeof hook === 'function' ? (hook as TestHook) : null;
}

export async function sendPasswordResetEmail(email: string, code: string): Promise<void> {
  const testHook = readTestHook();
  if (testHook) {
    await testHook(email, code);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;

  if (!apiKey) {
    // In production an unset RESEND_API_KEY silently breaks password reset,
    // so log at ERROR (not WARN) to make deployment misconfig obvious in logs
    // and alerting. In dev/test we still surface it but don't throw, so the
    // routes keep their no-enumeration 200 contract.
    const level = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
    console[level](
      '[email] RESEND_API_KEY is not set — password reset email WILL NOT be delivered. ' +
        'Set RESEND_API_KEY in the production environment (see https://resend.com/api-keys) ' +
        'and verify EMAIL_FROM domain at https://resend.com/domains.',
      { to: email },
    );
    return;
  }

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: email,
      subject: 'Reset your Aries AI password',
      html: renderHtml(code),
      text: renderText(code),
    });

    if ((result as { error?: unknown } | null)?.error) {
      // Typical causes: unverified EMAIL_FROM domain, invalid API key,
      // Resend rate limit (5 req/sec default). The error surfaces in
      // `result.error` rather than throwing.
      console.error('[email] Resend returned an error for password reset email.', {
        to: email,
        from,
        error: (result as { error: unknown }).error,
      });
    }
  } catch (error) {
    console.error('[email] Failed to send password reset email.', {
      to: email,
      from,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
