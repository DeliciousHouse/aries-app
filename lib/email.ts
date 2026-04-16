// lib/email.ts
//
// Outbound transactional email helpers.
//
// Environment variables:
//   RESEND_API_KEY   API key for the Resend SDK. If missing, emails are
//                    logged and the promise resolves without throwing — this
//                    keeps dev environments usable without a real key and
//                    avoids leaking a "not configured" oracle back to callers.
//   EMAIL_FROM       Fully-qualified "From" header, e.g.
//                    `Aries AI <noreply@aries.sugarandleather.com>`. Falls
//                    back to that default value when unset.

import { Resend } from 'resend';

const DEFAULT_FROM = 'Aries AI <noreply@aries.sugarandleather.com>';

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

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;

  if (!apiKey) {
    console.warn(
      '[email] RESEND_API_KEY not set; skipping send for password reset email.',
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
      console.error('[email] Resend returned an error for password reset email.', {
        to: email,
        error: (result as { error: unknown }).error,
      });
    }
  } catch (error) {
    console.error('[email] Failed to send password reset email.', {
      to: email,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
